/** Executor directory manager: policy-specific admission, durable reservations, preparation and safe release. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../app/store.ts'
import { canonicalDirectory, validateDirectorySettings } from '../app/directory-settings.ts'
import type { DirectoryRecord, DirectoryLeaseRecord } from '../app/directory-store.ts'
import { overlaps } from '../app/directory-store.ts'
import { executionRoot } from '../app/execution-environment.ts'
import { Later } from '../app/effects.ts'
import { waitsForPerson, type Ticket } from '../core/index.ts'
import { inspectGit, type GitProbe } from './git.ts'
import { UNKNOWN_OCCUPANCY, type DirectorySafety, type Occupancy } from './directory-safety.ts'
export interface DirectoryDiagnostic { directory: DirectoryRecord; lease?: DirectoryLeaseRecord; git?: GitProbe; occupancy: Occupancy; blocker?: string }
export interface RecoveryCheck { cleared: boolean; detail: string }
/** A reviewed recovery snapshot changed before trusted evidence could be committed. */
export class DirectoryRecoveryConflict extends Error {
  constructor() { super('Directory lease changed during recovery review; refresh diagnostics and retry') }
}
export interface DirectoryManagerHost {
  store: Pick<Store, 'directories' | 'tickets' | 'settings' | 'atomic' | 'db'>
  stateDir: string; safety?: DirectorySafety
  runHook(ticket: Ticket, command: string, cwd: string, signal: AbortSignal): Promise<void>
  verify(path: string): Promise<void>
  signal: AbortSignal
}
/** Owns policy-specific allocation and filesystem phases while Store enforces durable exclusive ownership. */
export class DirectoryManager {
  readonly epoch = randomUUID()
  private readonly preparing = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private readonly blockers = new Map<string, string>()
  constructor(private readonly host: DirectoryManagerHost) {
    // This runs in Runtime construction, before Session restoration or effects dispatch.
    host.store.directories.fencePriorEpoch(this.epoch)
    const settings = host.store.settings().executor
    host.store.atomic(() => { validateDirectorySettings(host.store, settings, settings, host.stateDir); host.store.directories.syncInventory(settings) })
  }
  private get data() { return this.host.store.directories }
  private pool(id: string) { return this.host.store.settings().executor.directoryPools.find(pool => pool.id === id) }
  private occupancy(directory: DirectoryRecord, git: GitProbe, ticketId: string): Occupancy {
    return directory.poolId === 'default' ? { state: 'clear', revision: 'dedicated', detail: 'Not applicable — dedicated default directory' }
      : this.host.safety?.admission?.observe(directory.path, git.root, ticketId) ?? UNKNOWN_OCCUPANCY
  }
  async diagnostics(): Promise<DirectoryDiagnostic[]> {
    return this.data.records().map(directory => {
      const lease = this.data.leases().find(lease => lease.directoryId === directory.id && !lease.releasedAt)
      const git = inspectGit(directory.path, directory.poolId !== 'default' && !lease)
      const owner = git.root && this.data.claims().find(claim => !claim.releasedAt && claim.root === git.root && claim.leaseId !== lease?.id)
      return { directory, lease, git, occupancy: this.occupancy(directory, git, lease?.ticketId ?? ''),
        blocker: owner ? `Git working tree leased by another Ticket (${owner.leaseId})` : lease?.error ?? lease?.preparation.error ?? lease?.recycling?.error }
    })
  }
  status(ticketId: string): string | undefined {
    const lease = this.data.leaseForTicket(ticketId)
    return this.blockers.get(ticketId) ?? lease?.error ?? lease?.preparation.error ?? lease?.recycling?.error
  }
  private wait(ticketId: string, reason: string): never { this.blockers.set(ticketId, reason); throw new Later(reason) }
  /** Pure/read-only eligibility; no new worker slot or lease held while waiting. */
  private eligible(record: DirectoryRecord, ticketId: string): { git: GitProbe; occupancy: Occupancy } | string {
    if (record.retired || !this.pool(record.poolId)) return 'Original execution directory is retired; operator remediation is required'
    try { if (canonicalDirectory(record.path) !== record.path) return 'Canonical execution-directory identity changed' } catch (error) { return String(error) }
    const held = this.data.leases().find(lease => !lease.releasedAt && overlaps(lease.path, record.path))
    if (held) return `Waiting for directory lease ${held.id} (${held.recovery})`
    const git = inspectGit(record.path, true)
    if (['dirty', 'unfinished', 'unknown'].includes(git.state)) return `${git.state === 'dirty' ? 'Git working tree not clean' : git.state === 'unfinished' ? 'Git operation unfinished' : 'Git status unavailable'}: ${git.detail ?? ''}`
    if (git.root && this.data.claims().some(claim => !claim.releasedAt && (claim.root === git.root || claim.gitDirectory === git.gitDirectory))) return 'Waiting for exclusive Git working-tree resource'
    const occupancy = this.occupancy(record, git, ticketId)
    if (occupancy.state !== 'clear') return occupancy.detail
    return { git, occupancy }
  }
  private candidates(ticket: Ticket): DirectoryRecord[] {
    const affinity = ticket.directoryAffinity
    const records = this.data.records()
    if (affinity) {
      const record = records.find(record => record.id === affinity.directoryId)
      if (!record || record.path !== affinity.path || record.poolId !== affinity.poolId) this.wait(ticket.id, 'Original directory registration is unavailable; no replacement is permitted')
      return [record]
    }
    return records.filter(record => record.poolId === ticket.placement.poolId && !record.retired)
      .sort((a, b) => a.lastLeaseSequence - b.lastLeaseSequence || a.id.localeCompare(b.id))
  }
  private selectable(ticket: Ticket): { record: DirectoryRecord; git: GitProbe; occupancy: Occupancy } | string {
    let reason = ticket.directoryAffinity ? 'Waiting for affinity directory' : 'Waiting for an eligible execution directory'
    for (const record of this.candidates(ticket)) {
      const result = this.eligible(record, ticket.id)
      if (typeof result !== 'string') return { record, ...result }
      reason = result
    }
    return reason
  }
  /** Checks FIFO among requests currently eligible for the same constrained resource. */
  private checkQueue(ticket: Ticket, record?: DirectoryRecord, git?: GitProbe): void {
    const own = this.data.queue().find(item => item.ticketId === ticket.id)
    if (!own) return
    for (const item of this.data.queue().filter(item => item.seq < own.seq)) {
      const earlier = this.host.store.tickets.get(item.ticketId)
      if (!earlier || earlier.ended || waitsForPerson(earlier) || this.data.leaseForTicket(earlier.id)) continue
      if (earlier.placement.poolId === 'default') {
        if (ticket.placement.poolId === 'default') this.wait(ticket.id, 'Waiting for earlier eligible Ticket in default queue')
        continue
      }
      const candidate = this.selectable(earlier)
      if (typeof candidate !== 'string' && (earlier.placement.poolId === ticket.placement.poolId || candidate.record.id === record?.id || candidate.git.root && candidate.git.root === git?.root)) this.wait(ticket.id, 'Waiting for earlier eligible Ticket')
    }
  }
  /** Called only after synchronous worker-slot reservation; commits before any filesystem creation/hook. */
  async reserve(ticket: Ticket): Promise<Ticket> {
    const currentLease = this.data.leaseForTicket(ticket.id)
    if (currentLease) { this.assertLease(currentLease); this.blockers.delete(ticket.id); return this.host.store.tickets.get(ticket.id)! }
    if (ticket.placement.poolId === 'default') {
      this.checkQueue(ticket)
      let record: DirectoryRecord
      const previous = this.data.leases().filter(lease => lease.ticketId === ticket.id).at(-1)
      if (ticket.directoryAffinity) {
        record = this.candidates(ticket)[0]!
        if (previous && !['intent', 'complete'].includes(previous.preparation.state)) throw new Error('Previous preparation requires reconciliation; no replacement is permitted')
        if (previous?.preparation.state === 'complete' && !await stat(record.path).then(s => s.isDirectory(), () => false)) throw new Error('Previously prepared dedicated directory disappeared; no replacement is permitted')
      } else {
        const root = canonicalDirectory(executionRoot(this.host.store.settings(), this.host.stateDir))
        // Dedicated creation bypasses occupancy/cleanliness, never another lease's Git resource.
        if (this.data.claims().some(claim => !claim.releasedAt && (claim.root === root || root.startsWith(claim.root === '/' ? '/' : `${claim.root}/`)))) this.wait(ticket.id, 'Default root overlaps an exclusively leased Git working-tree resource')
        if (this.data.records().some(record => record.path === root || root.startsWith(`${record.path}/`))) throw new Error('Default-pool root is inside a registered or retained execution directory; choose a separate root')
        const name = ticket.execution?.name
        if (!name) throw new Error('Ticket short name is missing')
        let suffix = 0, path: string
        for (;;) {
          path = join(root, `${name}${suffix ? `-${suffix}` : ''}`)
          const exists = await lstat(path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false })
          if (!exists && !this.data.records().some(record => overlaps(record.path, path))) break
          suffix++
        }
        record = { id: `default:${ticket.id}`, poolId: 'default', path, lastLeaseSequence: 0, createdAt: new Date().toISOString() }
      }
      const git = ticket.directoryAffinity && previous?.preparation.state === 'complete' ? inspectGit(record.path) : undefined
      if (git?.state === 'unknown') throw new Error(git.detail)
      if (git?.root && git.root !== record.path) throw new Error('Dedicated default directory must not inherit an ancestor working tree')
      const lease = this.data.reserve(ticket.id, record, this.epoch, { root: git?.root ?? record.path, ...(git?.gitDirectory ? { gitDirectory: git.gitDirectory } : {}), state: git?.root ? 'verified' : 'reserved' })
      if (!lease) this.wait(ticket.id, 'Waiting for original directory or Git working-tree resource')
      // A released default lease reacquires retained preparation; creation hooks must not run again.
      if (ticket.directoryAffinity && previous?.preparation.state === 'complete') this.data.update(lease.id, this.epoch, current => ({ ...current, state: 'active', preparation: { state: 'complete', completedAt: new Date().toISOString() } }))
    } else {
      const candidate = this.selectable(ticket)
      if (typeof candidate === 'string') this.wait(ticket.id, candidate)
      this.checkQueue(ticket, candidate.record, candidate.git)
      const admission = this.host.safety?.admission
      if (!admission) this.wait(ticket.id, UNKNOWN_OCCUPANCY.detail)
      const lease = admission.commit(candidate.occupancy, candidate.record.path, candidate.git.root, ticket.id, () => this.host.store.atomic(() => {
        const checked = this.eligible(candidate.record, ticket.id)
        if (typeof checked === 'string') this.wait(ticket.id, checked)
        if (JSON.stringify(checked.git) !== JSON.stringify(candidate.git) || checked.occupancy.revision !== candidate.occupancy.revision) this.wait(ticket.id, 'Eligibility observation changed during reservation')
        return this.data.reserve(ticket.id, candidate.record, this.epoch, { root: checked.git.root ?? candidate.record.path,
          ...(checked.git.gitDirectory ? { gitDirectory: checked.git.gitDirectory } : {}), state: checked.git.root ? 'verified' : 'reserved' })
      }))
      if (!lease) this.wait(ticket.id, 'Directory reservation race; waiting for eligibility')
    }
    this.blockers.delete(ticket.id)
    return this.host.store.tickets.get(ticket.id)!
  }
  private assertLease(lease: DirectoryLeaseRecord, active = false): void {
    if (lease.executionEpoch !== this.epoch || lease.recovery !== 'cleared') this.wait(lease.ticketId, lease.error ?? 'Directory recovery requires verified old-range quiescence')
    if (lease.state === 'releasing') this.wait(lease.ticketId, 'Waiting for original directory lease release and recycling')
    if (lease.releasedAt || active && (lease.state !== 'active' || lease.preparation.state !== 'complete')) throw new Error('Ticket does not hold a prepared active directory lease')
    if (canonicalDirectory(lease.path) !== lease.path) throw new Error('Execution-directory canonical identity changed')
    if (lease.poolId !== 'default') {
      if (!this.host.safety?.admission) this.wait(lease.ticketId, UNKNOWN_OCCUPANCY.detail)
      this.host.safety.admission.assertUse(lease)
    }
  }
  assertExecution(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId), lease = this.data.leaseForTicket(ticketId)
    if (!ticket || ticket.ended || !lease || ticket.directoryAffinity?.path !== lease.path) throw new Error('Ticket has no current directory ownership')
    this.assertLease(lease, true)
    this.verifyIdentity(lease, true)
  }
  private verifyIdentity(lease: DirectoryLeaseRecord, complete = false): GitProbe {
    if (canonicalDirectory(lease.path) !== lease.path) throw new Error('Execution-directory canonical identity changed; reconciliation required')
    const git = inspectGit(lease.path)
    // A dedicated first-creation hook reserves its intended independent root, not its absent path's ancestor checkout.
    if (lease.poolId === 'default' && git.state === 'missing' && !complete) return { state: 'missing' }
    if (git.state === 'unknown' || complete && git.state === 'missing') throw new Error(git.detail ?? 'Prepared directory disappeared')
    const claim = this.data.claims().find(claim => claim.leaseId === lease.id && !claim.releasedAt)
    if (claim?.state === 'verified' && !git.root) throw new Error('Verified Git working-tree identity disappeared; ownership reconciliation required')
    if (git.root && (!claim || claim.root !== git.root || claim.gitDirectory && claim.gitDirectory !== git.gitDirectory)) throw new Error('Git working-tree identity changed; ownership reconciliation required')
    if (lease.poolId === 'default' && git.root && git.root !== lease.path) throw new Error('Default preparation inherited an ancestor Git working tree instead of an independent checkout')
    if (complete && claim) {
      if (git.root) this.data.saveClaim({ ...claim, gitDirectory: git.gitDirectory, state: 'verified' })
      else if (git.state === 'non-git') this.host.store.db.prepare('DELETE FROM git_worktree_claim WHERE leaseId=? AND releasedAt IS NULL').run(lease.id)
    }
    return git
  }
  async prepare(ticket: Ticket): Promise<void> {
    const lease = this.data.leaseForTicket(ticket.id)
    if (!lease) throw new Error('Preparation requires a committed directory reservation')
    this.assertLease(lease)
    if (lease.preparation.state === 'complete') {
      this.verifyIdentity(lease, true); await this.host.verify(lease.path)
      if (!lease.processOwner && this.host.safety?.processes) {
        const processOwner = await this.host.safety.processes.contain(lease)
        this.data.update(lease.id, this.epoch, current => ({ ...current, processOwner }))
      }
      return
    }
    if (lease.preparation.state !== 'intent') throw new Error(lease.preparation.error ?? 'Interrupted/failed preparation requires operator reconciliation; existing contents are not proof of preparation')
    const abort = new AbortController()
    const done = this.prepareOwned(ticket, lease, AbortSignal.any([abort.signal, this.host.signal]))
    this.preparing.set(ticket.id, { abort, done })
    try { await done } finally { this.preparing.delete(ticket.id) }
  }
  private async prepareOwned(ticket: Ticket, lease: DirectoryLeaseRecord, signal: AbortSignal): Promise<void> {
    try {
      this.verifyIdentity(lease)
      if (lease.poolId !== 'default') {
        const git = inspectGit(lease.path, true)
        if (['dirty', 'unfinished', 'unknown'].includes(git.state)) this.wait(ticket.id, `Workspace changed after reservation: ${git.detail ?? git.state}`)
      } else {
        const exists = await lstat(lease.path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false })
        if (exists) throw new Error('Filesystem conflict: unexpected path appeared after committed default reservation; contents preserved')
      }
      let processOwner: string | undefined
      if (this.host.safety?.processes) processOwner = await this.host.safety.processes.contain(lease)
      this.data.update(lease.id, this.epoch, current => ({ ...current, state: 'preparing', processOwner, preparation: { state: 'started', startedAt: new Date().toISOString() } }))
      const command = lease.poolId === 'default' ? this.host.store.settings().executor.prepare.trim() : this.pool(lease.poolId)?.prepare.trim() ?? ''
      if (lease.poolId === 'default') await mkdir(join(lease.path, '..'), { recursive: true })
      else await mkdir(lease.path, { recursive: true })
      this.assertLease(this.data.leaseForTicket(ticket.id)!)
      if (command) {
        this.data.update(lease.id, this.epoch, current => ({ ...current, managedActivity: true }))
        await this.host.runHook(ticket, command, lease.poolId === 'default' ? join(lease.path, '..') : lease.path, signal)
      } else if (lease.poolId === 'default') await mkdir(lease.path) // exclusive mkdir; never adopt a post-reservation collision
      else await mkdir(lease.path, { recursive: true })
      this.assertLease(this.data.leaseForTicket(ticket.id)!)
      this.verifyIdentity(lease, true)
      await this.host.verify(lease.path)
      this.data.update(lease.id, this.epoch, current => ({ ...current, state: 'active', preparation: { ...current.preparation, state: 'complete', completedAt: new Date().toISOString() } }))
    } catch (error) {
      if (!(error instanceof Later)) this.data.update(lease.id, this.epoch, current => ({ ...current, error: String(error), preparation: { ...current.preparation, state: 'failed', error: String(error) } }))
      throw error
    }
  }
  markExecuting(ticketId: string): void {
    this.assertExecution(ticketId)
    const lease = this.data.leaseForTicket(ticketId)!
    this.data.update(lease.id, this.epoch, current => ({ ...current, managedActivity: true }))
    this.data.dequeue(ticketId)
  }
  beginRelease(ticketId: string): void {
    this.data.dequeue(ticketId)
    const lease = this.data.leaseForTicket(ticketId)
    if (lease && !lease.releasedAt) this.data.saveLease({ ...lease, state: 'releasing' })
  }
  async release(ticketId: string, expectedLeaseId?: string, expectedEpoch?: string): Promise<void> {
    const activity = this.preparing.get(ticketId)
    activity?.abort.abort()
    if (activity) await activity.done.catch(() => {})
    const lease = this.data.leaseForTicket(ticketId)
    if (!lease || lease.state !== 'releasing' || expectedLeaseId && lease.id !== expectedLeaseId || expectedEpoch && lease.executionEpoch !== expectedEpoch) return
    if (lease.executionEpoch !== this.epoch || lease.recovery !== 'cleared') this.wait(ticketId, lease.error ?? 'Lease recovery is fenced')
    let evidence = lease.managedActivity ? lease.processOwner && await this.host.safety?.processes?.proveQuiescent(lease, lease.processOwner) : 'No managed execution began under this reservation'
    if (!evidence) {
      this.data.saveLease({ ...lease, recovery: 'quarantined', error: 'No verified process-owner evidence proves all managed descendants stopped; lease and Git resource remain held.' })
      this.wait(ticketId, 'Release quarantined pending verified process containment/quiescence evidence')
    }
    this.data.update(lease.id, this.epoch, current => ({ ...current, quiescence: { evidence: evidence!, at: new Date().toISOString(), executionEpoch: this.epoch } }))
    this.verifyIdentity(lease, lease.preparation.state === 'complete')
    if (lease.poolId !== 'default') {
      if (!this.host.safety?.admission) this.wait(ticketId, UNKNOWN_OCCUPANCY.detail)
      this.host.safety.admission.assertUse(lease)
      this.verifyIdentity(lease)
      const recycle = this.pool(lease.poolId)?.recycle.trim()
      // No automatic destructive cleanup; configured recycling is an operator contract preserving branch/artifacts.
      if (recycle) {
        const phase = this.data.leaseForTicket(ticketId)?.recycling
        if (phase && phase.state !== 'intent' && phase.state !== 'complete') this.wait(ticketId, phase.error ?? 'Interrupted recycling requires verified reconciliation; hook will not be replayed')
        if (phase?.state !== 'complete') {
          if (!this.host.safety?.processes) this.wait(ticketId, 'Recycling requires a verified process containment owner')
          const processOwner = lease.processOwner ?? await this.host.safety.processes.contain(lease)
          this.data.update(lease.id, this.epoch, current => ({ ...current, processOwner, managedActivity: true, recycling: { state: 'started', startedAt: new Date().toISOString() } }))
          try {
            const ticket = this.host.store.tickets.get(ticketId)!
            await this.host.runHook(ticket, recycle, lease.path, this.host.signal)
            const current = this.data.leaseForTicket(ticketId)!
            const stopped = await this.host.safety.processes.proveQuiescent(current, processOwner)
            if (!stopped) throw new Error('Recycling process range has not been proven empty; reconciliation required')
            evidence = stopped
            this.data.update(lease.id, this.epoch, current => ({ ...current, recycling: { ...current.recycling!, state: 'complete', completedAt: new Date().toISOString() } }))
          } catch (error) {
            this.data.update(lease.id, this.epoch, current => ({ ...current, error: String(error), recycling: { ...current.recycling!, state: 'failed', error: String(error) } }))
            throw error
          }
        }
      }
      this.verifyIdentity(lease)
      const git = inspectGit(lease.path, true)
      if (['dirty', 'unfinished', 'unknown'].includes(git.state)) this.wait(ticketId, `Recycling incomplete: ${git.detail ?? git.state}`)
    }
    this.data.release(lease.id, this.epoch, evidence)
    this.blockers.delete(ticketId)
  }
  /** Rechecks one reviewed lease using trusted evidence; the operator cannot supply a clearance assertion. */
  async recheckRecovery(leaseId: string, executionEpoch: string): Promise<RecoveryCheck> {
    const lease = this.data.leases().find(lease => lease.id === leaseId)
    if (!lease || lease.releasedAt || lease.executionEpoch !== executionEpoch) throw new DirectoryRecoveryConflict()
    if (lease.recovery === 'cleared') return { cleared: true, detail: 'Process recovery is already cleared; ordinary admission and filesystem-effect checks still apply.' }
    if (!this.host.safety?.processes) return { cleared: false, detail: 'No trusted durable process-owner provider is installed. Ownership remains quarantined; install the verified supervisor integration before rechecking.' }
    if (!lease.processOwner) return { cleared: false, detail: 'No durable process owner was recorded for this lease. Ownership remains quarantined; the supervisor integration must establish the old execution range before recovery.' }
    const evidence = await this.host.safety.processes.proveQuiescent(lease, lease.processOwner)
    // Evidence belongs to the exact fenced snapshot, not just a Ticket ID. A concurrent review or lifecycle
    // change must not allow an old asynchronous proof to clear a newer fence or execution range.
    const current = this.data.leases().find(current => current.id === leaseId)
    if (JSON.stringify(current) !== JSON.stringify(lease) || this.host.signal.aborted) throw new DirectoryRecoveryConflict()
    if (!evidence?.trim()) return { cleared: false, detail: 'The process-owner provider could not prove the entire managed range empty. Ownership remains quarantined; verify all managed descendants have stopped, then recheck.' }
    this.data.clearRecovery(lease.id, executionEpoch, this.epoch, evidence)
    this.blockers.delete(lease.ticketId)
    const interrupted = lease.preparation.state === 'started' || lease.preparation.state === 'failed'
      || lease.recycling?.state === 'started' || lease.recycling?.state === 'failed'
    return { cleared: true, detail: interrupted
      ? 'Process quiescence verified. Interrupted or failed filesystem effects still require reconciliation; hooks will not be replayed.'
      : 'Process quiescence verified. The Executor will recheck ordinary admission; directory ownership and affinity are retained.' }
  }
  /** Startup recovery uses the same trusted evidence checks as an operator recheck. */
  async recover(): Promise<void> {
    for (const lease of this.data.leases().filter(lease => !lease.releasedAt && lease.recovery !== 'cleared')) {
      await this.recheckRecovery(lease.id, lease.executionEpoch)
    }
  }
}
