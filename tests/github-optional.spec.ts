/** Contract checks use the in-memory DSH fixture; no live model or remote delivery is implied. */
import { RegistryService } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Commands } from '../src/infra/commands.ts'
import { agentVariables, verifyDirectory, verifyEnvironment, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { GitHubIntegrationSchema, IntegrationUnavailable } from '../src/deployment.ts'
import { githubOptionalSettings } from '../src/app/migration.ts'
import { SettingsSchema } from '../src/policy.ts'
import { readLocalContext } from '../src/app/local-context.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined; vi.unstubAllEnvs() })

it('starts core/main Session and delivers a plain-file result with GitHub absent and no git/gh verification', async () => {
  h = await startRuntime()
  expect(h.runtime.setup.deployment.github).toBeUndefined()
  expect(h.runtime.configured()).toBe(true)
  expect((await h.api('GET', 'state')).body).toMatchObject({ setup: { coreReady: true, mainSessionAvailable: true, github: { status: 'off' } } })
  expect(h.runtime.prompts.skills(h.runtime.prompts.current().config).map(([name]) => name)).not.toContain('github')
  h.subprocess.spawn.mockClear()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot correct the text'))
  writeFileSync(join(ticket.execution!.directory!, 'result.txt'), 'Corrected text\n')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Corrected result.txt; checked the text.' })
  const delivery = await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'Corrected result.txt; ready to use.' })
  expect(delivery.status).toBe('sent')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  expect(h.subprocess.spawn.mock.calls.flatMap(([spec]) => spec.argv).some(arg => arg === 'git' || arg === 'gh')).toBe(false)
  expect(h.runtime.health.runtime?.state).toBe('ready')
})

it('rejects a PR report atomically before any GitHub subprocess or report mutation', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('2', '@bot fix text'))
  const before = h.runtime.store.tickets.get(ticket.id)
  const calls = vi.spyOn(Commands.prototype, 'api')
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR', pr_number: 3 })).rejects.toBeInstanceOf(IntegrationUnavailable)
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
  expect(calls).not.toHaveBeenCalled()
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'github/pull/3' })).rejects.toMatchObject({ code: 'integrationUnavailable' })
})

it('keeps local admission reads contained, bounded and paginated by the existing assessor', async () => {
  h = await startRuntime()
  const root = join(h.directory, 'context')
  mkdirSync(root)
  writeFileSync(join(root, 'file.txt'), 'a'.repeat(5000))
  symlinkSync(h.directory, join(root, 'escape'))
  const signal = new AbortController().signal
  expect(await readLocalContext(root, 'file.txt', 'file', signal)).toHaveLength(5000)
  await expect(readLocalContext(root, '../outside', 'file', signal)).rejects.toThrow('inside')
  await expect(readLocalContext(root, 'escape/orchestrator.sqlite', 'file', signal)).rejects.toThrow('escapes')
  writeFileSync(join(root, 'large'), Buffer.alloc((1 << 20) + 1))
  await expect(readLocalContext(root, 'large', 'file', signal)).rejects.toThrow('at most')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, contextDirectory: root } })
  const request = feishu('3', 'fix file', { mentions: [] })
  h.runtime.receive(request); await h.runtime.idle()
  const context = await h.runtime.assessor.context(request.id)
  expect(context.repository_context).toEqual({ kind: 'local', directory: root })
  const read = (offset: number) => h!.runtime.assessor.read({} as never, { trigger_id: request.id, resource: 'file', path: 'file.txt', offset }, signal)
  expect(await read(0)).toMatchObject({ next_offset: 4000 })
  expect(await read(4000)).toMatchObject({ next_offset: null })
})

