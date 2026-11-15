/** SIGKILL durability tests: no graceful close, missing process-owner evidence never admits writes/reuse. */
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DirectoryManager } from '../src/executor/directories.ts'
import { Later } from '../src/app/effects.ts'

const cases = ['default', 'fixed'].flatMap(policy => ['reserved', 'preparing', 'active', 'releasing'].map(phase => ({ policy, phase })))
it.each(cases)('retains $policy ownership and fences $phase after an isolated SIGKILL', async ({ policy, phase }) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-directory-crash-'))
  const child = fork(fileURLToPath(new URL('./fixtures/directory-crash.ts', import.meta.url)), [root, phase, policy], {
    execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'], silent: true,
  })
  let stderr = '', store: Store | undefined
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  try {
    const snapshot = await new Promise<{ id: string; executionEpoch: string; path: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error(`Crash fixture did not reach phase: ${stderr}`)) }, 10_000)
      child.once('message', message => { clearTimeout(timeout); resolve(message as { id: string; executionEpoch: string; path: string }) })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`Crash fixture exited before phase: ${code}/${signal}: ${stderr}`)) })
    })
    const exited = once(child, 'exit')
    expect(child.kill('SIGKILL')).toBe(true)
    expect(await exited).toEqual([null, 'SIGKILL'])
    store = new Store(join(root, 'state.sqlite'))
    const runHook = vi.fn(async () => {})
    const manager = new DirectoryManager({ store, stateDir: root, signal: new AbortController().signal,
      runHook, verify: async () => {} })
    const ticket = store.tickets.get('one')!
    const lease = store.directories.leaseForTicket(ticket.id)!
    expect(lease).toMatchObject({ id: snapshot.id, executionEpoch: snapshot.executionEpoch, state: phase, recovery: 'quarantined' })
    expect(ticket.directoryAffinity?.path).toBe(snapshot.path)
    expect(store.directories.records().find(record => record.id === lease.directoryId)?.lastLeaseSequence).toBe(1)
    expect(store.directories.queue().map(item => item.ticketId)).toEqual(phase === 'reserved' || phase === 'preparing' ? ['one'] : [])
    if (policy === 'fixed' || phase === 'reserved' || phase === 'preparing') {
      expect(store.directories.claims().filter(claim => !claim.releasedAt)).toHaveLength(1)
    }
    if (phase === 'preparing' || policy === 'fixed' && phase === 'releasing') {
      expect(readFileSync(join(snapshot.path, 'partial-effect'), 'utf8')).toBe('Preserve interrupted filesystem effects')
    }
    if (phase === 'reserved' && policy === 'default') expect(existsSync(snapshot.path)).toBe(false)
    await manager.recover()
    expect(store.directories.leaseForTicket(ticket.id)?.recovery).toBe('quarantined')
    await expect(manager.reserve(ticket)).rejects.toBeInstanceOf(Later)
    await expect(manager.prepare(ticket)).rejects.toBeInstanceOf(Later)
    expect(() => manager.assertExecution(ticket.id)).toThrow()
    await manager.release(ticket.id, snapshot.id, 'stale-epoch')
    expect(runHook).not.toHaveBeenCalled()
    expect(store.directories.leaseForTicket(ticket.id)?.releasedAt).toBeUndefined()
    // The free sibling registration still cannot acquire the old checkout's retained Git resource.
    if (policy === 'fixed') {
      store.tickets.save({ ...ticket, id: 'two', directoryAffinity: undefined })
      const record = store.directories.records().find(record => record.id === 'b')!
      const claim = store.directories.claims().find(claim => claim.leaseId === snapshot.id)!
      expect(store.directories.reserve('two', record, manager.epoch, claim)).toBeUndefined()
      expect(store.tickets.get('two')?.directoryAffinity).toBeUndefined()
      expect(store.directories.records().find(record => record.id === 'b')?.lastLeaseSequence).toBe(0)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    store?.close(); rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
