/** SQLite ownership constraints, reservation rollback and epoch-safe release history. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DirectoryManager } from '../src/executor/directories.ts'
import { Later } from '../src/app/effects.ts'
import { inspectGit } from '../src/executor/git.ts'
import type { DirectorySafety } from '../src/executor/directory-safety.ts'
import type { Ticket } from '../src/core/index.ts'
import type { DirectoryRecord } from '../src/app/directory-store.ts'

let root: string, store: Store
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-directory-store-')); store = new Store(join(root, 'state.sqlite')) })
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
const ticket = (id: string): Ticket => ({ id, title: id, decisionId: id,
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: 'request' },
  placement: { poolId: 'default', reason: 'Test', contextVersion: 'v1' }, execution: { name: `fix-${id}`, assignment: 'Do work' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: id, triggerIds: [id] } })
const record = (id: string): DirectoryRecord => ({ id, poolId: 'default', path: join(root, id), createdAt: '', lastLeaseSequence: 0 })
function manager() { return new DirectoryManager({ store, stateDir: root, signal: new AbortController().signal,
  runHook: async () => {}, verify: async () => {} }) }
function repo(path: string) {
  mkdirSync(path, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(path, 'tracked'), 'base'); git('add', '.'); git('commit', '-qm', 'base')
}

it('rolls back directory, lease, claim, affinity and acquisition sequence together when ticket persistence fails', () => {
  store.tickets.save(ticket('one'))
  store.db.exec("CREATE TRIGGER reject_affinity BEFORE UPDATE ON ticket BEGIN SELECT RAISE(ABORT,'injected affinity write failure'); END")
  expect(() => store.directories.reserve('one', record('a'), 'epoch', { root: join(root, 'a'), state: 'reserved' })).toThrow('injected affinity')
  expect(store.directories.records()).toEqual([])
  expect(store.directories.leases()).toEqual([])
  expect(store.directories.claims()).toEqual([])
  expect(store.tickets.get('one')!.directoryAffinity).toBeUndefined()
  expect(store.db.prepare('SELECT value FROM directory_sequence WHERE id=1').get()?.value).toBe(0)
  store.db.exec('DROP TRIGGER reject_affinity')
  const lease = store.directories.reserve('one', record('a'), 'epoch', { root: join(root, 'a'), state: 'reserved' })!
  expect(lease.directoryId).toBe('a')
  expect(store.directories.records()[0]!.lastLeaseSequence).toBe(1)
})

it('enforces unique unreleased directory, Ticket, root and worktree-specific metadata identities in SQLite', () => {
  for (const id of ['one', 'two']) store.tickets.save(ticket(id))
  const first = store.directories.reserve('one', record('a'), 'epoch', { root: join(root, 'resource'), gitDirectory: join(root, 'metadata'), state: 'verified' })!
  expect(() => store.directories.saveLease({ ...first, id: 'second-directory-owner', ticketId: 'two' })).toThrow('UNIQUE')
  expect(() => store.directories.saveLease({ ...first, id: 'second-ticket-owner', directoryId: 'b', path: join(root, 'b') })).toThrow('UNIQUE')
  const second = store.directories.reserve('two', record('b'), 'epoch')!
  expect(() => store.directories.saveClaim({ leaseId: second.id, root: join(root, 'resource'), state: 'reserved' })).toThrow('UNIQUE')
  expect(() => store.directories.saveClaim({ leaseId: second.id, root: join(root, 'other-resource'), gitDirectory: join(root, 'metadata'), state: 'verified' })).toThrow('UNIQUE')
  expect(store.directories.claims()).toHaveLength(1)
})

it('keeps affinity and LRU unchanged on resource conflict and duplicate reservation', () => {
  for (const id of ['one', 'two']) store.tickets.save(ticket(id))
  const claim = { root: join(root, 'resource'), state: 'reserved' as const }
  const first = store.directories.reserve('one', record('a'), 'epoch', claim)!
  expect(store.directories.reserve('two', record('b'), 'epoch', claim)).toBeUndefined()
  expect(store.tickets.get('two')!.directoryAffinity).toBeUndefined()
  expect(store.directories.records()).toHaveLength(1)
  expect(store.directories.reserve('one', record('a'), 'epoch', claim)?.id).toBe(first.id)
  expect(store.directories.records()[0]!.lastLeaseSequence).toBe(1)
})

it('atomically releases root ownership with lease history and ignores stale duplicate release after reacquisition', () => {
  store.tickets.save(ticket('one'))
  const first = store.directories.reserve('one', record('a'), 'epoch-1', { root: join(root, 'resource'), state: 'reserved' })!
  store.directories.update(first.id, 'epoch-1', lease => ({ ...lease, state: 'releasing' }))
  store.directories.release(first.id, 'epoch-1', 'Verified empty owner range')
  expect(store.directories.claims()[0]!.releasedAt).toBe(store.directories.leases()[0]!.releasedAt)
  const next = store.directories.reserve('one', store.directories.records()[0]!, 'epoch-2', { root: join(root, 'resource'), state: 'reserved' })!
  store.directories.release(first.id, 'epoch-1', 'Duplicate old completion')
  expect(store.directories.leaseForTicket('one')?.id).toBe(next.id)
  expect(store.directories.claims().find(claim => claim.leaseId === next.id)?.releasedAt).toBeUndefined()
  expect(store.tickets.get('one')!.directoryAffinity?.directoryId).toBe('a')
  expect(store.directories.records()[0]!.lastLeaseSequence).toBe(2)
  expect(() => store.directories.update(first.id, 'epoch-1', lease => ({ ...lease, state: 'active' }))).toThrow('released')
})

it('preserves queue order on assignment replacement and durable ownership across reopening', () => {
  for (const id of ['one', 'two']) store.tickets.save(ticket(id))
  store.directories.enqueue('one', 'assignment-one'); store.directories.enqueue('two', 'assignment-two'); store.directories.enqueue('one', 'replacement')
  const queue = store.directories.queue()
  expect(queue.map(item => [item.ticketId, item.assignmentId])).toEqual([['one', 'replacement'], ['two', 'assignment-two']])
  const lease = store.directories.reserve('one', record('a'), 'old-epoch', { root: join(root, 'resource'), state: 'reserved' })!
  store.close(); store = new Store(join(root, 'state.sqlite'))
  expect(store.directories.queue()).toEqual(queue)
  store.directories.fencePriorEpoch('new-epoch')
  expect(store.directories.leaseForTicket('one')).toMatchObject({ id: lease.id, recovery: 'quarantined', state: 'reserved' })
  expect(store.directories.claims()[0]!.releasedAt).toBeUndefined()
  expect(() => store.directories.update(lease.id, 'old-epoch', current => ({ ...current, state: 'active' }))).toThrow('recovery-fenced')
})

it('allows independent default checkout siblings while an earlier Git worktree claim stays held', async () => {
  const allocator = manager()
  store.tickets.save(ticket('one')); store.tickets.save(ticket('two'))
  const first = await allocator.reserve(ticket('one'))
  repo(first.directoryAffinity!.path)
  // Model a successfully prepared independent checkout at the committed root.
  const lease = store.directories.leaseForTicket('one')!
  const gitDirectory = join(first.directoryAffinity!.path, '.git')
  store.directories.saveClaim({ leaseId: lease.id, root: lease.path, gitDirectory, state: 'verified' })
  store.directories.update(lease.id, allocator.epoch, current => ({ ...current, state: 'active', preparation: { state: 'complete' } }))
  const second = await allocator.reserve(ticket('two'))
  expect(second.directoryAffinity!.path).not.toBe(first.directoryAffinity!.path)
  expect(store.directories.leases()).toHaveLength(2)
})

it('refuses loss of a verified Git identity without dropping the unreleased working-tree claim', async () => {
  const allocator = manager(); store.tickets.save(ticket('one'))
  const allocated = await allocator.reserve(ticket('one')); repo(allocated.directoryAffinity!.path)
  const lease = store.directories.leaseForTicket('one')!
  store.directories.saveClaim({ leaseId: lease.id, root: lease.path, gitDirectory: join(lease.path, '.git'), state: 'verified' })
  store.directories.update(lease.id, allocator.epoch, current => ({ ...current, state: 'active', preparation: { state: 'complete' } }))
  renameSync(join(lease.path, '.git'), join(lease.path, 'retained-git-metadata'))
  expect(() => allocator.assertExecution('one')).toThrow(/identity|working.tree|Git/i)
  expect(store.directories.claims().find(claim => claim.leaseId === lease.id)).toMatchObject({ leaseId: lease.id, state: 'verified' })
})

it('keeps resumption queued while the Ticket original lease is still releasing', async () => {
  const allocator = manager(); store.tickets.save(ticket('one'))
  const allocated = await allocator.reserve(ticket('one')); await allocator.prepare(allocated)
  allocator.beginRelease('one')
  await expect(allocator.reserve(allocated)).rejects.toBeInstanceOf(Later)
  expect(store.directories.leaseForTicket('one')?.state).toBe('releasing')
})

it.each(['partial-failure', 'uncertain-quiescence'] as const)('never replays recycling after %s, including after verified process recovery', async failure => {
  const path = join(root, 'fixed'); repo(path)
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, directoryPools: [{ id: 'fixed', description: 'Fixed',
    directories: [{ id: 'fixed-directory', path }], prepare: '', recycle: 'configured-recycle' }] } })
  let afterHook = false, recovery = false
  const safety: DirectorySafety = {
    admission: { observe: () => ({ state: 'clear', revision: 'verified-baseline', detail: 'Test authoritative baseline' }),
      commit: (_observation, _path, _git, _ticket, operation) => operation(), assertUse: () => {}, subscribe: () => () => {} },
    processes: { contain: vi.fn(async () => 'durable-owner-range'), proveQuiescent: vi.fn(async () => {
      if (failure === 'uncertain-quiescence' && afterHook && !recovery) return undefined
      return 'Supervisor verified complete managed execution range empty'
    }) },
  }
  const runHook = vi.fn(async () => {
    const lease = store.directories.leaseForTicket('one')!
    expect(lease).toMatchObject({ state: 'releasing', processOwner: 'durable-owner-range', managedActivity: true,
      recycling: { state: 'started', startedAt: expect.any(String) } })
    writeFileSync(join(path, 'tracked'), 'Partial recycling output must be preserved')
    afterHook = true
    if (failure === 'partial-failure') throw new Error('Recycling failed after an external effect')
  })
  const create = () => new DirectoryManager({ store, stateDir: root, signal: new AbortController().signal,
    safety, runHook, verify: async () => {} })
  const allocator = create(), value = ticket('one'); value.placement.poolId = 'fixed'; store.tickets.save(value)
  const allocated = await allocator.reserve(value); await allocator.prepare(allocated); allocator.markExecuting(value.id)
  allocator.beginRelease(value.id)
  await expect(allocator.release(value.id)).rejects.toThrow(failure === 'partial-failure' ? 'external effect' : 'not been proven empty')
  const lease = store.directories.leaseForTicket(value.id)!
  expect(lease.recycling).toMatchObject({ state: 'failed', error: expect.any(String) })
  expect(lease.releasedAt).toBeUndefined()
  expect(store.directories.claims().find(claim => claim.leaseId === lease.id)?.releasedAt).toBeUndefined()
  await expect(allocator.release(value.id)).rejects.toThrow()
  expect(runHook).toHaveBeenCalledOnce()
  recovery = true
  const restarted = create(); await restarted.recover()
  expect(store.directories.leaseForTicket(value.id)).toMatchObject({ executionEpoch: restarted.epoch,
    recovery: 'cleared', recycling: { state: 'failed' } })
  await expect(restarted.release(value.id)).rejects.toBeInstanceOf(Later)
  expect(runHook).toHaveBeenCalledOnce()
  expect(readFileSync(join(path, 'tracked'), 'utf8')).toBe('Partial recycling output must be preserved')
})

it('fences an interrupted persisted recycling start after restart even when process quiescence is proven', async () => {
  const path = join(root, 'fixed'); mkdirSync(path)
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, directoryPools: [{ id: 'fixed', description: 'Fixed',
    directories: [{ id: 'fixed-directory', path }], prepare: '', recycle: 'configured-recycle' }] } })
  const runHook = vi.fn(async () => {})
  const safety: DirectorySafety = { admission: {
    observe: () => ({ state: 'clear', revision: '1', detail: 'Test baseline' }), commit: (_o, _p, _g, _t, work) => work(),
    assertUse: () => {}, subscribe: () => () => {},
  }, processes: { contain: async () => 'owner', proveQuiescent: async () => 'Verified empty old range' } }
  const create = () => new DirectoryManager({ store, stateDir: root, signal: new AbortController().signal,
    safety, runHook, verify: async () => {} })
  const allocator = create(), value = ticket('one'); value.placement.poolId = 'fixed'; store.tickets.save(value)
  const allocated = await allocator.reserve(value); await allocator.prepare(allocated)
  allocator.beginRelease(value.id)
  const lease = store.directories.leaseForTicket(value.id)!
  store.directories.update(lease.id, allocator.epoch, current => ({ ...current, managedActivity: true,
    recycling: { state: 'started', startedAt: '2026-11-15T00:00:00.000Z' } }))
  const restarted = create(); await restarted.recover()
  expect(store.directories.leaseForTicket(value.id)?.recycling).toMatchObject({ state: 'failed', error: expect.stringContaining('reconciliation') })
  await expect(restarted.release(value.id)).rejects.toBeInstanceOf(Later)
  expect(runHook).not.toHaveBeenCalled()
  expect(store.directories.leaseForTicket(value.id)?.releasedAt).toBeUndefined()
})

it('reacquires an intent-only default reservation at its pinned path and performs first creation there', async () => {
  const allocator = manager(); store.tickets.save(ticket('one'))
  const allocated = await allocator.reserve(ticket('one')), path = allocated.directoryAffinity!.path
  const firstLease = store.directories.leaseForTicket('one')!
  expect(firstLease.preparation.state).toBe('intent'); expect(existsSync(path)).toBe(false)
  allocator.beginRelease('one'); await allocator.release('one')
  const settings = store.settings(); store.saveSettings({ ...settings, executor: { ...settings.executor, directory: join(root, 'changed-root') } })
  const resumed = await allocator.reserve(store.tickets.get('one')!)
  expect(resumed.directoryAffinity?.path).toBe(path)
  expect(store.directories.leaseForTicket('one')).toMatchObject({ state: 'reserved', preparation: { state: 'intent' } })
  expect(existsSync(path)).toBe(false)
  await allocator.prepare(resumed)
  expect(statSync(path).isDirectory()).toBe(true)
  expect(store.directories.leaseForTicket('one')).toMatchObject({ state: 'active', preparation: { state: 'complete' } })
  expect(store.directories.records()).toHaveLength(1)
  expect(store.directories.records()[0]!.lastLeaseSequence).toBe(2)
  expect(existsSync(join(root, 'changed-root', 'fix-one'))).toBe(false)
})

it('does not persist preparation complete or admit execution before workspace verification settles', async () => {
  const entered = Promise.withResolvers<void>(), verified = Promise.withResolvers<void>()
  const allocator = new DirectoryManager({ store, stateDir: root, signal: new AbortController().signal,
    runHook: async () => {}, verify: async () => { entered.resolve(); await verified.promise } })
  store.tickets.save(ticket('one'))
  const allocated = await allocator.reserve(ticket('one'))
  const preparing = allocator.prepare(allocated)
  await entered.promise
  expect(store.directories.leaseForTicket('one')).toMatchObject({ state: 'preparing', preparation: { state: 'started' } })
  expect(() => allocator.assertExecution('one')).toThrow('prepared active')
  verified.resolve(); await preparing
  expect(store.directories.leaseForTicket('one')).toMatchObject({ state: 'active', preparation: { state: 'complete', completedAt: expect.any(String) } })
})

it.each(['--assume-unchanged', '--skip-worktree'])('never declares a changed tracked file clean when index flag %s hides it', flag => {
  const path = join(root, 'repository'); repo(path)
  execFileSync('git', ['-C', path, 'update-index', flag, 'tracked'])
  writeFileSync(join(path, 'tracked'), 'Change hidden by index flags')
  const index = readFileSync(join(path, '.git', 'index'))
  expect(inspectGit(path, true)).toMatchObject({ state: 'unknown', detail: expect.stringContaining('flags can hide changes') })
  expect(readFileSync(join(path, '.git', 'index'))).toEqual(index)
  expect(readFileSync(join(path, 'tracked'), 'utf8')).toBe('Change hidden by index flags')
})

it('disables repository fsmonitor hooks during read-only cleanliness inspection', () => {
  const path = join(root, 'repository'); repo(path)
  const marker = join(root, 'fsmonitor-was-executed'), hook = join(root, 'fsmonitor-hook')
  writeFileSync(hook, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf 'token\\0'\n`, { mode: 0o755 })
  execFileSync('git', ['-C', path, 'config', 'core.fsmonitor', hook])
  const index = readFileSync(join(path, '.git', 'index'))
  expect(inspectGit(path, true)).toMatchObject({ state: 'clean', root: path })
  expect(existsSync(marker)).toBe(false)
  expect(readFileSync(join(path, '.git', 'index'))).toEqual(index)
  // Positive control: Git would execute the configured hook without the probe's explicit override.
  execFileSync('git', ['-C', path, 'status', '--porcelain'], { stdio: 'ignore' })
  expect(existsSync(marker)).toBe(true)
})
