import { createElement as h, useEffect, useState } from 'react'
import { Card, SwitchRow } from './product-card.js'
import { EmptyState, FieldRow, InlineNotice, StatusChip } from './product-settings-components.js'
import { t } from './i18n.js'
import { roleName } from './roles.js'

const stateText = { running: 'Preparing', observed: 'Would prepare', prepared: 'Ready for review',
  silent: 'Ended quietly', suppressed: 'No longer current', 'budget-exhausted': 'Budget exhausted',
  failed: 'Preparation failed', stopped: 'Stopped' }
const workStageText = { pending: 'Pending start', draft: 'Worker running', idle: 'Worker idle',
  ready: 'Ready', ended: 'Ended', 'waiting-human': 'Waiting for human' }
const workReasonText = { 'worker-idle': 'Worker ended without a verified report', 'worker-running': 'Worker is executing',
  'worker-background': 'Waiting for background work', 'ready-report': 'Verified report recorded',
  'waiting-human': 'Waiting for a human answer', stopping: 'Stopping', stopped: 'Stopped',
  'environment-waiting': 'Waiting for an execution environment', 'setup-failed': 'Environment setup failed' }
const assignmentStateText = { pending: 'Pending execution', running: 'Running', stopping: 'Stopping', ended: 'Ended' }
const mandateStrengthText = { inferred: 'Inferred mandate', explicit: 'Explicit mandate' }
const lifecycleText = { open: 'Open', ended: 'Ended' }
const environmentText = { local: 'Local', remote: 'Remote' }
const workText = (value, labels) => t(value === undefined ? 'Unavailable' : labels[value] ?? value)

function usageLine(label, usage, format = t) {
  const count = Number(usage?.totalTokens ?? 0).toLocaleString()
  const detail = usage?.status === 'none' ? t('No model calls.')
    : usage?.status === 'unavailable' ? t('Provider usage was not reported.')
      : t('{tokens} tok · {reported} of {calls} calls reported', {
        tokens: count, reported: usage?.reportedCalls ?? 0, calls: usage?.calls ?? 0 })
  const unavailable = usage?.unavailableSessions
    ? ` · ${t('{count} Session reads unavailable', { count: usage.unavailableSessions })}` : ''
  return h('li', { key: label }, h('span', null, format(label)), h('span', null, detail + unavailable))
}