it('publishes integration identity with intake off and no installed adapter, and clears stale variables off', async () => {
  h = await startRuntime(undefined, { github: true, sources: false })
  const deployment = h.runtime.deployment
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: false, config: {} } } })
  const values = environmentOf({ deployment, settings: h.runtime.store.settings(), sources: h.runtime.sources })
  expect(values.find(variable => variable.key === 'DSH_SUPERAGENT_GITHUB_ACCOUNT')?.value).toBe('agent-bot')
  expect(values.find(variable => variable.key === 'DSH_SUPERAGENT_GITHUB_MONITORING')?.value).toBe('off')
  expect(agentVariables(h.directory)).toHaveProperty('DSH_SUPERAGENT_GITHUB_ACCOUNT', undefined)
  const off = environmentOf({ deployment: { ...deployment, github: undefined }, settings, sources: h.runtime.sources })
  expect(off.filter(variable => variable.key.startsWith('DSH_SUPERAGENT_GITHUB_')).every(variable => variable.value === '' || variable.value === 'off')).toBe(true)
})

it('removes a previous helper while retaining both GitHub HTTPS rewrites and local Git identity', async () => {
  h = await startRuntime(undefined, { github: true })
  const deployment = h.runtime.deployment
  expect(readFileSync(workerGitConfig(h.directory), 'utf8')).toContain('auth git-credential')
  await writeEnvironment({ ...deployment, github: undefined }, [], { name: 'Local Author', email: 'local@example.com' })
  const config = readFileSync(workerGitConfig(h.directory), 'utf8')
  expect(config).not.toContain('auth git-credential')
  expect(config).toContain('insteadOf = git@github.com:')
  expect(config).toContain('insteadOf = ssh://git@github.com/')
  expect(config).toContain('name = "Local Author"')
  await verifyEnvironment({ ...deployment, github: undefined }, { spawn: () => { throw new Error('must not invoke Git') } } as never, new AbortController().signal)
  const plain = join(h.directory, 'plain'); mkdirSync(plain)
  const noGit = { spawn: () => { throw new Error('must not invoke Git') } } as never
  vi.stubEnv('PATH', '')
  await verifyDirectory(plain, noGit, new AbortController().signal)
  mkdirSync(join(plain, '.git'))
  await expect(verifyDirectory(plain, noGit, new AbortController().signal)).rejects.toThrow('Git status unavailable')
})

it('migrates complete credentials regardless of intake, preserves partial drafts and prefers explicit integration fields', () => {
  expect(SettingsSchema.parse({}).integrations.github).toEqual({ enabled: false, repository: '', cli: '' })
  const old = { sources: { github: { enabled: false, config: { repository: 'acme/widgets', cli: '/agent', pollSeconds: 120 } } } }
  const migrated = SettingsSchema.parse(githubOptionalSettings(old))
  expect(migrated.integrations.github.enabled).toBe(true)
  expect(migrated.sources.github).toEqual({ enabled: false, config: { pollSeconds: 120 } })
  expect(githubOptionalSettings(migrated)).toEqual(migrated)
  const partial = SettingsSchema.parse(githubOptionalSettings({ sources: { github: { enabled: true, config: { cli: '/agent' } } } }))
  expect(partial.integrations.github).toEqual({ enabled: false, repository: '', cli: '/agent' })
  expect(SettingsSchema.parse(githubOptionalSettings({ ...old, integrations: { github: { enabled: false, cli: 'saved', repository: '' } } })).integrations.github.cli).toBe('saved')
  expect(() => GitHubIntegrationSchema.parse({ enabled: true, cli: '/agent' })).toThrow('requires repository')
})

it('allows disabling a broken CLI without probes and restricts integration and local context edits to the panel', async () => {
  h = await startRuntime()
  const settings = h.runtime.settings
  const value = { enabled: false, repository: 'acme/widgets', cli: '/does-not-exist' }
  await expect(settings.save('integration:github', value, 0, 'tool')).rejects.toThrow('management panel')
  const check = vi.spyOn(h.runtime.setup, 'checkAccounts')
  await settings.save('integration:github', value, 0, 'panel')
  expect(h.runtime.store.settings().integrations.github).toEqual(value)
  expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.includes('/does-not-exist'))).toBe(false)
  await expect(settings.save('executor', { ...h.runtime.store.settings().executor, contextDirectory: h.directory }, 0, 'tool')).rejects.toThrow('management panel')
  expect(check).toHaveBeenCalled()
})

