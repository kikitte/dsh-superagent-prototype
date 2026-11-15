/** Canonical registration validation and transaction-safe lifecycle protections; registration is read-only on disk. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalDirectory, directoriesOverlap, validateDirectorySettings } from '../src/app/directory-settings.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'

const roots: string[] = [], stores: Store[] = []
afterEach(() => { stores.forEach(store => store.close()); stores.length = 0; roots.forEach(root => rmSync(root, { recursive: true, force: true })); roots.length = 0 })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'directory-settings-')); roots.push(root)
  const store = new Store(join(root, 'state.sqlite')); stores.push(store)
  const current = ExecutorConfigSchema.parse({ directory: join(root, 'default'), directoryPools: [{ id: 'ui', description: 'UI', directories: [{ id: 'ui-1', path: join(root, 'ui') }] }] })
  return { root, store, current }
}
function ticket(poolId = 'ui'): Ticket {
  return { id: 't1', title: 'UI fix', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'p1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: 'Fix' },
    placement: { poolId, reason: 'UI work', contextVersion: 'c1' }, origin: { triggerId: 'r1', triggerIds: ['r1'] }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '' }
}
it('validates reserved IDs and globally unique inventory IDs while allowing empty pools', () => {
  expect(ExecutorConfigSchema.safeParse({ directoryPools: [{ id: 'default', description: 'Semantic pool description', directories: [] }] }).success).toBe(false)
  expect(ExecutorConfigSchema.safeParse({ directoryPools: [{ id: 'ui', description: 'UI implementation', directories: [] }] }).success).toBe(true)
  expect(ExecutorConfigSchema.safeParse({ directoryPools: [{ id: 'ui', description: '   ', directories: [] }] }).success).toBe(false)
  expect(ExecutorConfigSchema.safeParse({ defaultPoolDescription: '   ' }).success).toBe(false)
  expect(ExecutorConfigSchema.safeParse({ directoryPools: [{ id: 'ui', description: 'Semantic pool description' }, { id: 'ui', description: 'Semantic pool description' }] }).success).toBe(false)
  expect(ExecutorConfigSchema.safeParse({ directoryPools: [{ id: 'ui', description: 'Semantic pool description', directories: [{ id: 'a', path: '/one' }] }, { id: 'api', description: 'Semantic pool description', directories: [{ id: 'a', path: '/two' }] }] }).success).toBe(false)
})
it('resolves existing symlink parents without creating registered directories and rejects aliases, overlaps, dangling links and files', () => {
  const { root, store, current } = fixture()
  mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'alias'))
  expect(canonicalDirectory(join(root, 'alias', 'future', 'child'))).toBe(join(root, 'real', 'future', 'child'))
  const withPaths = (paths: string[]) => ({ ...current, directoryPools: [{ ...current.directoryPools[0]!, directories: paths.map((path, i) => ({ id: `d${i}`, path })) }] })
  expect(() => validateDirectorySettings(store, current, withPaths([join(root, 'alias', 'future'), join(root, 'real', 'future')]))).toThrow('aliases or overlap')
  expect(() => validateDirectorySettings(store, current, withPaths([join(root, 'real'), join(root, 'real', 'nested')]))).toThrow('aliases or overlap')
  expect(() => validateDirectorySettings(store, current, withPaths([join(root, 'default', 'nested')]))).toThrow('default-pool root')
  expect(() => validateDirectorySettings(store, current, withPaths([join(root, 'real', 'ui'), join(root, 'real', 'api')]))).not.toThrow()
  expect(directoriesOverlap('/repo/ui', '/repo/ui-other')).toBe(false)
  symlinkSync(join(root, 'missing'), join(root, 'dangling'))
  expect(() => canonicalDirectory(join(root, 'dangling', 'child'))).toThrow('Dangling')
  writeFileSync(join(root, 'file'), '')
  expect(() => canonicalDirectory(join(root, 'file'))).toThrow('Not a directory')
  expect(existsSync(join(root, 'real', 'future'))).toBe(false)
})
it('retires even empty pool identities permanently and explains attempted recreation before saving', () => {
  const { store, current } = fixture()
  const empty = { ...current, directoryPools: [{ id: 'empty', description: 'Not yet registered', directories: [], prepare: '', recycle: '' }] }
  store.directories.syncInventory(empty)
  const removed = { ...current, directoryPools: [] }
  store.atomic(() => { validateDirectorySettings(store, empty, removed); store.directories.syncInventory(removed) })
  expect(store.directories.poolRetired('empty')).toBe(true)
  expect(() => validateDirectorySettings(store, removed, empty)).toThrow('Pool ID empty is retired')
})
it('does not mistake synthesized default directories for removed fixed registrations during ordinary executor saves', () => {
  const { store, root, current } = fixture()
  store.tickets.save(ticket('default'))
  const record = { id: 'default-t1', poolId: 'default', path: join(root, 'default', 't1'), createdAt: '', lastLeaseSequence: 0 }
  store.directories.reserve('t1', record, 'epoch')
  expect(() => validateDirectorySettings(store, current, { ...current, maxWorkers: 5, defaultPoolDescription: 'New semantic description' })).not.toThrow()
  expect(() => validateDirectorySettings(store, current, { ...current, prepare: 'different hook' })).toThrow('Default preparation cannot change')
  expect(() => validateDirectorySettings(store, current, { ...current, directory: record.path })).toThrow('Default-pool root overlaps retained')
})
it('blocks pool removal for queued selections and held directory removal or hook changes, then preserves retired history and affinity', () => {
  const { root, store, current } = fixture()
  store.atomic(() => { validateDirectorySettings(store, current, current); store.directories.syncInventory(current) })
  store.tickets.save(ticket())
  expect(() => validateDirectorySettings(store, current, { ...current, directoryPools: [] })).toThrow('open Ticket selections')
  const record = store.directories.records()[0]!
  const lease = store.directories.reserve('t1', record, 'epoch')!
  expect(() => validateDirectorySettings(store, current, { ...current, directoryPools: [{ ...current.directoryPools[0]!, directories: [] }] })).toThrow('unreleased lease')
  expect(() => validateDirectorySettings(store, current, { ...current, directoryPools: [{ ...current.directoryPools[0]!, recycle: 'cleanup' }] })).toThrow('hooks cannot change')
  const moved = { ...current, directoryPools: [{ ...current.directoryPools[0]!, directories: [{ id: record.id, path: join(root, 'new') }] }] }
  expect(() => validateDirectorySettings(store, current, moved)).toThrow('retained history or affinity')
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at: '', by: 'executor', outcome: 'completed' } })
  store.directories.saveLease({ ...lease, state: 'releasing', recovery: 'quarantined' })
  expect(() => validateDirectorySettings(store, current, { ...current, directoryPools: [] })).toThrow('unreleased leases')
  store.directories.saveLease({ ...lease, state: 'releasing', releasedAt: 'done' })
  const retired = { ...current, directoryPools: [] }
  store.atomic(() => { validateDirectorySettings(store, current, retired); store.directories.syncInventory(retired) })
  expect(store.directories.affinity('t1')).toEqual({ poolId: 'ui', directoryId: record.id, path: record.path })
  expect(store.directories.records()[0]?.retired).toBe(true)
  expect(() => validateDirectorySettings(store, retired, current)).toThrow('retired')
  expect(() => validateDirectorySettings(store, retired, { ...current, directoryPools: [{ ...current.directoryPools[0]!, id: 'replacement-pool', directories: [{ id: 'replacement', path: record.path }] }] })).toThrow('overlaps retained')
})
