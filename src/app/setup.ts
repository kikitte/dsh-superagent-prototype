/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { githubEnvironment } from '../infra/github-environment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify([settings.integrations.github, Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? ''))])
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  private accountGeneration?: string
  private gitAuthor?: Settings['executor']['gitAuthor']
  problem?: SetupProblem
  githubProblem?: SetupProblem
  githubStatus: 'off' | 'checking' | 'ready' | 'error' = 'off'
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  current(settings: Settings): boolean { return this.accountGeneration === setupFields(settings) }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.accountGeneration = setupFields(settings)
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.githubProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    if (block === 'source:feishu') await resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
    if (block === 'integration:github' && settings.integrations.github.enabled)
      await resolveDeployment(machine, settings.integrations.github, this.probe())
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked, this.gitAuthor)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    this.problem = this.githubProblem = this.feishuProblem = undefined
    this.githubStatus = settings.integrations.github.enabled ? 'checking' : 'off'
    const [github, feishu] = await Promise.all([
      settings.integrations.github.enabled ? resolveDeployment(machine, settings.integrations.github, probe).then(value => {
        this.githubStatus = 'ready'
        return value.github
      }).catch((error: unknown) => {
        this.githubStatus = 'error'
        this.githubProblem = error instanceof SetupError ? error.problem : new SetupError('agentCliSignedOut', { output: String(error) }).problem
        return undefined
      }) : undefined,
      resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
        this.feishuProblem = error instanceof SetupError ? error.problem : new SetupError('feishuCliFailed', { output: String(error) }).problem
        return undefined
      }),
    ])
    lifetime.throwIfAborted()
    const resolved: Deployment = { ...machine, ...(github ? { github } : {}), ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    if (github) Object.assign(this.variables, githubEnvironment.values({ deployment: resolved, config: {} }))
    this.gitAuthor = settings.executor.gitAuthor
    await writeEnvironment(resolved, settings.executor.blockedCommands, settings.executor.gitAuthor).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    try { await verifyEnvironment(resolved, context.subprocess, lifetime) }
    catch (error) {
      this.restore()
      lifetime.throwIfAborted()
      // Credential routing is an optional GitHub requirement. Rewrite neutral files before exposing the core.
      this.githubStatus = 'error'
      this.githubProblem = new SetupError('githubGitFailed', { output: error instanceof Error ? error.message : String(error) }).problem
      delete resolved.github
      Object.assign(this.variables, agentVariables(machine.stateDir))
      await writeEnvironment(resolved, settings.executor.blockedCommands, settings.executor.gitAuthor).catch(machineProblem)
      this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    }
    return resolved
  }
}