it('starts idle with no installed Sources and exposes management and the main Session', async () => {
  h = await startRuntime(undefined, { sources: false })
  expect(h.runtime.sources.instances()).toEqual([])
  expect(h.runtime.deployment.github).toBeUndefined()
  expect(h.runtime.deployment.feishu).toBeUndefined()
  expect((await h.api('GET', 'state')).body).toMatchObject({ setup: { coreReady: true, mainSessionAvailable: true, github: { status: 'off', adapter: false } } })
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
  expect((await h.api('GET', 'settings')).status).toBe(200)
})

it('keeps release quarantined without a production process-owner provider while core remains ready', async () => {
  h = await startRuntime(undefined, { processOwner: false })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('missing-owner', '@bot fix text'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'File task finished' })
  await h.runtime.idle()
  await vi.waitFor(() => expect(h!.runtime.store.directories.leaseForTicket(ticket.id)?.recovery).toBe('quarantined'))
  expect(h.runtime.configured()).toBe(true)
  expect(h.runtime.health.runtime?.state).toBe('ready')
})

it('refuses repository changes with ended PR history while allowing disable/re-enable of the same repository', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('retained', '@bot fix text'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done locally' })
  const ended = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...ended, follows: [{ thread: 'github:7', own: true }] })
  const old = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...old, integrations: { github: { enabled: false, repository: 'acme/widgets', cli: '/missing' } } })
  await expect(h.runtime.settings.save('integration:github', { enabled: false, repository: 'different/project', cli: '/missing' }, 0, 'panel'))
    .rejects.toMatchObject({ code: 'githubRepositoryRetained', values: { state: expect.stringContaining('ended Tickets') } })
  expect(await h.runtime.settings.save('integration:github', { enabled: false, repository: 'acme/widgets', cli: '/missing' }, 0, 'panel')).toMatchObject({ saved: true })
})

it('fences a delayed PR result after shutdown before any report or binding can be published', async () => {
  h = await startRuntime(undefined, { github: true })
  const { sessionId } = await h.acceptedTicket(feishu('late-pr', '@bot fix text'))
  const response = Promise.withResolvers<never>()
  vi.spyOn(Commands.prototype, 'api').mockImplementationOnce(() => response.promise)
  const reported = vi.spyOn(h.runtime.engine, 'report')
  const pending = h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'late PR', pr_number: 7 })
  const stoppedSource = h.runtime.context({ kind: 'github', health: ['github'] })
  await h.runtime.stop()
  response.resolve({ state: 'open' } as never)
  await expect(pending).rejects.toBeDefined()
  expect(reported).not.toHaveBeenCalled()
  expect(() => stoppedSource.tickets.bindThread('ticket', { source: 'github', id: '7' }, true)).toThrow()
})


it('shuts down successfully when the real host returns synchronous scope disposers', async () => {
  const inject = RegistryService.prototype.inject
  vi.spyOn(RegistryService.prototype, 'inject').mockImplementation(function (this: RegistryService, ...args: unknown[]) {
    const scope = Reflect.apply(inject, this, args)
    const dispose = scope.dispose.bind(scope)
    scope.dispose = () => { void dispose() }
    return scope
  } as typeof inject)
  h = await startRuntime()
  await h.acceptedTicket(feishu('sync-disposer', '@bot fix text'))
  await expect(h.runtime.stop()).resolves.toBeUndefined()
})

it('fences old account results immediately after a disable save, before the deferred restart', async () => {
  h = await startRuntime(undefined, { github: true })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('disable-race', '@bot fix text'))
  const before = h.runtime.store.tickets.get(ticket.id)
  const response = Promise.withResolvers<never>()
  vi.spyOn(Commands.prototype, 'api').mockImplementationOnce(() => response.promise)
  const pending = h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'old account result', pr_number: 7 })
  const integration = h.runtime.store.settings().integrations.github
  await h.runtime.settings.save('integration:github', { ...integration, enabled: false }, 0, 'panel')
  expect(() => h!.runtime.commands.repository).toThrow(IntegrationUnavailable)
  response.resolve({ state: 'open' } as never)
  await expect(pending).rejects.toThrow('controlled restart')
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
})
