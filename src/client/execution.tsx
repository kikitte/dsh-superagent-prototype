/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type ApiResponse, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
function DirectoryRecovery({ lease, reload }: {
  lease: NonNullable<ApiResponse<'GET directories'>[number]['lease']>
  reload: () => Promise<void>
}) {
  const { t, call } = usePanel()
  const [result, setResult] = useState<string>()
  const recheck = useAction(async () => {
    const checked = await call('POST directory-leases/:id/recheck-recovery', { id: lease.id, body: { executionEpoch: lease.executionEpoch } })
    setResult(checked.detail)
  }, { reload })
  return <>
    <LabelValue label={t('directoryExecutionEpoch')} value={lease.executionEpoch} />
    <LabelValue label={t('directoryProcessOwner')} value={lease.processOwner ?? t('directoryNoProcessOwner')} />
    {lease.quiescence && <LabelValue label={t('directoryQuiescence')} value={`${lease.quiescence.at} · ${lease.quiescence.evidence}`} />}
    {lease.recovery !== 'cleared' && <>
      <Hint>{t('directoryRecoveryHint')}</Hint>
      <Button variant="outline" size="sm" disabled={recheck.busy} onClick={() => { void recheck.run() }}>{t('directoryRecheckRecovery')}</Button>
    </>}
    {result && <Hint>{result}</Hint>}
  </>
}
function DirectoryDiagnostics() {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const { data, error, reload } = usePoll(() => open ? call('GET directories') : Promise.resolve(undefined), [open])
  const [pool, setPool] = useState('')
  const refresh = useAction(() => call('POST directories/refresh'), { reload })
  const shown = data?.filter(item => !pool || item.directory.poolId === pool)
  return <DisclosureRow icon={<Icon name="hash" />} title={t('directoryDiagnostics')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('directoryDiagnosticsHint')}</Hint>
      <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={refresh.busy}
        onClick={() => { void refresh.run() }}>{t('directoryRefresh')}</Button>
      <Field label={t('directoryPoolFilter')}><select className="dt-select" value={pool} onChange={event => setPool(event.target.value)}>
        <option value="">{t('directoryAllPools')}</option>
        {[...new Set(data?.map(item => item.directory.poolId))].sort().map(id => <option key={id} value={id}>{id}</option>)}
      </select></Field>
      <LoadState error={error} loading={!data} />
      {shown && (shown.length ? <ul className="dt-list">{shown.map(({ directory, lease, git, occupancy, blocker }) => <li key={directory.id} className="dt-form dt-block">
        <strong className="dt-mono">{directory.poolId} / {directory.id}{directory.retired ? ` · ${t('directoryRetired')}` : ''}</strong>
        <code>{directory.path}</code>
        <LabelValue label={t('directoryLease')} value={lease ? `${lease.ticketId} · ${lease.state} · ${lease.recovery}` : t('directoryUnleased')} />
        {lease && <LabelValue label={t('directoryPreparation')} value={lease.preparation.state} />}
        {lease?.recycling && <LabelValue label={t('directoryRecycling')} value={lease.recycling.state} />}
        {lease && <DirectoryRecovery key={lease.id} lease={lease} reload={reload} />}
        {directory.poolId !== 'default' ? <><LabelValue label={t('directoryOccupancy')} value={occupancy.state} /><Hint>{occupancy.detail}</Hint></> : <Hint>{t('directoryDedicatedNoReuseGate')}</Hint>}
        {git && <pre className="dt-detail dt-mono">{JSON.stringify(git, null, 2)}</pre>}
        {blocker && <p className="dt-error">{blocker}</p>}
      </li>)}</ul> : <Hint>{t('none')}</Hint>)}
    </div>
  </DisclosureRow>
}
type Pool = SettingsView['blocks']['executor']['value']['directoryPools'][number]
const nextId = (prefix: string, ids: string[]) => { let n = 1; while (ids.includes(`${prefix}-${n}`)) n++; return `${prefix}-${n}` }
function PoolEditor({ pool, saved, pools, onChange, onRemove, onMove }: {
  pool: Pool; saved: Pool | undefined; pools: Pool[]; onChange: (pool: Pool) => void; onRemove: () => void
  onMove: (directory: Pool['directories'][number], poolId: string) => void
}) {
  const { t } = usePanel()
  const [editing, setEditing] = useState(!saved)
  const set = (next: Partial<Pool>) => onChange({ ...pool, ...next })
  return <section className="dt-form dt-card" aria-label={pool.id}>
    <div className="dt-subhead"><strong className="dt-mono">{pool.id}</strong><span className="dt-subhead-actions">
      <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>{t(editing ? 'collapse' : 'poolEdit')}</Button>
      <ConfirmButton label={t('poolRemove')} title={t('poolRemove')} message={t('poolRemoveConfirm', { id: pool.id })}
        onConfirm={async () => onRemove()} />
    </span></div>
    {!editing ? <Hint>{pool.description} · {t('poolDirectoryCount', { count: pool.directories.length })}</Hint> : <>
      <Field label={t('poolId')}><Input required pattern="[a-zA-Z0-9_-]{1,80}" value={pool.id} readOnly={!!saved}
        onChange={event => set({ id: event.target.value })} /></Field>
      <Field label={t('poolDescription')}><textarea className="dt-textarea" rows={2} required maxLength={2000} value={pool.description}
        onChange={event => set({ description: event.target.value })} /></Field>
      <Hint>{t('fixedPoolPolicy')}</Hint>
      <Field label={t('poolPrepare')} hint={t('poolPrepareHint')}><textarea className="dt-textarea dt-mono" rows={3}
        maxLength={LIMITS.prepareCommand} value={pool.prepare} spellCheck={false} onChange={event => set({ prepare: event.target.value })} /></Field>
      <Field label={t('poolRecycle')} hint={t('poolRecycleHint')}><textarea className="dt-textarea dt-mono" rows={3}
        maxLength={LIMITS.prepareCommand} value={pool.recycle} spellCheck={false} onChange={event => set({ recycle: event.target.value })} /></Field>
      {pool.directories.map((directory, index) => <div className="dt-form dt-block" key={index}>
        <Field label={t('directoryId')}><Input required pattern="[a-zA-Z0-9_-]{1,80}" value={directory.id}
          readOnly={!!saved?.directories.some(item => item.id === directory.id)} onChange={event => set({ directories: pool.directories.map((item, at) => at === index ? { ...item, id: event.target.value } : item) })} /></Field>
        <Field label={t('directoryPoolMembership')}><select className="dt-select" value={pool.id}
          onChange={event => onMove(directory, event.target.value)}>
          {pools.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select></Field>
        <Field label={t('directoryPath')}><Input className="dt-mono" required pattern="/.*" value={directory.path} spellCheck={false}
          onChange={event => set({ directories: pool.directories.map((item, at) => at === index ? { ...item, path: event.target.value } : item) })} /></Field>
        <ConfirmButton label={t('directoryRemove')} title={t('directoryRemove')} message={t('directoryRemoveConfirm', { id: directory.id })}
          onConfirm={async () => set({ directories: pool.directories.filter((_, at) => at !== index) })} />
      </div>)}
      {!pool.directories.length && <Hint>{t('poolEmptyInventory')}</Hint>}
      <Button variant="outline" size="sm" icon={<Icon name="plus" />} onClick={() => set({ directories: [...pool.directories,
        { id: nextId(`${pool.id}-directory`, pool.directories.map(item => item.id)), path: '' }] })}>{t('directoryAdd')}</Button>
    </>}
  </section>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('directoryPools')}</h2>
          <Field label={t('placementInstructions')} hint={t('placementInstructionsHint')}>
            <textarea className="dt-textarea" rows={4} maxLength={16000} value={value.placementInstructions}
              onChange={event => edit({ placementInstructions: event.target.value })} />
          </Field>
          <Section title={t('defaultPool')} hint={t('defaultPoolHint')}>
            <Field label={t('defaultPoolDescription')}><textarea className="dt-textarea" rows={2} required maxLength={2000}
              value={value.defaultPoolDescription} onChange={event => edit({ defaultPoolDescription: event.target.value })} /></Field>
          </Section>
          <Hint>{t('registrationNoFilesystem')}</Hint>
          {value.directoryPools.map((pool, index) => <PoolEditor key={index} pool={pool} pools={value.directoryPools}
            onMove={(directory, target) => edit({ directoryPools: value.directoryPools.map(item => item.id === pool.id && target !== pool.id
              ? { ...item, directories: item.directories.filter(entry => entry.id !== directory.id) }
              : item.id === target && target !== pool.id ? { ...item, directories: [...item.directories, directory] } : item) })}
            saved={executor.directoryPools.find(item => item.id === pool.id)}
            onChange={next => edit({ directoryPools: value.directoryPools.map((item, at) => at === index ? next : item) })}
            onRemove={() => edit({ directoryPools: value.directoryPools.filter((_, at) => at !== index) })} />)}
          <Button variant="outline" size="sm" icon={<Icon name="plus" />} onClick={() => edit({ directoryPools: [...value.directoryPools,
            { id: nextId('pool', value.directoryPools.map(pool => pool.id)), description: '', directories: [], prepare: '', recycle: '' }] })}>{t('poolAdd')}</Button>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <DirectoryDiagnostics />
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
