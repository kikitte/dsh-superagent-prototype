/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { githubEnvironment } from '../infra/github-environment.ts'
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_CONTEXT_DIRECTORY', description: { zh: '只读评估上下文基线；为空则使用可用的 GitHub 上下文', en: 'Read-only admission baseline; when empty use ready GitHub context, otherwise context is unavailable' } },
  { key: 'DSH_SUPERAGENT_GIT_AUTHOR_NAME', description: { zh: '明确配置的本地提交作者', en: 'Explicit local commit author name; empty means no local author is configured' } },
  { key: 'DSH_SUPERAGENT_GIT_AUTHOR_EMAIL', description: { zh: '明确配置的本地提交邮箱', en: 'Explicit local commit author email' } },
  { key: 'DSH_SUPERAGENT_GITHUB_MONITORING', description: { zh: '仅当访问就绪且 GitHub 来源启用时自动跟踪 PR', en: 'Automatic PR tracking requires ready access and an installed enabled GitHub Source; off means monitoring is paused' } },
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名（分支标识符），不一定等于目录名', en: 'The ticket\'s short name (branch identifier), not necessarily its directory basename' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    { owner: 'github', enabled: settings?.integrations.github.enabled ?? false, variables: githubEnvironment.variables },
    ...sources.declarations().filter(item => item.kind !== 'github').map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_CONTEXT_DIRECTORY: settings.executor.contextDirectory, DSH_SUPERAGENT_GIT_AUTHOR_NAME: settings.executor.gitAuthor?.name ?? '', DSH_SUPERAGENT_GIT_AUTHOR_EMAIL: settings.executor.gitAuthor?.email ?? '', DSH_SUPERAGENT_GITHUB_MONITORING: deployment.github && sources.instance('github', settings)?.enabled ? 'on' : 'off', DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  // Empty values explicitly replace inherited/stale Ticket variables; unavailable access never leaks a previous identity.
  const github = deployment.github ? githubEnvironment.values({ deployment, config: {}, ...trigger ? { trigger } : {} }) : {}
  for (const spec of githubEnvironment.variables) result.push({ key: spec.key, value: github[spec.key] ?? '', description: spec.description, owner: 'github' })
  for (const { kind, environment, config } of sources.environments(settings).filter(item => item.kind.kind !== 'github')) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
