/** Isolated allocator process, killed by the parent without disposal or a SQLite close. No OS-owner provider is simulated as production evidence. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Store } from '../../src/app/store.ts'
import { DirectoryManager } from '../../src/executor/directories.ts'
import type { DirectorySafety } from '../../src/executor/directory-safety.ts'
import type { Ticket } from '../../src/core/index.ts'

const [root, phase, policy] = process.argv.slice(2) as [string, string, string]
const store = new Store(join(root, 'state.sqlite'))
const poolId = policy === 'default' ? 'default' : 'fixed'
const settings = store.settings()
if (poolId === 'fixed') {
  const path = join(root, 'checkout')
  mkdirSync(path)
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(path, 'tracked'), 'Original contents'); git('add', '.'); git('commit', '-qm', 'Initial')
  mkdirSync(join(path, 'a')); mkdirSync(join(path, 'b'))
  settings.executor.directoryPools = [{ id: 'fixed', description: 'Crash test inventory',
    directories: [{ id: 'a', path: join(path, 'a') }, { id: 'b', path: join(path, 'b') }],
    prepare: phase === 'preparing' ? 'prepare-hook' : '', recycle: phase === 'releasing' ? 'recycle-hook' : '' }]
} else if (phase === 'preparing') settings.executor.prepare = 'prepare-hook'
store.saveSettings(settings)
const ticket: Ticket = { id: 'one', title: 'Crash test', decisionId: 'decision',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  placement: { poolId, reason: 'Crash test', contextVersion: 'v' }, execution: { name: 'fix-one', assignment: 'Do work' },
  channels: [], assignments: [{ id: 'assignment-one', state: 'pending', createdAt: '' }],
  inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'one', triggerIds: ['one'] } }
store.tickets.save(ticket); store.directories.enqueue(ticket.id, 'assignment-one')
// This test adapter only allows reaching the recycling phase. The parent reopens without it and must
// retain quarantine; host death and this process-local adapter never count as restart quiescence proof.
const safety: DirectorySafety = {
  admission: { observe: () => ({ state: 'clear', revision: 'test', detail: 'Test baseline' }),
    commit: (_o, _p, _g, _t, operation) => operation(), assertUse: () => {}, subscribe: () => () => {} },
  processes: { contain: async () => 'test-process-range', proveQuiescent: async () => 'Test phase-entry evidence' },
}
function ready() {
  const lease = store.directories.leaseForTicket(ticket.id)!
  process.send!({ id: lease.id, executionEpoch: lease.executionEpoch, path: lease.path })
}
// Keep the IPC process alive even while an interrupted hook awaits forever.
setInterval(() => {}, 1000)
const manager = new DirectoryManager({ store, stateDir: root, safety, signal: new AbortController().signal,
  verify: async () => {}, runHook: async () => {
    const lease = store.directories.leaseForTicket(ticket.id)!
    mkdirSync(lease.path, { recursive: true })
    writeFileSync(join(lease.path, 'partial-effect'), 'Preserve interrupted filesystem effects')
    ready()
    await new Promise<void>(() => {})
  } })
const allocated = await manager.reserve(ticket)
if (phase === 'reserved') ready()
else {
  await manager.prepare(allocated)
  manager.markExecuting(ticket.id)
  if (phase === 'active') ready()
  else {
    manager.beginRelease(ticket.id)
    if (poolId === 'default') ready()
    else await manager.release(ticket.id)
  }
}
