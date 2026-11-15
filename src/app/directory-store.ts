/** Durable Executor-owned allocation records. No filesystem effects occur in these transactions. */
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import type { Settings } from '../policy.ts'
import type { DirectoryLease, GitWorktreeClaim, TicketDirectoryAffinity } from '../core/directories.ts'
import { canonicalDirectory } from './directory-settings.ts'

export interface DirectoryRecord { id: string; poolId: string; path: string; retired?: boolean; lastLeaseSequence: number; createdAt: string }
export interface DirectoryLeaseRecord extends DirectoryLease {
  acquiredAt: string; releasedAt?: string; error?: string; processOwner?: string; managedActivity?: boolean
  preparation: { state: 'intent' | 'started' | 'complete' | 'failed'; startedAt?: string; completedAt?: string; error?: string }
  recycling?: { state: 'intent' | 'started' | 'complete' | 'failed'; startedAt?: string; completedAt?: string; error?: string }
  quiescence?: { evidence: string; at: string; executionEpoch: string }
}
export interface WorktreeClaimRecord extends GitWorktreeClaim { releasedAt?: string }
/** Persists directory identities, FIFO requests, lease history, affinity and atomic exclusive Git resource claims. */
export class DirectoryStore {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic' | 'tickets'>) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_directory (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_pool_identity (id TEXT PRIMARY KEY, retired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS directory_lease (id TEXT PRIMARY KEY, directoryId TEXT NOT NULL, ticketId TEXT NOT NULL,
        releasedAt TEXT, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS directory_lease_owner ON directory_lease(directoryId) WHERE releasedAt IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ticket_lease_owner ON directory_lease(ticketId) WHERE releasedAt IS NULL;
      CREATE TABLE IF NOT EXISTS git_worktree_claim (leaseId TEXT PRIMARY KEY, root TEXT NOT NULL, gitDirectory TEXT,
        releasedAt TEXT, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS git_root_owner ON git_worktree_claim(root) WHERE releasedAt IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS git_metadata_owner ON git_worktree_claim(gitDirectory) WHERE releasedAt IS NULL AND gitDirectory IS NOT NULL;
      CREATE TABLE IF NOT EXISTS directory_sequence (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO directory_sequence VALUES (1,0);
      CREATE TABLE IF NOT EXISTS directory_queue (ticketId TEXT PRIMARY KEY, assignmentId TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE);
    `)
  }
  private values<T>(table: string): T[] { return this.store.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.value)) as T) }
  records(): DirectoryRecord[] { return this.values('execution_directory') }
  leases(): DirectoryLeaseRecord[] { return this.values('directory_lease') }
  claims(): WorktreeClaimRecord[] { return this.values('git_worktree_claim') }
  affinity(ticketId: string): TicketDirectoryAffinity | undefined { return this.store.tickets.get(ticketId)?.directoryAffinity }
  leaseForTicket(ticketId: string): DirectoryLeaseRecord | undefined { return this.leases().find(lease => lease.ticketId === ticketId && !lease.releasedAt) }
  referenced(directoryId: string): boolean { return this.leases().some(lease => lease.directoryId === directoryId) || this.store.tickets.list().some(ticket => ticket.directoryAffinity?.directoryId === directoryId) }
  saveRecord(record: DirectoryRecord): void {
    this.store.db.prepare('INSERT INTO execution_directory VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,value=excluded.value').run(record.id, record.path, JSON.stringify(record))
  }
  poolRetired(id: string): boolean { return this.store.db.prepare('SELECT retired FROM execution_pool_identity WHERE id=?').get(id)?.retired === 1 }
  syncInventory(settings: Settings['executor']): void {
    this.store.atomic(() => {
      for (const pool of settings.directoryPools) {
        if (this.poolRetired(pool.id)) throw new Error(`Pool ID ${pool.id} is retired; choose a new stable ID`)
        this.store.db.prepare('INSERT OR IGNORE INTO execution_pool_identity VALUES (?,0)').run(pool.id)
      }
      for (const row of this.store.db.prepare('SELECT id FROM execution_pool_identity WHERE retired=0').all()) {
        if (!settings.directoryPools.some(pool => pool.id === row.id)) this.store.db.prepare('UPDATE execution_pool_identity SET retired=1 WHERE id=?').run(row.id!)
      }
      const next = settings.directoryPools.flatMap(pool => pool.directories.map(directory => ({ ...directory, path: canonicalDirectory(directory.path), poolId: pool.id })))
      for (const record of this.records().filter(record => record.poolId !== 'default')) {
        const entry = next.find(entry => entry.id === record.id)
        if (entry && (record.path !== entry.path || record.poolId !== entry.poolId) && this.referenced(record.id)) throw new Error(`Directory ${record.id} has retained lease/affinity history; register a replacement ID`)
        if (!entry && this.leases().some(lease => lease.directoryId === record.id && !lease.releasedAt)) throw new Error(`Directory ${record.id} still has an unreleased lease`)
        this.saveRecord({ ...record, ...entry, retired: !entry })
      }
      for (const entry of next) if (!this.records().some(record => record.id === entry.id)) this.saveRecord({ ...entry, lastLeaseSequence: 0, createdAt: new Date().toISOString() })
    })
  }
  enqueue(ticketId: string, assignmentId: string): void {
    this.store.db.prepare(`INSERT INTO directory_queue VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM directory_queue))
      ON CONFLICT(ticketId) DO UPDATE SET assignmentId=excluded.assignmentId`).run(ticketId, assignmentId)
  }
  queue(): { ticketId: string; assignmentId: string; seq: number }[] { return this.store.db.prepare('SELECT * FROM directory_queue ORDER BY seq').all() as unknown as { ticketId: string; assignmentId: string; seq: number }[] }
  dequeue(ticketId: string): void { this.store.db.prepare('DELETE FROM directory_queue WHERE ticketId=?').run(ticketId) }
  saveLease(lease: DirectoryLeaseRecord): void {
    this.store.db.prepare(`INSERT INTO directory_lease VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET releasedAt=excluded.releasedAt,value=excluded.value`).run(lease.id, lease.directoryId, lease.ticketId, lease.releasedAt ?? null, JSON.stringify(lease))
  }
  saveClaim(claim: WorktreeClaimRecord): void {
    this.store.db.prepare(`INSERT INTO git_worktree_claim VALUES (?,?,?,?,?) ON CONFLICT(leaseId) DO UPDATE SET root=excluded.root,gitDirectory=excluded.gitDirectory,releasedAt=excluded.releasedAt,value=excluded.value`).run(claim.leaseId, claim.root, claim.gitDirectory ?? null, claim.releasedAt ?? null, JSON.stringify(claim))
  }
  /** Returns undefined on a reservation race; rollback includes affinity and LRU. */
  reserve(ticketId: string, record: DirectoryRecord, executionEpoch: string, claim?: Omit<GitWorktreeClaim, 'leaseId'>): DirectoryLeaseRecord | undefined {
    return this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (!ticket || ticket.ended) return undefined
      const owned = this.leaseForTicket(ticketId)
      if (owned) return owned
      const affinity = ticket.directoryAffinity
      if (affinity && (affinity.directoryId !== record.id || affinity.poolId !== record.poolId || affinity.path !== record.path)) throw new Error('Directory affinity cannot change')
      if (this.leases().some(lease => !lease.releasedAt && (lease.directoryId === record.id || overlaps(lease.path, record.path)))) return undefined
      if (claim && this.claims().some(owner => !owner.releasedAt && (owner.root === claim.root || claim.gitDirectory && owner.gitDirectory === claim.gitDirectory))) return undefined
      this.store.db.prepare('UPDATE directory_sequence SET value=value+1 WHERE id=1').run()
      const sequence = Number(this.store.db.prepare('SELECT value FROM directory_sequence WHERE id=1').get()!.value)
      const lease: DirectoryLeaseRecord = { id: randomUUID(), directoryId: record.id, ticketId, poolId: record.poolId, path: record.path,
        executionEpoch, recovery: 'cleared', state: 'reserved', acquiredAt: new Date().toISOString(), preparation: { state: 'intent' } }
      this.saveRecord({ ...record, lastLeaseSequence: sequence }); this.saveLease(lease)
      if (claim) this.saveClaim({ ...claim, leaseId: lease.id })
      this.store.tickets.save({ ...ticket, directoryAffinity: { poolId: record.poolId, directoryId: record.id, path: record.path },
        ...(ticket.execution ? { execution: { ...ticket.execution, directory: record.path } } : {}) })
      return lease
    })
  }
  /** Epoch compare-and-set rejects old completions, even after another owner acquired the directory. */
  update(id: string, epoch: string, change: (lease: DirectoryLeaseRecord) => DirectoryLeaseRecord): DirectoryLeaseRecord {
    return this.store.atomic(() => {
      const current = this.leases().find(lease => lease.id === id)
      if (!current || current.releasedAt || current.executionEpoch !== epoch || current.recovery !== 'cleared') throw new Error('Directory lease is released, stale, or recovery-fenced')
      const next = change(current); this.saveLease(next); return next
    })
  }
  fencePriorEpoch(epoch: string): void {
    this.store.atomic(() => { for (const lease of this.leases()) if (!lease.releasedAt && lease.executionEpoch !== epoch) this.saveLease({ ...lease, recovery: 'quarantined', error: 'Old execution range has not been proven empty. Supply verified supervisor/process-owner evidence before recovery.' }) })
  }
  clearRecovery(id: string, oldEpoch: string, newEpoch: string, evidence: string): void {
    this.store.atomic(() => {
      const lease = this.leases().find(lease => lease.id === id)
      if (!lease || lease.releasedAt || lease.recovery === 'cleared' || lease.executionEpoch !== oldEpoch || !evidence.trim()) throw new Error('Stale or invalid recovery evidence')
      // Interrupted external effects are not replayed automatically, even after processes stopped.
      this.saveLease({ ...lease, executionEpoch: newEpoch, recovery: 'cleared', quiescence: { evidence, at: new Date().toISOString(), executionEpoch: oldEpoch },
        ...(lease.preparation.state === 'started' ? { preparation: { ...lease.preparation, state: 'failed', error: 'Interrupted preparation requires reconciliation; creation hook will not be replayed' } } : {}),
        ...(lease.recycling?.state === 'started' ? { recycling: { ...lease.recycling, state: 'failed', error: 'Interrupted recycling requires reconciliation; hook will not be replayed' } } : {}), error: undefined })
    })
  }
  release(id: string, epoch: string, evidence: string): void {
    this.store.atomic(() => {
      const lease = this.leases().find(lease => lease.id === id)
      if (lease?.releasedAt) return
      this.update(id, epoch, current => {
        if (current.state !== 'releasing' || !evidence.trim()) throw new Error('Safe release requires releasing state and verified quiescence')
        const releasedAt = new Date().toISOString()
        const claim = this.claims().find(claim => claim.leaseId === id)
        if (claim) this.saveClaim({ ...claim, releasedAt })
        return { ...current, releasedAt, quiescence: { evidence, at: releasedAt, executionEpoch: epoch } }
      })
    })
  }
}
export const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(right === '/' ? '/' : `${right}/`) || right.startsWith(left === '/' ? '/' : `${left}/`)
