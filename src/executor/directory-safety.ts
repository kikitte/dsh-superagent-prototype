/** Host integrations must supply authoritative admission and durable process-owner evidence, never inferred idleness. */
import type { DirectoryLeaseRecord } from '../app/directory-store.ts'
export interface Occupancy { state: 'clear' | 'occupied' | 'unknown'; revision: string; detail: string; sessions?: { id: string; reasons: string[] }[] }
export interface DirectoryAdmission {
  /** Covers every runtime/client permitted to share inventory; retained views/history are not presence. */
  observe(path: string, gitRoot: string | undefined, ticketId: string): Occupancy
  /** The host serializes starts/workspace changes/rendered-view opens with this synchronous commit. */
  commit<T>(observation: Occupancy, path: string, gitRoot: string | undefined, ticketId: string, operation: () => T): T
  /** Valid throughout filesystem effects/turns. A conflicting transition fences and awaits managed quiescence first. */
  assertUse(lease: DirectoryLeaseRecord): void
  subscribe(wake: () => void): () => void
}
export interface ProcessOwner {
  /** Called and persisted before the lease's first external effect. Must include hooks and all worker descendants. */
  contain(lease: DirectoryLeaseRecord): Promise<string>
  /** Independently verifies the entire named old execution range is empty; missing handles are not evidence. */
  proveQuiescent(lease: DirectoryLeaseRecord, owner: string): Promise<string | undefined>
}
export interface DirectorySafety { admission?: DirectoryAdmission; processes?: ProcessOwner }
export const UNKNOWN_OCCUPANCY: Occupancy = { state: 'unknown', revision: 'unsupported', detail: 'Authoritative cross-runtime Session-view presence and coordinated admission are unavailable. Fixed inventory is fenced; default is unaffected.' }