export function ProactiveReview({ runId, instanceId, call, remote = false, canStop = true, onStopped }) {
  const [run, setRun] = useState(null)
  const [error, setError] = useState('')
  const [artifact, setArtifact] = useState(null)
  const [workArtifact, setWorkArtifact] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    setRun(null); setArtifact(null)
    const refresh = () => call('proactive-read', { instanceId, runId }).then(value => { if (live) setRun(value) })
      .catch(failure => { if (live) setError(failure.message) })
    void refresh()
    const timer = setInterval(() => { void refresh() }, 15_000)
    return () => { live = false; clearInterval(timer) }
  }, [runId, instanceId, call])
  useEffect(() => { setWorkArtifact(null) }, [run?.work?.report?.id])
  const readArtifact = async path => {
    setBusy(true); setError('')
    try {
      let text = '', offset = 0, hasMore = true
      for (let page = 0; page < 16 && hasMore; page++) {
        const result = await call('proactive-artifact', { instanceId, runId, path, offset, maxBytes: 8192 })
        text += result.text; offset = result.nextOffset; hasMore = result.hasMore
      }
      setArtifact({ path, text, hasMore })
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const stop = async () => {
    setBusy(true); setError('')
    try {
      const stopped = await call('proactive-stop', { instanceId, runId, commandId: `stop-preparation:${runId}`,
        reason: 'Stopped by the user.' })
      setRun(stopped); onStopped?.()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const readWorkArtifact = async path => {
    setBusy(true); setError('')
    try {
      let text = '', offset = 0, hasMore = true
      for (let page = 0; page < 16 && hasMore; page++) {
        const result = await call('proactive-work-artifact', { instanceId, runId, path, offset, maxBytes: 8192 })
        text += result.text; offset = result.nextOffset; hasMore = result.hasMore
      }
      setWorkArtifact({ path, text, hasMore })
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  if (error && !run) return h('p', { className: 'bt-main-error', role: 'alert' }, error)
  if (!run) return h('p', { role: 'status' }, t('Loading…'))
  const work = run.work
  const report = work?.report
  return h('section', { className: 'bt-product-preparation-detail', 'aria-label': t('Preparation review') },
    h('p', null, `${t(stateText[run.state] ?? run.state)} · ${run.ruleId}`),
    h('p', null, `${t('Source Instance ID')}: ${run.sourceInstanceId} · ${t('Event')}: ${run.eventId}`),
    h('p', null, `${t('Rule version')}: ${run.ruleRevision} · ${t('Model steps')}: ${run.modelSteps ?? t('Unavailable')}`),
    run.summary ? h('p', null, run.summary) : null,
    run.evidence ? h('p', null, `${t('Evidence')}: ${run.evidence}`) : null,
    run.reason ? h('p', null, `${t('Reason')}: ${run.reason}`) : null,
    run.isolatedDirectory && !remote ? h('p', null, `${t('Preparation directory')}: ${run.isolatedDirectory}`) : null,
    work && (work.ticketId || work.usage) ? h('section', { className: 'bt-product-preparation-work', 'aria-label': t('Work control') },
      h('strong', null, t('Work control')),
      work.ticketId ? h('p', null, `${t('Ticket')}: ${work.ticket?.id ?? work.ticketId} · ${t('State')}: ${workText(work.ticket?.state ?? work.lifecycle, lifecycleText)}`) : null,
      h('p', null, `${t('Stage')}: ${workText(work.stage, workStageText)} · ${t('Reason')}: ${workText(work.reason, workReasonText)}`),
      work.mandate ? h('p', null, `${t('Mandate')}: ${work.mandate.id} · ${workText(work.mandate.strength, mandateStrengthText)} · ${work.mandate.scope}`) : null,
      work.assignment ? h('p', null, `${t('Assignment')}: ${work.assignment.id} · ${t('Generation')}: ${work.assignment.generation} · ${t('State')}: ${workText(work.assignment.state, assignmentStateText)}`
        + `${work.assignment.environment?.kind ? ` · ${t('Environment')}: ${workText(work.assignment.environment.kind, environmentText)}` : ''}`) : h('p', null, t('No Worker assignment yet.')),
      h('p', null, `${t('Step budgets')}: ${t('Preparation')} ${work.budgets?.preparationSteps ?? 0}/${work.budgets?.preparationStepLimit ?? 0}`
        + ` · ${roleName('router')} ${work.budgets?.routerSteps ?? 0}/${work.budgets?.routerStepLimit ?? 0}`
        + ` · ${t('Worker turn')} ${work.budgets?.workerLastTurnSteps ?? 0}/${work.budgets?.workerTurnStepLimit ?? 0}`),
      work.budgets?.workerAssignments > 1 ? h('p', null, `${t('Worker assignments included')}: ${work.budgets.workerAssignments}`) : null,
      work.budgets?.ruleRunLimit ? h('p', null, `${t('Rule run budget')}: ${work.budgets.ruleRunsUsed ?? t('Unknown')} / ${work.budgets.ruleRunLimit}`
        + ` · ${work.budgets.ruleWindowMs / 3_600_000} h`) : null,
      work.budgets?.maxArtifactBytes ? h('p', null, `${t('Artifact byte budget')}: ${work.budgets.maxArtifactBytes}`) : null,
      work.usage ? h('div', null, h('strong', null, t('Token usage by role')),
        h('ul', { className: 'bt-product-preparation-usage' },
          usageLine('Preparation', work.usage.roles?.preparation),
          usageLine(roleName('router'), work.usage.roles?.router, value => value),
          usageLine(roleName('worker'), work.usage.roles?.worker, value => value),
          usageLine('Total', work.usage.total)),
        h('p', null, `${t('Cost')}: ${work.usage.cost?.status === 'unavailable' ? t('Cost unavailable') : work.usage.cost?.amount}`),
        work.usage.cost?.status === 'unavailable'
          ? h('p', { className: 'bt-product-preparation-hint' }, t('No model price catalog is configured for this work.')) : null) : null,
      report ? h('section', { className: 'bt-product-preparation-report' },
        h('strong', null, t('Worker report')),
        h('p', null, report.result),
        h('p', null, `${t('Evidence')}: ${report.evidence}`),
        report.artifacts?.length ? h('div', null, h('strong', null, t('Verified files')),
          report.artifacts.map(item => h('div', { key: item.path },
            h('span', null, `${item.path} · ${item.bytes} ${t('bytes')}`),
            !remote ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
              onClick: () => { void readWorkArtifact(item.path) } }, t('Read verified file')) : null))) : null,
        workArtifact ? h('div', null, h('strong', null, workArtifact.path),
          h('pre', { className: 'bt-product-preparation-file' }, workArtifact.text),
          workArtifact.hasMore ? h('p', null, t('Partial evidence')) : null) : null)
        : work.reportState === 'stale' ? h('p', null, t('A newer Worker assignment makes the previous report stale.'))
          : h('p', null, t('No ready report yet.'))) : null,
    run.artifacts?.length ? h('div', null, h('strong', null, t('Verified files')),
      run.artifacts.map(item => h('div', { key: item.path },
        h('span', null, `${item.path} · ${item.bytes} ${t('bytes')} · SHA-256 ${item.sha256}`),
        !remote ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => { void readArtifact(item.path) } }, t('Read file')) : null))) : null,
    artifact ? h('div', null, h('strong', null, artifact.path),
      h('pre', { className: 'bt-product-preparation-file' }, artifact.text),
      artifact.hasMore ? h('p', null, t('Partial evidence')) : null) : null,
    canStop && (work?.control?.canStop ?? (run.state === 'running' || run.state === 'prepared')) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
      disabled: busy, onClick: () => { void stop() } }, t('Stop preparation')) : null,
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null)
}

