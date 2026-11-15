/** Semantic discovery and acceptance are independent from directory allocation and scheduling. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { PlacementContexts } from '../src/app/placement.ts'
import { Engine, UserError, type Outcome, type Policy, type Trigger } from '../src/core/index.ts'
import { AssessmentSchema, MasterAssessor } from '../src/app/assessment.ts'
import type { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { assessmentOutcome, SettingsSchema } from '../src/policy.ts'

let directory: string, store: Store, contexts: PlacementContexts
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-placement-'))
  store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(SettingsSchema.parse({ executor: { directoryPools: [{ id: 'frontend', description: 'UI work', directories: [] }] } }))
  contexts = new PlacementContexts(store)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const placement = (poolId = 'frontend') => ({ poolId, reason: 'UI requirements match', contextVersion: contexts.current().version })
const accept = (): Extract<Outcome, { kind: 'accept' }> => ({ kind: 'accept', title: 'Fix UI', scope: 'requested UI fix', reason: 'requested',
  acknowledgement: 'I will fix the UI.', placement: placement(), name: 'fix-ui' })
function harness(strength: 'explicit' | 'inferred' = 'explicit') {
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const assessor = { request: vi.fn(), release: vi.fn() }
  const policy: Policy = { version: 'p1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength, basis: { via: 'followup' } }), revalidate: () => true, admitsInferred: () => true }
  const validatePlacement = vi.fn(value => contexts.validate(value))
  const engine = new Engine({ repo: store, scope: { scope: () => ({ listened: true, observed: true }) }, policy: () => policy,
    executor, outbox, assessor, validatePlacement,
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: { name: outcome.name!, assignment: outcome.scope } }) })
  const trigger: Trigger = { id: 'request', source: 'chat', threads: [{ source: 'chat', id: 'thread' }], actor: { source: 'chat', id: 'alice' },
    human: true, at: new Date().toISOString(), text: 'Please fix UI', meta: {} }
  engine.receive(trigger); engine.evaluateDue()
  return { engine, executor, outbox, assessor, validatePlacement, trigger, policy }
}

it('retains immutable semantic snapshots and exact instruction revisions, without operational fields', () => {
  const first = contexts.current()
  expect(Object.keys(first).sort()).toEqual(['instructionRevision', 'instructions', 'pools', 'version'])
  expect(first.pools).toEqual([{ id: 'default', description: expect.any(String) }, { id: 'frontend', description: 'UI work' }])
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, directory: '/private/root', maxWorkers: 6, prepare: 'secret hook',
    directoryPools: [{ ...settings.executor.directoryPools[0]!, directories: [{ id: 'secret-id', path: '/private/inventory' }], recycle: 'secret recycle' }] } })
  expect(contexts.current()).toEqual(first)
  expect(JSON.stringify(first)).not.toMatch(/secret|private|maxWorkers|allocation|directories|queue/)
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, defaultPoolDescription: 'Different semantic meaning' } })
  const second = contexts.current()
  expect(second.version).not.toBe(first.version)
  expect(second.instructionRevision).toBe(first.instructionRevision)
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, placementInstructions: 'Choose frontend for all UI.' } })
  expect(contexts.current().instructionRevision).not.toBe(first.instructionRevision)
  first.pools[0]!.description = 'mutated caller object'
  expect(contexts.get(second.version)).toEqual(second)
  expect(contexts.get(first.version)?.pools[0]!.description).not.toBe('mutated caller object')
  expect(new PlacementContexts(store).get(second.version)).toEqual(second)
})

it('retains published snapshots across reopening the state database', () => {
  const snapshot = contexts.current()
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  contexts = new PlacementContexts(store)
  expect(contexts.get(snapshot.version)).toEqual(snapshot)
  expect(contexts.current()).toEqual(snapshot)
})

for (const strength of ['explicit', 'inferred'] as const) describe(`${strength} acceptance`, () => {
  it('accepts a known empty pool, records placement plus exact snapshot, and leaves directory absent', () => {
    const h = harness(strength), outcome = accept(), snapshot = contexts.current()
    const decision = h.engine.decide(h.trigger.id, outcome)
    expect(store.tickets.get(decision.ticketId!)!).toMatchObject({ placement: outcome.placement, placementContext: snapshot,
      execution: { name: 'fix-ui', assignment: 'requested UI fix' } })
    expect(store.tickets.get(decision.ticketId!)!.execution).not.toHaveProperty('directory')
    expect(h.validatePlacement).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it.each([undefined, null, {}, { poolId: 'default' }, { poolId: 'default', reason: ' ', contextVersion: 'v1' },
    { poolId: 'default', reason: 'ok', contextVersion: 'v1', directory: '/unsafe' }])('refuses malformed placement %j without consuming candidate', invalid => {
    const h = harness(strength), candidate = h.engine.candidate(h.trigger.id)
    expect(() => h.engine.decide(h.trigger.id, { ...accept(), placement: invalid } as Outcome)).toThrow(new UserError('invalidPlacement'))
    expect(h.engine.candidate(h.trigger.id)?.evalId).toBe(candidate?.evalId)
    expect(store.tickets.list()).toEqual([])
    expect(store.decisions.byThread('chat:thread')).toEqual([])
    expect(h.outbox.send).not.toHaveBeenCalled()
    expect(h.executor.start).not.toHaveBeenCalled()
    expect(h.assessor.release).not.toHaveBeenCalled()
  })
  it('refuses stale/unknown versions and unknown pools atomically, then accepts with refreshed context', () => {
    const h = harness(strength), outcome = accept(), candidate = h.engine.candidate(h.trigger.id)!
    store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, placementInstructions: 'A new rule' } })
    for (const contextVersion of [outcome.placement.contextVersion, 'unknown-version']) {
      expect(() => h.engine.decide(h.trigger.id, { ...outcome, placement: { ...outcome.placement, contextVersion } })).toThrow('stale or unknown')
    }
    expect(() => h.engine.decide(h.trigger.id, { ...outcome, placement: placement('missing') })).toThrow('Unknown execution directory pool')
    expect(store.tickets.list()).toEqual([])
    expect(store.decisions.byThread('chat:thread')).toEqual([])
    expect(h.engine.candidate(h.trigger.id)?.evalId).toBe(candidate.evalId)
    expect(h.outbox.send).not.toHaveBeenCalled()
    expect(h.executor.start).not.toHaveBeenCalled()
    expect(h.assessor.release).not.toHaveBeenCalled()
    expect(h.engine.decide(h.trigger.id, { ...outcome, placement: placement() }).kind).toBe('accept')
  })
  it('returns original accepted result before current placement, policy and finished eval validation', () => {
    const h = harness(strength), outcome = accept(), evalId = h.engine.candidate(h.trigger.id)!.evalId
    const decision = h.engine.decide(h.trigger.id, { ...outcome, evalId })
    const original = store.tickets.get(decision.ticketId!)
    store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, directoryPools: [], placementInstructions: 'Retired pool' } })
    h.policy.version = 'changed-policy'
    h.validatePlacement.mockImplementation(() => { throw new Error('Current validation must not run') })
    expect(h.engine.decide(h.trigger.id, { ...outcome, evalId, placement: { poolId: 'different-retired-pool', reason: 'different', contextVersion: 'stale' } })).toEqual(decision)
    expect(store.tickets.get(decision.ticketId!)).toEqual(original)
    expect(h.validatePlacement).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
})

it('proactive assessor rejects stale placement without ending the Eval, retries and replays without a live candidate', async () => {
  const h = harness('inferred')
  let settings = SettingsSchema.parse({ eval: { mode: 'auto' } })
  const assessor = new MasterAssessor({ engine: h.engine, commands: {} as Commands, deployment: testDeployment(),
    settings: () => settings, paused: () => false, threadContext: () => undefined,
    effects: { enqueue: () => {}, handle: () => {} }, deliver: async () => {}, candidateCard: async () => ({}),
    placementContext: () => contexts.current(), accepted: triggerId => {
      const decision = store.decisions.byThread('chat:thread').find(item => item.kind === 'accept' && item.triggerIds.includes(triggerId))
      return decision?.ticketId ? { ticketId: decision.ticketId, reason: 'original accepted reason' } : undefined
    } })
  const result = AssessmentSchema.parse({ decision: 'accept', title: 'Fix UI', worktree_name: 'fix-ui', scope: 'small', reason: 'request',
    intent_evidence: 'quote', placement: placement(),
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'quote' },
    rule_assessments: settings.policy.rules.map(rule => ({ rule_id: rule.id, matched: true, reason: 'matched' })) })
  expect((await assessor.context(h.trigger.id)).placement).toEqual(contexts.current())
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, placementInstructions: 'Updated rules' } })
  await expect(assessor.decide(h.trigger.id, result)).rejects.toThrow('stale or unknown')
  expect(h.engine.candidate(h.trigger.id)).toBeDefined()
  expect(store.tickets.list()).toEqual([])
  const accepted = await assessor.decide(h.trigger.id, { ...result, placement: placement() })
  settings = SettingsSchema.parse({ eval: { mode: 'off' }, policy: { rules: [] } })
  expect(await assessor.decide(h.trigger.id, { ...result, placement: { poolId: 'retired', reason: 'changed', contextVersion: 'old' } }))
    .toEqual({ state: 'accept', ticket_id: accepted.ticket_id, reason: 'original accepted reason' })
  expect(store.tickets.list()).toHaveLength(1)
  expect(h.executor.start).toHaveBeenCalledOnce()
})

it('requires nested placement in proactive schemas and propagates all placement metadata into outcomes', () => {
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' } })
  const result = { decision: 'accept' as const, title: 'Fix UI', worktree_name: 'fix-ui', scope: 'small', reason: 'request', intent_evidence: 'quote',
    direction: { implementation_requested: true, target_basis: 'specified' as const, requires_design_decision: false, evidence: 'quote' },
    rule_assessments: settings.policy.rules.map(rule => ({ rule_id: rule.id, matched: true, reason: 'matched' })) }
  expect(AssessmentSchema.safeParse(result).success).toBe(false)
  for (const bad of [{ ...placement(), path: '/arbitrary' }, { ...placement(), reason: '' }, { poolId: 'default' }]) {
    expect(AssessmentSchema.safeParse({ ...result, placement: bad }).success).toBe(false)
  }
  const valid = AssessmentSchema.parse({ ...result, placement: placement() })
  expect(assessmentOutcome(valid, settings, 'inferred')).toMatchObject({ kind: 'accept', placement: valid.placement })
  for (const decision of ['ignore', 'unavailable']) expect(AssessmentSchema.safeParse({ ...result, decision }).success).toBe(true)
})
