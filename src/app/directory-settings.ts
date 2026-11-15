/** Read-only canonical registration checks and transactional directory-inventory lifecycle validation. */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { Settings } from '../policy.ts'
import type { Store } from './store.ts'

type Executor = Settings['executor']
/** Resolve existing symlinks, including the nearest existing parent of a not-yet-created directory. Never creates a path. */
export function canonicalDirectory(path: string): string {
  const absolute = resolve(path)
  let parent = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      const canonical = realpathSync(parent)
      if (!statSync(canonical).isDirectory()) throw new Error(`Not a directory: ${parent}`)
      return join(canonical, ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling symlink is not an absent path whose identity can safely be inferred.
      try { if (lstatSync(parent).isSymbolicLink()) throw new Error(`Dangling directory symlink: ${parent}`) }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe }
      const next = dirname(parent)
      if (next === parent) throw error
      suffix.unshift(basename(parent))
      parent = next
    }
  }
}
/** Directory-boundary overlap, not a textual-prefix comparison. */
export function directoriesOverlap(a: string, b: string): boolean {
  const contains = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !part.startsWith(sep)) }
  return contains(a, b) || contains(b, a)
}
/** Operator-actionable registration/lifecycle refusal, distinct from a malformed form field. */
export class DirectorySettingsError extends Error {}
function invalid(message: string): never { throw new DirectorySettingsError(message) }
/** Must run in the same Store transaction as the settings revision check/save and inventory synchronization. */
export function validateDirectorySettings(store: Pick<Store, 'directories' | 'tickets'>, current: Executor, next: Executor, stateDir?: string): void {
  const canonical = (path: string) => { try { return canonicalDirectory(path) } catch (error) { return invalid(`Cannot resolve ${path}: ${error instanceof Error ? error.message : String(error)}`) } }
  const inventory = next.directoryPools.flatMap(pool => pool.directories.map(directory => ({ ...directory, poolId: pool.id, path: canonical(directory.path) })))
  const root = next.directory || (stateDir ? join(stateDir, 'work') : undefined)
  const canonicalRoot = root ? canonical(root) : undefined
  for (const [index, directory] of inventory.entries()) {
    if (canonicalRoot && directoriesOverlap(canonicalRoot, directory.path)) invalid(`Directory ${directory.id} overlaps the default-pool root`)
    for (const other of inventory.slice(0, index)) if (directoriesOverlap(directory.path, other.path)) invalid(`Directories ${other.id} and ${directory.id} are aliases or overlap`)
  }
  const records = store.directories.records(), leases = store.directories.leases()
  const tickets = store.tickets.list()
  const pools = new Set(next.directoryPools.map(pool => pool.id))
  const previousPools = new Set(current.directoryPools.map(pool => pool.id))
  for (const pool of next.directoryPools) if (store.directories.poolRetired(pool.id) || (!previousPools.has(pool.id) && (records.some(record => record.poolId === pool.id)
    || tickets.some(ticket => ticket.placement?.poolId === pool.id)))) invalid(`Pool ID ${pool.id} is retired and cannot be reused; register a new pool ID`)
  for (const pool of current.directoryPools) {
    const replacement = next.directoryPools.find(item => item.id === pool.id)
    const held = leases.some(lease => lease.poolId === pool.id && !lease.releasedAt)
    if (!pools.has(pool.id) && (held || tickets.some(ticket => !ticket.ended && ticket.placement?.poolId === pool.id))) invalid(`Pool ${pool.id} still has open Ticket selections or unreleased leases`)
    if (held && replacement && (replacement.prepare !== pool.prepare || replacement.recycle !== pool.recycle)) invalid(`Pool ${pool.id} hooks cannot change while a directory lease is unreleased`)
  }
  if (current.prepare !== next.prepare && leases.some(lease => lease.poolId === 'default' && !lease.releasedAt)) invalid('Default preparation cannot change while a directory lease is unreleased')
  for (const record of records) {
    const directory = inventory.find(item => item.id === record.id)
    const path = canonical(record.path)
    const held = leases.some(lease => lease.directoryId === record.id && !lease.releasedAt)
    const referenced = store.directories.referenced(record.id)
    if (directory && (held || referenced) && path !== record.path) invalid(`Directory ${record.id} filesystem identity changed; reconcile its original canonical path before saving`)
    if (!directory && held && record.poolId !== 'default') invalid(`Directory ${record.id} has an unreleased lease or recovery fence`)
    if (directory && (directory.path !== path || directory.poolId !== record.poolId) && (held || referenced || record.retired)) invalid(`Directory ${record.id} has retained history or affinity; register a new ID instead of moving it`)
    if (directory && record.retired) invalid(`Directory ID ${record.id} is retired and cannot be reused`)
    // Historical/dedicated paths remain reserved even after retiring an inventory entry.
    if (referenced || record.retired || held) {
      if (canonicalRoot && directoriesOverlap(path, canonicalRoot) && (record.poolId !== 'default'
        || (relative(path, canonicalRoot) !== '..' && !relative(path, canonicalRoot).startsWith(`..${sep}`)))) invalid(`Default-pool root overlaps retained directory ${record.id}`)
      for (const candidate of inventory) if (candidate.id !== record.id && directoriesOverlap(path, candidate.path)) invalid(`Directory ${candidate.id} overlaps retained directory ${record.id}`)
    }
  }
}