export function ProductProactiveSettings({ binding, call }) {
  const [snapshot, setSnapshot] = useState(null)
  const [runs, setRuns] = useState([])
  const [before, setBefore] = useState(null)
  const [draft, setDraft] = useState(null)
  const [draftRevision, setDraftRevision] = useState(null)
  const [selected, setSelected] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const refresh = async () => {
    const [rules, history] = await Promise.all([
      call('proactive-rules', { instanceId: binding.instanceId }), call('proactive-list', { instanceId: binding.instanceId }),
    ])
    setSnapshot(rules)
    setRuns(current => [...new Map([...current, ...history.items].map(run => [run.id, run])).values()]
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)))
    setBefore(current => current ?? history.before ?? null)
    setReadError('')
  }
  const loadOlder = async () => {
    if (!before || busy) return
    setBusy(true)
    try {
      const history = await call('proactive-list', { instanceId: binding.instanceId, before })
      setRuns(current => [...current, ...history.items]); setBefore(history.before ?? null)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    let live = true
    const load = () => refresh().catch(failure => { if (live) setReadError(failure.message) })
    void load()
    const timer = setInterval(() => { void load() }, 15_000)
    return () => { live = false; clearInterval(timer) }
  }, [binding.instanceId])
  const save = async (rules, expectedRevision = snapshot.revision) => {
    setBusy(true); setError('')
    try {
      await call('proactive-save', { instanceId: binding.instanceId, commandId: crypto.randomUUID(),
        expectedRevision, rules })
      setDraft(null); await refresh()
    } catch (failure) {
      setError(failure.code === 'CONFIG_REVISION_CONFLICT' ? t('Rules changed elsewhere. Review the latest version and save again.') : failure.message)
      await refresh().catch(() => {})
    } finally { setBusy(false) }
  }
  const pause = async paused => {
    setBusy(true); setError('')
    try {
      await call('proactive-pause', { instanceId: binding.instanceId, commandId: crypto.randomUUID(), paused })
      await refresh()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const remove = ruleId => {
    if (confirmDelete !== ruleId) { setConfirmDelete(ruleId); return }
    setConfirmDelete(null)
    void save(snapshot.rules.filter(rule => rule.id !== ruleId))
  }
  const sourceFor = id => snapshot.sources.find(source => source.sourceInstanceId === id)
  const edit = rule => {
    setDraftRevision(snapshot.revision)
    setDraft(rule ? structuredClone(rule) : {
      id: `review-${crypto.randomUUID().slice(0, 8)}`, name: '', mode: 'observe', enabled: true,
      match: { actorKinds: snapshot.sources[0].kind === 'github' ? ['bot', 'ci'] : ['bot'],
        addressing: ['direct', 'mention'], sourceInstanceIds: [snapshot.sources[0].sourceInstanceId] },
      scope: '', communication: 'silent', budget: { maxRuns: 2, windowMs: 3_600_000, maxArtifactBytes: 65_536 },
    })
  }
  const update = (path, value) => setDraft(current => {
    const next = structuredClone(current)
    let part = next
    for (const key of path.slice(0, -1)) part = part[key]
    part[path.at(-1)] = value
    return next
  })
  const submit = event => {
    event.preventDefault()
    const next = { ...draft, name: draft.name.trim(), scope: draft.scope?.trim() || undefined,
      match: { ...draft.match, textPattern: draft.match.textPattern?.trim() || undefined } }
    const rules = snapshot.rules.filter(rule => rule.id !== next.id)
    void save([...rules, next], draftRevision)
  }
  const staleDraft = draft && draftRevision !== snapshot?.revision
  return h('section', { className: 'bt-ps-content bt-product-preparations', 'aria-label': t('Proactive preparation') },
    h(Card, { title: t('Proactive preparation') },
      h(SwitchRow, { label: t('Pause proactive preparation'), on: snapshot?.control.paused ?? false,
        hint: t('Paused preparations cannot submit a result. Existing work continues.'), disabled: busy || !snapshot,
        onChange: value => { void pause(value) } }),
      h('p', null, t('Rules use an authenticated source event. Preparation cannot send messages, create PRs or merge changes.')),
      snapshot?.sources.length ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => edit(null) }, t('New rule')) : snapshot ? h(InlineNotice, { tone: 'warn' }, t('Configure a source to enable preparation rules.')) : null),
    error || readError ? h(InlineNotice, { tone: 'danger', action: readError ? h('button', { type: 'button', className: 'bt-soft',
      onClick: () => { void refresh().catch(failure => setReadError(failure.message)) } }, t('Retry')) : null }, error || readError)
      : !snapshot ? h(InlineNotice, { tone: 'neutral' }, t('Loading…')) : null,
    snapshot?.rules.map(rule => h(Card, { key: rule.id, title: rule.name },
      h(FieldRow, { label: rule.match.sourceInstanceIds?.join(', '),
        control: h(StatusChip, { tone: rule.enabled ? 'accent' : 'neutral' }, rule.enabled ? t(rule.mode === 'auto' ? 'Auto' : 'Observe') : t('Off')) }),
      h(FieldRow, { label: t('Run budget'), control: `${rule.budget.maxRuns} / ${rule.budget.windowMs / 3_600_000} h` }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => edit(rule) }, t('Edit rule')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => { void save(snapshot.rules.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item)) } },
      t(rule.enabled ? 'Disable rule' : 'Enable rule')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => remove(rule.id) }, t(confirmDelete === rule.id ? 'Confirm delete rule' : 'Delete rule')))),
    draft ? h('form', { className: 'bt-set-card bt-product-preparation-form', onSubmit: submit },
      h('label', null, t('Name'), h('input', { className: 'bt-bs-input', value: draft.name, maxLength: 128, required: true,
        onChange: event => update(['name'], event.target.value) })),
      h('label', null, t('Source'), h('select', { className: 'bt-select', value: draft.match.sourceInstanceIds[0],
        onChange: event => setDraft(current => ({ ...current,
          match: { ...current.match, sourceInstanceIds: [event.target.value],
            actorKinds: sourceFor(event.target.value)?.kind === 'github' ? ['bot', 'ci'] : ['bot'] } })) },
      snapshot.sources.map(source => h('option', { key: source.sourceInstanceId, value: source.sourceInstanceId }, source.label)))),
      sourceFor(draft.match.sourceInstanceIds[0])?.kind === 'github'
        ? h('fieldset', null, h('legend', null, t('Event actors')),
          ['bot', 'ci'].map(kind => h('label', { key: kind }, h('input', { type: 'checkbox', checked: draft.match.actorKinds.includes(kind),
            onChange: event => update(['match', 'actorKinds'], event.target.checked
              ? [...draft.match.actorKinds, kind] : draft.match.actorKinds.filter(item => item !== kind)) }),
          t(kind === 'ci' ? 'CI events' : 'Actor events')))) : null,
      h('label', null, t('Mode'), h('select', { className: 'bt-select', value: draft.mode,
        onChange: event => update(['mode'], event.target.value) },
      h('option', { value: 'observe' }, t('Observe')), h('option', { value: 'auto' }, t('Auto')))),
      h('label', null, t('Text contains'), h('input', { className: 'bt-bs-input',
        value: draft.match.textPattern ?? '', maxLength: 128, onChange: event => update(['match', 'textPattern'], event.target.value) })),
      h('label', null, t('Preparation scope'), h('textarea', { className: 'bt-bs-input bt-bs-area',
        value: draft.scope ?? '', maxLength: 4096, rows: 2, onChange: event => update(['scope'], event.target.value) })),
      h('label', null, t('Notify Main for useful results'), h('input', { type: 'checkbox', checked: draft.communication === 'notify',
        onChange: event => update(['communication'], event.target.checked ? 'notify' : 'silent') })),
      h('label', null, t('Runs per hour'), h('input', { type: 'number', min: 1, max: 100, required: true, className: 'bt-bs-input',
        value: draft.budget.maxRuns, onChange: event => update(['budget', 'maxRuns'], Number(event.target.value)) })),
      h('label', null, t('Max file bytes'), h('input', { type: 'number', min: 1024, max: 10485760, required: true,
        className: 'bt-bs-input', value: draft.budget.maxArtifactBytes,
        onChange: event => update(['budget', 'maxArtifactBytes'], Number(event.target.value)) })),
      staleDraft ? h(InlineNotice, { tone: 'warn' }, t('Rules changed elsewhere. Close this draft and reopen the rule before saving.')) : null,
      h('div', { className: 'bt-actions' }, h('button', { type: 'submit', className: 'bt-soft', disabled: busy || staleDraft || !draft.match.actorKinds.length }, t('Save rule')),
        h('button', { type: 'button', className: 'bt-soft', onClick: () => setDraft(null) }, t('Cancel')))) : null,
    h(Card, { title: t('Preparation history') },
      runs.length ? runs.map(run => h('div', { key: run.id, className: 'bt-product-preparation-row' },
        h('strong', null, `${run.ruleId} · ${t(stateText[run.state] ?? run.state)}`),
        h('span', null, run.summary || run.reason || run.eventId),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setSelected(run.id) }, t('Review'))))
        : snapshot ? h(EmptyState, { title: t('No preparations yet.') }) : null,
      before ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        onClick: () => { void loadOlder() } }, t('Load earlier preparations')) : null,
      selected ? h(ProactiveReview, { key: selected, runId: selected, instanceId: binding.instanceId,
        call, onStopped: () => { void refresh() } }) : null))
}

