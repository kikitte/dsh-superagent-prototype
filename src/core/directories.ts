/** Pure execution-directory contracts. Placement is semantic; allocation and ownership belong to the Executor. */
export type DirectoryPool =
  | { id: 'default'; description: string; allocation: { kind: 'per-ticket'; root: string } }
  | { id: string; description: string; allocation: { kind: 'fixed'; directories: { id: string; path: string }[] } }

/** Acceptance selects a pool, never an execution directory or worker slot. */
export interface PoolPlacement { poolId: string; reason: string; contextVersion: string }
/** Immutable semantic snapshot, excluding allocation policy, paths, inventory and scheduling metrics. */
export interface PlacementContext {
  version: string
  instructionRevision: string
  instructions: string
  pools: { id: string; description: string }[]
}
/** Permanent affinity survives safe lease release. */
export interface TicketDirectoryAffinity { poolId: string; directoryId: string; path: string }
/** Exclusive ownership persists through preparation, waiting, recovery and recycling. */
export interface DirectoryLease {
  id: string; directoryId: string; ticketId: string; poolId: string; path: string
  state: 'reserved' | 'preparing' | 'active' | 'releasing'
  executionEpoch: string
  recovery: 'cleared' | 'required' | 'quarantined'
}
/** Additional exclusive resource; linked worktrees have distinct worktree-specific metadata. */
export interface GitWorktreeClaim { leaseId: string; root: string; gitDirectory?: string; state: 'reserved' | 'verified' }
export interface DirectoryUsage { directoryId: string; lastLeaseSequence: number }

/** Structural check shared by direct Engine callers and application schemas; rejects directory/scheduling inputs. */
export function validPoolPlacement(value: unknown): value is PoolPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = Object.keys(value)
  return fields.length === 3 && ['poolId', 'reason', 'contextVersion'].every(field => fields.includes(field)
    && typeof (value as Record<string, unknown>)[field] === 'string'
    && ((value as Record<string, string>)[field]?.trim().length ?? 0) > 0)
    && (value as PoolPlacement).poolId.length <= 80 && (value as PoolPlacement).reason.length <= 1000
    && (value as PoolPlacement).contextVersion.length <= 200
}
