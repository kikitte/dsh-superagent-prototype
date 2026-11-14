/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForTreeWork: (agent: Agent) => Promise<boolean>, interrupt: (id: string) => void = () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const child = { id: 'child-1', ctx: new Context(), inbox: { clear: vi.fn() }, cancel: vi.fn() }
  const subagents = { waitForTreeWork: vi.fn(waitForTreeWork),
    listDescendants: vi.fn<() => Promise<{ id: string; kind?: string; mode?: string }[]>>(async () => [{ id: child.id }]), interrupt: vi.fn(interrupt) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: (id: string) => id === agent.id ? agent : id === child.id ? child : undefined } } as unknown as Context
  return { ctx, agent, child, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForTreeWork).toHaveBeenCalledTimes(1)
  expect(subagents.waitForTreeWork).toHaveBeenCalledWith(agent)
})

it('bounds convergence after fire-and-return interrupts to 10 seconds, and cancels the worker turn', async () => {
  const { ctx, agent, child, subagents } = setup(() => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(subagents.listDescendants).toHaveBeenCalledWith(agent.id)
  expect(subagents.interrupt).toHaveBeenCalledWith(child.id, { kind: 'ancestor', agent })
  expect(child.inbox.clear).toHaveBeenCalledOnce()
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('interrupts external catalog members without local Agents and keeps the worker inbox when requested', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  subagents.listDescendants.mockResolvedValue([{ id: 'external-1', kind: 'child', mode: 'external' }])
  await stopSubagents(ctx, agent, true)
  expect(subagents.interrupt).toHaveBeenCalledWith('external-1', { kind: 'ancestor', agent })
  expect(subagents.waitForTreeWork).toHaveBeenCalledWith(agent)
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
})

/** A driver double with real scoped event dispatch, waking delivery, and asynchronous cancellation/settlement. */
function member(id: string, finishTurn: Promise<void> = Promise.resolve()) {
  const ctx = new Context()
  const work = vi.fn()
  const inbox = { nextTurn: [] as { id: string }[], nextStep: [] as { id: string }[], clear: vi.fn(() => {
    inbox.nextTurn.length = 0; inbox.nextStep.length = 0
  }) }
  let abort: AbortController | undefined, idle = Promise.resolve(), wakeRequested = false
  const child = { id, ctx, status: 'idle', inbox, whenIdle: () => idle,
    cancel: vi.fn((_cause: unknown, options?: { keepInbox?: boolean }) => {
      if (!options?.keepInbox) { inbox.clear(); wakeRequested = false }
      abort?.abort()
    }),
  }
  const events = agentEvents(ctx, child as unknown as Agent)
  const wake = () => {
    if (child.status !== 'idle') return
    const activity = Promise.withResolvers<void>()
    idle = activity.promise
    const turn = abort = new AbortController()
    child.status = 'running'
    events.emit('agent/status', { status: 'running' })
    void (async () => {
      // As in DSH, a synchronous running listener can cancel before the new driver executes.
      if (!turn.signal.aborted) work()
      await finishTurn
      child.status = 'idle'
      events.emit('agent/status', { status: 'idle' })
      if (wakeRequested && inbox.nextTurn.length) { wakeRequested = false; wake() }
      activity.resolve()
    })()
  }
  const deliver = () => {
    const wakingAfterAbort = child.status !== 'idle' && !!abort?.signal.aborted
    const message = { id: `notice-${inbox.nextTurn.length}` }
    inbox.nextTurn.push(message)
    events.emit('agent/inbox/inserted', { message: message as never })
    // DSH wakes even if an inserted listener cleared an idle inbox. Aborted drivers instead latch a replay.
    if (child.status === 'idle') wake()
    else if (wakingAfterAbort) wakeRequested = true
  }
  return { child, work, deliver, events }
}

it.each([false, true])('prevents late grandchild notices from restarting a retiring child (join timed out: %s)', async timedOut => {
  const cleanup = Promise.withResolvers<boolean>()
  const { ctx, agent, subagents } = setup(() => cleanup.promise)
  const parent = member('child-1'), grandchild = member('grandchild-1')
  const agents = new Map([[parent.child.id, parent.child], [grandchild.child.id, grandchild.child]])
  ctx.agents.get = ((id: string) => id === agent.id ? agent : agents.get(id)) as typeof ctx.agents.get
  subagents.listDescendants.mockResolvedValue([{ id: parent.child.id }, { id: grandchild.child.id }])
  subagents.interrupt.mockImplementation((id: string) => { agents.get(id)?.cancel({ kind: 'parent' }, { keepInbox: true }) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const stopping = stopSubagents(ctx, agent)
    // Cancellation leaves a resident, idle parent while descendant cleanup is still pending.
    await vi.advanceTimersByTimeAsync(timedOut ? 10_000 : 0)
    if (timedOut) await stopping
    parent.deliver()
    await parent.child.whenIdle()
    expect(parent.work).not.toHaveBeenCalled()
    expect(parent.child.status).toBe('idle')
    expect(parent.child.inbox.nextTurn).toEqual([])
    cleanup.resolve(true)
    await stopping
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    // A later same-id Activation is not retired; the reusable root remains free to delegate again.
    const replacement = member(parent.child.id)
    parent.child.ctx.emit('agent/status', { agent: replacement.child, status: 'running' } as never)
    expect(replacement.child.cancel).not.toHaveBeenCalled()
    replacement.deliver()
    await replacement.child.whenIdle()
    expect(replacement.work).toHaveBeenCalledOnce()
  } finally { cleanup.resolve(true); vi.useRealTimers() }
})

it('discards notices arriving while a cancelled descendant is still finishing its driver', async () => {
  const finishing = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<boolean>()
  const { ctx, agent, subagents } = setup(() => cleanup.promise)
  const parent = member('child-1', finishing.promise)
  parent.deliver()
  expect(parent.work).toHaveBeenCalledOnce()
  parent.work.mockClear()
  ctx.agents.get = ((id: string) => id === agent.id ? agent : id === parent.child.id ? parent.child : undefined) as typeof ctx.agents.get
  subagents.interrupt.mockImplementation(() => { parent.child.cancel({ kind: 'parent' }, { keepInbox: true }) })
  const stopping = stopSubagents(ctx, agent)
  await Promise.resolve()
  expect(parent.child.status).toBe('running')
  parent.deliver()
  expect(parent.child.inbox.nextTurn).toEqual([])
  finishing.resolve()
  await parent.child.whenIdle()
  cleanup.resolve(true)
  await stopping
  expect(parent.work).not.toHaveBeenCalled()
  expect(parent.child.status).toBe('idle')
})

it('still interrupts other descendants and cancels the worker if one interrupt fails', async () => {
  const failure = new Error('INTERRUPT_FAILED')
  const { ctx, agent, subagents } = setup(async () => false, () => { throw failure })
  subagents.listDescendants.mockResolvedValue([{ id: 'external-1', kind: 'child', mode: 'external' }, { id: 'child-1' }])
  await expect(stopSubagents(ctx, agent)).rejects.toThrow('Interrupting the subagents')
  expect(subagents.interrupt).toHaveBeenCalledTimes(2)
  expect(subagents.waitForTreeWork).toHaveBeenCalledWith(agent)
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})