export const PRODUCT_PROACTIVE_CSS = `
.bt-product-preparations p{font-size:var(--bt-ps-text);line-height:18px}
.bt-product-preparation-form{display:grid;gap:12px}
.bt-product-preparation-form label{display:grid;gap:6px;font-size:var(--bt-ps-text)}
.bt-product-preparation-form fieldset{border:1px solid var(--bt-line);display:flex;gap:12px;flex-wrap:wrap}
.bt-product-preparation-form fieldset label{display:flex;align-items:center}
.bt-product-preparation-row{display:grid;gap:4px;overflow-wrap:anywhere}
.bt-product-preparation-row button{justify-self:start}
.bt-product-preparation-detail{border-top:1px solid var(--bt-line);padding-top:12px;overflow-wrap:anywhere;font-size:var(--bt-ps-text)}
.bt-product-preparation-file{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto}
.bt-product-preparation-work{margin:14px 0;padding:12px;border:1px solid var(--bt-line);border-radius:var(--bt-ps-radius-card)}
.bt-product-preparation-usage{display:grid;gap:6px;padding:0;list-style:none}
.bt-product-preparation-usage li{display:flex;justify-content:space-between;gap:12px}
.bt-product-preparation-hint{color:var(--bt-muted)}
.bt-product-preparation-report{display:grid;gap:6px;margin-top:12px}
`
