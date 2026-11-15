import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../src/app/store.ts'
import { DirectoryManager, DirectoryRecoveryConflict } from '../src/executor/directories.ts'
import { inspectGit } from '../src/executor/git.ts'
import { Later } from '../src/app/effects.ts'
import type { Ticket } from '../src/core/index.ts'
import type { DirectorySafety } from '../src/executor/directory-safety.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })
const ticket = (id: string, poolId = 'default'): Ticket => ({ id, title: id, decisionId: id, mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  placement: { poolId, reason: 'Test', contextVersion: 'v' }, execution: { name: `fix-${id}`, assignment: 'Do work' }, channels: [], assignments: [{ id: `a-${id}`, state: 'pending', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: id, triggerIds: [id] } })
function fixture(safety?: DirectorySafety) {
  const root = mkdtempSync(join(tmpdir(), 'directory-leases-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  const store = new Store(join(root, 'state.sqlite'))
  cleanups.push(() => store.close())
  const runHook = vi.fn(async (_ticket: Ticket, _command: string, _cwd: string, _signal: AbortSignal) => {})
  const verify = vi.fn(async () => {})
  const createManager = () => new DirectoryManager({ store, stateDir: root, runHook, verify, signal: new AbortController().signal, safety })
  const manager = createManager()
  return { root, store, manager, runHook, verify, createManager }
}
const clearSafety = (): DirectorySafety => ({ admission: { observe: () => ({ state: 'clear', revision: '1', detail: 'Authoritative test baseline' }), commit: (_o, _p, _g, _t, run) => run(), assertUse: () => {}, subscribe: () => () => {} } })
function pool(f: ReturnType<typeof fixture>, directories: { id: string; path: string }[], id = 'frontend') {
  const settings = f.store.settings(); settings.executor.directoryPools.push({ id, description: id, directories, prepare: '', recycle: '' }); f.store.saveSettings(settings); f.store.directories.syncInventory(settings.executor)
}
function queue(f: ReturnType<typeof fixture>, id: string, poolId = 'default') {
  const value = ticket(id, poolId); f.store.tickets.save(value); f.store.directories.enqueue(id, `a-${id}`); return value
}
function git(path: string, ...args: string[]) { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
function repo(path: string) { mkdirSync(path, { recursive: true }); git(path, 'init', '-q'); git(path, 'config', 'user.name', 'Test'); git(path, 'config', 'user.email', 'test@example.invalid'); writeFileSync(join(path, 'tracked'), 'base'); git(path, 'add', '.'); git(path, 'commit', '-qm', 'base') }

describe('durable directory allocation', () => {
  it('default needs no inventory observation and reserves before creation; duplicates retain affinity/LRU', async () => {
    const f = fixture(); const value = queue(f, 'one')
    expect(value.execution?.directory).toBeUndefined()
    const allocated = await f.manager.reserve(value); const path = allocated.directoryAffinity!.path
    expect(existsSync(path)).toBe(false)
    const lease = f.store.directories.leaseForTicket(value.id)!
    expect(lease.state).toBe('reserved'); expect(lease.poolId).toBe('default')
    await f.manager.reserve(allocated)
    expect(f.store.directories.records()[0]!.lastLeaseSequence).toBe(1)
    await f.manager.prepare(allocated); f.manager.assertExecution(value.id)
    expect(existsSync(path)).toBe(true); expect(f.store.directories.claims()).toEqual([])
    expect(f.store.directories.leaseForTicket(value.id)?.preparation.state).toBe('complete')
  })
  it('does not adopt pre-reservation collisions or post-reservation unexpected contents', async () => {
    const f = fixture(); const value = queue(f, 'one'); const existing = join(f.root, 'work', 'fix-one')
    mkdirSync(existing, { recursive: true }); writeFileSync(join(existing, 'keep'), 'important')
    const allocated = await f.manager.reserve(value)
    expect(allocated.directoryAffinity!.path).toBe(`${existing}-1`)
    mkdirSync(allocated.directoryAffinity!.path); writeFileSync(join(allocated.directoryAffinity!.path, 'unexpected'), 'retain')
    await expect(f.manager.prepare(allocated)).rejects.toThrow('unexpected path')
    expect(readFileSync(join(existing, 'keep'), 'utf8')).toBe('important')
    expect(f.store.directories.leaseForTicket(value.id)?.preparation.state).toBe('failed')
    await expect(f.manager.prepare(allocated)).rejects.toThrow()
  })
  it('chooses LRU only among eligible fixed directories and updates sequence only on acquisition', async () => {
    const f = fixture(clearSafety()); const a = join(f.root, 'a'), b = join(f.root, 'b'); mkdirSync(a); mkdirSync(b)
    pool(f, [{ id: 'b', path: b }, { id: 'a', path: a }])
    const first = queue(f, 'one', 'frontend'), second = queue(f, 'two', 'frontend')
    const one = await f.manager.reserve(first); expect(one.directoryAffinity!.directoryId).toBe('a')
    const two = await f.manager.reserve(second); expect(two.directoryAffinity!.directoryId).toBe('b')
    const third = queue(f, 'three', 'frontend')
    await expect(f.manager.reserve(third)).rejects.toBeInstanceOf(Later)
    expect(f.store.tickets.get(third.id)?.directoryAffinity).toBeUndefined()
    expect(f.store.directories.records().map(record => record.lastLeaseSequence).sort()).toEqual([1, 2])
    f.manager.beginRelease(first.id); await f.manager.release(first.id)
    const three = await f.manager.reserve(third); expect(three.directoryAffinity!.directoryId).toBe('a')
    expect(f.store.directories.records().find(record => record.id === 'a')!.lastLeaseSequence).toBe(3)
  })
  it('fixed unknown occupancy waits while default proceeds independently', async () => {
    const f = fixture(); const path = join(f.root, 'inventory'); mkdirSync(path); pool(f, [{ id: 'shared', path }])
    await expect(f.manager.reserve(queue(f, 'shared', 'frontend'))).rejects.toBeInstanceOf(Later)
    expect(f.store.directories.leases()).toHaveLength(0)
    await f.manager.reserve(queue(f, 'dedicated')); expect(f.store.directories.leases()).toHaveLength(1)
    const diagnostic = (await f.manager.diagnostics()).find(item => item.directory.id === 'shared')!
    expect(diagnostic.occupancy.state).toBe('unknown')
  })
  it('atomically serializes sibling directories across pools through one Git working-tree claim', async () => {
    const f = fixture(clearSafety()), root = join(f.root, 'repo'); repo(root); mkdirSync(join(root, 'ui')); mkdirSync(join(root, 'api'))
    pool(f, [{ id: 'ui', path: join(root, 'ui') }], 'frontend'); pool(f, [{ id: 'api', path: join(root, 'api') }], 'backend')
    await f.manager.reserve(queue(f, 'one', 'frontend'))
    const two = queue(f, 'two', 'backend'); await expect(f.manager.reserve(two)).rejects.toBeInstanceOf(Later)
    expect(f.store.directories.claims().filter(claim => !claim.releasedAt)).toHaveLength(1)
    expect(f.store.tickets.get(two.id)?.directoryAffinity).toBeUndefined()
    f.manager.beginRelease('one'); await f.manager.release('one')
    await f.manager.reserve(two); expect(f.store.directories.records().find(record => record.id === 'api')!.lastLeaseSequence).toBe(2)
  })
  it('claims the ancestor Git resource for not-yet-created fixed directories', async () => {
    const f = fixture(clearSafety()), root = join(f.root, 'repo'); repo(root); mkdirSync(join(root, 'existing'))
    pool(f, [{ id: 'existing', path: join(root, 'existing') }, { id: 'missing', path: join(root, 'missing') }])
    await f.manager.reserve(queue(f, 'one', 'frontend'))
    await expect(f.manager.reserve(queue(f, 'two', 'frontend'))).rejects.toBeInstanceOf(Later)
    expect(existsSync(join(root, 'missing'))).toBe(false)
    expect(f.store.directories.claims().filter(claim => !claim.releasedAt).map(claim => claim.root)).toEqual([root])
  })
  it('pins resumed Tickets to exact affinity instead of a free alternative', async () => {
    const f = fixture(clearSafety()), a = join(f.root, 'a'), b = join(f.root, 'b'); mkdirSync(a); mkdirSync(b); pool(f, [{ id: 'a', path: a }, { id: 'b', path: b }])
    const one = await f.manager.reserve(queue(f, 'one', 'frontend'))
    f.manager.beginRelease(one.id); await f.manager.release(one.id)
    // Acquire original directory directly to model intervening use, leaving another free.
    const two = queue(f, 'two', 'frontend'); const record = f.store.directories.records().find(record => record.id === 'a')!
    f.store.directories.reserve(two.id, record, f.manager.epoch)
    await expect(f.manager.reserve(one)).rejects.toBeInstanceOf(Later)
    expect(f.store.tickets.get(one.id)?.directoryAffinity?.path).toBe(a)
  })
  it('reacquires dedicated contents at the old path after root changes, without rerunning creation', async () => {
    const f = fixture(); const one = await f.manager.reserve(queue(f, 'one')); await f.manager.prepare(one)
    const path = one.directoryAffinity!.path; writeFileSync(join(path, 'own-work'), 'retain')
    f.manager.beginRelease(one.id); await f.manager.release(one.id)
    const settings = f.store.settings(); settings.executor.directory = join(f.root, 'other-root'); f.store.saveSettings(settings)
    const resumed = await f.manager.reserve(one); await f.manager.prepare(resumed)
    expect(resumed.directoryAffinity?.path).toBe(path); expect(readFileSync(join(path, 'own-work'), 'utf8')).toBe('retain')
    expect(f.runHook).not.toHaveBeenCalled(); expect(f.store.directories.records()[0]!.lastLeaseSequence).toBe(2)
  })
  it('retains ownership and quarantines release/restart without proven process-owner evidence', async () => {
    const f = fixture(); const one = await f.manager.reserve(queue(f, 'one')); await f.manager.prepare(one); f.manager.markExecuting(one.id)
    f.manager.beginRelease(one.id); await expect(f.manager.release(one.id)).rejects.toBeInstanceOf(Later)
    const lease = f.store.directories.leaseForTicket(one.id)!
    expect(lease.recovery).toBe('quarantined')
    const restarted = f.createManager(); await restarted.recover()
    await expect(restarted.reserve(one)).rejects.toBeInstanceOf(Later)
    expect(f.store.directories.leaseForTicket(one.id)?.id).toBe(lease.id)
    expect(() => f.store.directories.update(lease.id, f.manager.epoch, current => ({ ...current, state: 'active' }))).toThrow('recovery-fenced')
  })
  it('fences every unreleased lifecycle state before dispatch after restart', async () => {
    const f = fixture(); const one = await f.manager.reserve(queue(f, 'one')); const id = f.store.directories.leaseForTicket(one.id)!.id
    const restarted = f.createManager()
    expect(f.store.directories.leases().find(lease => lease.id === id)?.recovery).toBe('quarantined')
    await expect(restarted.prepare(one)).rejects.toBeInstanceOf(Later)
  })
  it('rejects a default empty child inheriting its ancestor Git checkout without mutating that checkout', async () => {
    const f = fixture(); const root = join(f.root, 'repo'); repo(root)
    const settings = f.store.settings(); settings.executor.directory = join(root, 'work'); f.store.saveSettings(settings)
    const one = await f.manager.reserve(queue(f, 'one')); await expect(f.manager.prepare(one)).rejects.toThrow('identity changed')
    expect(git(root, 'show', 'HEAD:tracked').trim()).toBe('base')
    expect(f.store.directories.leaseForTicket(one.id)?.preparation.state).toBe('failed')
  })
  it('allows verified supervisor clearance and safe release, preserving released claim history', async () => {
    const safety = clearSafety(); safety.processes = { contain: async () => 'supervisor-range-42', proveQuiescent: async () => 'Supervisor verified range 42 empty' }
    const f = fixture(safety); const one = await f.manager.reserve(queue(f, 'one')); await f.manager.prepare(one); f.manager.markExecuting(one.id)
    f.manager.beginRelease(one.id); await f.manager.release(one.id)
    expect(f.store.directories.leaseForTicket(one.id)).toBeUndefined(); expect(f.store.directories.leases()[0]!.quiescence?.evidence).toContain('verified')
    expect(f.store.tickets.get(one.id)?.directoryAffinity?.path).toBe(one.directoryAffinity?.path)
  })
  it('reports missing provider, missing owner and unavailable proof without clearing ownership', async () => {
    const safety: DirectorySafety = {}
    const f = fixture(safety), one = await f.manager.reserve(queue(f, 'one'))
    const restarted = f.createManager(), lease = f.store.directories.leaseForTicket(one.id)!
    expect(await restarted.recheckRecovery(lease.id, lease.executionEpoch)).toMatchObject({ cleared: false, detail: expect.stringContaining('No trusted') })
    const proveQuiescent = vi.fn(async () => undefined)
    safety.processes = { contain: async () => 'owner', proveQuiescent }
    expect(await restarted.recheckRecovery(lease.id, lease.executionEpoch)).toMatchObject({ cleared: false, detail: expect.stringContaining('No durable process owner') })
    expect(proveQuiescent).not.toHaveBeenCalled()
    f.store.directories.saveLease({ ...lease, processOwner: 'owner' })
    expect(await restarted.recheckRecovery(lease.id, lease.executionEpoch)).toMatchObject({ cleared: false, detail: expect.stringContaining('could not prove') })
    expect(f.store.directories.leaseForTicket(one.id)).toMatchObject({ recovery: 'quarantined', executionEpoch: lease.executionEpoch })
    expect(f.store.directories.claims().filter(claim => !claim.releasedAt)).toHaveLength(1)
  })
  it('clears a reviewed lease only with trusted evidence, preserving failed effects and rejecting stale epochs', async () => {
    const safety = { processes: { contain: vi.fn(async () => 'owner'), proveQuiescent: vi.fn(async () => 'Supervisor verified entire owner range empty') } }
    const f = fixture(safety), one = await f.manager.reserve(queue(f, 'one'))
    const lease = f.store.directories.leaseForTicket(one.id)!
    f.store.directories.update(lease.id, f.manager.epoch, current => ({ ...current, state: 'preparing', processOwner: 'owner', managedActivity: true, preparation: { state: 'started' } }))
    const restarted = f.createManager()
    await expect(restarted.recheckRecovery(lease.id, 'stale')).rejects.toBeInstanceOf(DirectoryRecoveryConflict)
    expect(safety.processes.proveQuiescent).not.toHaveBeenCalled()
    expect(await restarted.recheckRecovery(lease.id, lease.executionEpoch)).toMatchObject({ cleared: true, detail: expect.stringContaining('require reconciliation') })
    const recovered = f.store.directories.leaseForTicket(one.id)!
    expect(recovered).toMatchObject({ executionEpoch: restarted.epoch, recovery: 'cleared', preparation: { state: 'failed' }, quiescence: { executionEpoch: lease.executionEpoch } })
    expect(restarted.status(one.id)).toContain('reconciliation')
    expect((await restarted.diagnostics())[0]?.blocker).toContain('reconciliation')
    await expect(restarted.prepare(one)).rejects.toThrow('reconciliation')
    expect(f.runHook).not.toHaveBeenCalled()
    expect(await restarted.recheckRecovery(lease.id, restarted.epoch)).toMatchObject({ cleared: true })
    expect(safety.processes.proveQuiescent).toHaveBeenCalledOnce()
    await expect(restarted.recheckRecovery(lease.id, lease.executionEpoch)).rejects.toBeInstanceOf(DirectoryRecoveryConflict)
    expect(() => f.store.directories.clearRecovery(lease.id, restarted.epoch, restarted.epoch, 'Replayed proof')).toThrow('Stale')
  })
  it('rejects delayed proof after the reviewed lease changes or another check clears it', async () => {
    const proof = Promise.withResolvers<string>()
    const safety = { processes: { contain: async () => 'owner', proveQuiescent: vi.fn(() => proof.promise) } }
    const f = fixture(safety), one = await f.manager.reserve(queue(f, 'one'))
    const lease = f.store.directories.leaseForTicket(one.id)!
    f.store.directories.update(lease.id, f.manager.epoch, current => ({ ...current, processOwner: 'owner' }))
    const restarted = f.createManager()
    const stale = restarted.recheckRecovery(lease.id, lease.executionEpoch)
    restarted.beginRelease(one.id)
    const first = restarted.recheckRecovery(lease.id, lease.executionEpoch)
    const duplicate = restarted.recheckRecovery(lease.id, lease.executionEpoch)
    const results = Promise.allSettled([stale, first, duplicate])
    proof.resolve('Verified empty range')
    expect((await results).map(result => result.status)).toEqual(['rejected', 'fulfilled', 'rejected'])
    expect(f.store.directories.leaseForTicket(one.id)).toMatchObject({ state: 'releasing', recovery: 'cleared', executionEpoch: restarted.epoch })
    expect(f.store.directories.claims().filter(claim => !claim.releasedAt)).toHaveLength(1)
  })
})

describe('read-only Git eligibility', () => {
  it('detects untracked, staged, unstaged and unfinished operations for nested directories', () => {
    const f = fixture(), path = join(f.root, 'repo'); repo(path); mkdirSync(join(path, 'ui'))
    expect(inspectGit(join(path, 'ui'), true)).toMatchObject({ state: 'clean', root: path })
    writeFileSync(join(path, 'untracked'), 'x'); expect(inspectGit(join(path, 'ui'), true).state).toBe('dirty')
    git(path, 'add', '.'); expect(inspectGit(path, true).state).toBe('dirty'); git(path, 'commit', '-qm', 'file')
    writeFileSync(join(path, 'tracked'), 'edit'); expect(inspectGit(path, true).state).toBe('dirty'); git(path, 'add', '.'); git(path, 'commit', '-qm', 'edit')
    writeFileSync(join(path, '.git', 'CHERRY_PICK_HEAD'), git(path, 'rev-parse', 'HEAD'))
    expect(inspectGit(path, true).state).toBe('unfinished')
  })
  it('ignores ignored-only output but distinguishes linked worktrees sharing common metadata', () => {
    const f = fixture(), path = join(f.root, 'repo'), linked = join(f.root, 'linked'); repo(path)
    writeFileSync(join(path, '.gitignore'), 'ignored\n'); git(path, 'add', '.'); git(path, 'commit', '-qm', 'ignore'); writeFileSync(join(path, 'ignored'), 'artifact')
    expect(inspectGit(path, true).state).toBe('clean')
    git(path, 'worktree', 'add', '-qb', 'linked', linked)
    const original = inspectGit(path, true), other = inspectGit(linked, true)
    expect(original.root).not.toBe(other.root); expect(original.gitDirectory).not.toBe(other.gitDirectory); expect(other.state).toBe('clean')
  })
  it('resolves symlink aliases and fails closed on malformed metadata and bare repositories', () => {
    const f = fixture(), path = join(f.root, 'repo'); repo(path)
    symlinkSync(path, join(f.root, 'alias')); expect(inspectGit(join(f.root, 'alias'), true).root).toBe(path)
    const broken = join(f.root, 'broken'); mkdirSync(broken); writeFileSync(join(broken, '.git'), 'not git metadata')
    expect(inspectGit(broken, true).state).toBe('unknown')
    const bare = join(f.root, 'bare'); mkdirSync(bare); git(bare, 'init', '--bare', '-q'); expect(inspectGit(bare, true).state).toBe('unknown')
  })
})
