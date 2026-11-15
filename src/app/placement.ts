/** Immutable semantic placement discovery. Operational pool configuration never enters these snapshots. */
import { createHash } from 'node:crypto'
import { UserError, validPoolPlacement, type PlacementContext, type PoolPlacement } from '../core/index.ts'
import type { Store } from './store.ts'

type PlacementStore = Pick<Store, 'db' | 'atomic' | 'settings'>
const revision = (kind: string, value: unknown) => `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

/** Publishes and retains bounded semantic snapshots in the same database/transaction as acceptance. */
export class PlacementContexts {
  constructor(private readonly store: PlacementStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS placement_instruction (revision TEXT PRIMARY KEY, instructions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS placement_context (version TEXT PRIMARY KEY, instruction_revision TEXT NOT NULL, value TEXT NOT NULL)`)
  }
  /** Only instructions and selectable pool IDs/descriptions contribute to the immutable version. */
  current(): PlacementContext {
    return this.store.atomic(() => {
      const { placementInstructions: instructions, defaultPoolDescription, directoryPools } = this.store.settings().executor
      const instructionRevision = revision('placement-instructions', instructions)
      const pools = [{ id: 'default', description: defaultPoolDescription }, ...directoryPools.map(({ id, description }) => ({ id, description }))]
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const version = revision('placement-context', { instructionRevision, pools })
      const context: PlacementContext = { version, instructionRevision, instructions, pools }
      this.store.db.prepare('INSERT OR IGNORE INTO placement_instruction VALUES (?,?)').run(instructionRevision, instructions)
      this.store.db.prepare('INSERT OR IGNORE INTO placement_context VALUES (?,?,?)').run(version, instructionRevision, JSON.stringify(context))
      return this.get(version)!
    })
  }
  /** Historical snapshots remain available for audit, but cannot authorize a new acceptance. */
  get(version: string): PlacementContext | undefined {
    const row = this.store.db.prepare('SELECT value FROM placement_context WHERE version=?').get(version)
    return row ? JSON.parse(String(row.value)) as PlacementContext : undefined
  }
  /** Called synchronously by Engine inside acceptance; already accepted replays never reach this check. */
  validate(placement: PoolPlacement): PlacementContext {
    if (!validPoolPlacement(placement)) throw new UserError('invalidPlacement')
    const current = this.current()
    if (placement.contextVersion !== current.version) throw new UserError('stalePlacementContext')
    if (!current.pools.some(pool => pool.id === placement.poolId)) throw new UserError('unknownPlacementPool', { pool: placement.poolId })
    return current
  }
}
