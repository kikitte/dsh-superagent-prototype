import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const host = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const model = new AgentModel(() => session.snapshotEvents().reduce(
    (state, event) => modelSelectionProjectionDefinition.apply(state, event),
    { lastUsed: null, pending: null } as ReturnType<typeof modelSelectionProjectionDefinition.init>), session, host)
  const select = vi.spyOn(model, 'select')
  const agent = { ctx, session, model } as unknown as Agent
  return { ctx, agent, host, resolve, flush, select }
}
it('selects the role model through the Session model API without saving the host default', async () => {
  const { agent, host, select, flush } = fixture()
  await initializeRoleModel(agent.ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect(select).toHaveBeenCalledWith({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(host).toEqual({ provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') })
  expect(flush).toHaveBeenCalledOnce()
})
it('lets a later explicit selection win and does not seed the Session again', async () => {
  const { ctx, agent, resolve } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(agent.model.current()).toEqual(manual)
  expect(resolve).toHaveBeenCalledOnce()
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve, select } = fixture()
  const existing: ModelSelection = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(agent.model.current()).toEqual(existing)
  expect(resolve).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, select, flush } = fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toMatchObject({ provider: 'host', model: 'default' })
  expect(flush).not.toHaveBeenCalled()
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(select).not.toHaveBeenCalled()
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
