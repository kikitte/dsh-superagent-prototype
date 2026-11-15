import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp, sameOrigin } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { DirectorySettingsError } from '../src/app/directory-settings.ts'
import { DirectoryRecoveryConflict } from '../src/executor/directories.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('refreshes operator directory diagnostics read-only without manufacturing unknown safety as clear', async () => {
  const diagnostics = [{ directory: { id: 'ui-1', poolId: 'ui', path: '/srv/ui-1', lastLeaseSequence: 0, createdAt: '' },
    occupancy: { state: 'unknown', revision: 'unsupported', detail: 'Authoritative admission is unavailable' } }]
  let reads = 0, wakes = 0, passes = 0
  const call = serve({ executor: { directories: { diagnostics: async () => { reads++; return diagnostics } }, wake: () => { wakes++ } }, requestPass: () => { passes++ } })
  expect(await call('GET', 'directories')).toEqual({ status: 200, body: diagnostics })
  expect(reads).toBe(1)
  expect([wakes, passes]).toEqual([0, 0])
  expect(await call('POST', 'directories')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(reads).toBe(1)
  expect(await call('POST', 'directories/refresh')).toEqual({ status: 200, body: diagnostics })
  expect([reads, wakes, passes]).toEqual([2, 1, 1])
})

it('rechecks the reviewed lease through trusted recovery and wakes only the Executor after clearance', async () => {
  const checked: unknown[] = [], wakes: number[] = []
  let cleared = false, conflict = false, passes = 0
  const call = serve({ executor: { directories: { recheckRecovery: async (...args: unknown[]) => {
    checked.push(args)
    if (conflict) throw new DirectoryRecoveryConflict()
    return { cleared, detail: cleared ? 'Verified' : 'No proof; quarantine retained' }
  } }, wake: () => { wakes.push(1) } }, requestPass: () => { passes++ } })
  const path = 'directory-leases/lease-1/recheck-recovery'
  expect(await call('POST', path, { executionEpoch: 'epoch-1' })).toEqual({ status: 200, body: { cleared: false, detail: 'No proof; quarantine retained' } })
  expect(checked).toEqual([['lease-1', 'epoch-1']]); expect(wakes).toHaveLength(0)
  for (const body of [{}, { executionEpoch: '' }, { executionEpoch: 'epoch-1', evidence: 'Operator says safe' }, { executionEpoch: 'epoch-1', force: true }]) {
    expect((await call('POST', path, body)).status).toBe(400)
  }
  expect(checked).toHaveLength(1)
  cleared = true
  expect((await call('POST', path, { executionEpoch: 'epoch-1' })).body).toEqual({ cleared: true, detail: 'Verified' })
  expect(wakes).toHaveLength(1); expect(passes).toBe(0)
  conflict = true
  expect((await call('POST', path, { executionEpoch: 'epoch-1' })).status).toBe(409)
  expect(wakes).toHaveLength(1)
  expect((await call('POST', path, { executionEpoch: 'epoch-1' }, { origin: 'https://unrelated.test' })).status).toBe(403)
  expect(checked).toHaveLength(3)
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      if (args[1] === 'directory') throw new DirectorySettingsError('Pool ui still has unreleased leases')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  expect(await call('PUT', 'settings/executor', { value: 'directory', revision: 0 })).toEqual({ status: 400, body: { error: 'Pool ui still has unreleased leases' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(5)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Socket-based or not-yet-listening servers have no TCP port: fail closed.
  expect(sameOrigin({ headers: { host: '127.0.0.1:undefined', 'x-orchestrator-request': '1' } }, undefined)).toBe(false)
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
