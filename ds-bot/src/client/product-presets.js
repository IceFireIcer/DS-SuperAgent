import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { Card, CharacterGrid, Row } from './bot-settings.js'
import { avatarImage } from './avatar-library.js'
import { lookOf, BotMark } from './mark.js'
import { t } from './i18n.js'

const roles = [['main', 'Main'], ['router', 'Router'], ['worker', 'Worker']]
const legacyFields = ['name', 'model', 'effort', 'instructions', 'skills', 'color', 'avatar']
const emptyDraft = () => ({ id: crypto.randomUUID(), name: '', provider: '', model: '', effort: '', instructions: '', skills: '', appearance: {} })
const appearanceOf = preset => lookOf({ id: preset.id, color: preset.appearance?.color, avatar: preset.appearance })

function selectedCopy(text, sourceIdentity, sourceBotId, targetRole) {
  const state = JSON.parse(text)
  const bot = state?.bots?.[sourceBotId]
  if (!bot || typeof bot !== 'object' || Array.isArray(bot) || !Object.hasOwn(state.bots, sourceBotId)) {
    throw new Error(t('The copy has no selected Bot configuration.'))
  }
  const selected = Object.fromEntries(legacyFields.filter(field => Object.hasOwn(bot, field)).map(field => [field, bot[field]]))
  if (selected.avatar && typeof selected.avatar === 'object' && !Array.isArray(selected.avatar)) {
    selected.avatar = Object.fromEntries(['shape', 'image'].filter(field => Object.hasOwn(selected.avatar, field))
      .map(field => [field, selected.avatar[field]]))
  }
  const ignored = [...Object.keys(bot).filter(field => !legacyFields.includes(field)).map(field => `bot.${field}`),
    ...(bot.avatar && typeof bot.avatar === 'object' && !Array.isArray(bot.avatar)
      ? Object.keys(bot.avatar).filter(field => field !== 'shape' && field !== 'image').map(field => `bot.avatar.${field}`) : []),
    ...(Object.hasOwn(state, 'mainBotIds') ? ['state.mainBotIds'] : [])]
  return { copy: { sourceIdentity, sourceBotId, targetRole, state: { bots: { [sourceBotId]: selected } } }, ignored }
}

function draftFromPreview(record) {
  const profile = record.preview.draft
  return { id: `legacy-${record.preview.targetRole}-${record.preview.source.digest.slice(0, 20)}`,
    name: profile.name, provider: profile.model?.provider ?? '', model: profile.model?.model ?? '',
    effort: profile.model?.effort ?? '', instructions: profile.instructions, skills: profile.skills.join(', '),
    appearance: profile.appearance ?? {} }
}

function toPreset(draft) {
  const appearance = draft.appearance
  return { id: draft.id.trim(), name: draft.name.trim(), model: { provider: draft.provider.trim(), model: draft.model.trim(),
    ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}) }, instructions: draft.instructions,
  skills: draft.skills.split(/[\n,]/u).map(skill => skill.trim()).filter(Boolean),
  ...(Object.keys(appearance).length ? { appearance } : {}) }
}

function requireList(result) {
  if (!result || !Array.isArray(result.items) || result.items.some(entry => !entry?.preset?.model || !entry.id)) {
    throw new Error(t('Role presets are unavailable.'))
  }
  return result
}

function requireEntry(result) {
  if (!result || typeof result.id !== 'string' || !Number.isSafeInteger(result.revision) || result.revision < 1
    || result.status !== 'active') throw new Error(t('The preset was not confirmed.'))
  return result
}

function requirePreview(result) {
  if (!result || typeof result.id !== 'string' || !result.preview?.source?.digest || !result.preview?.draft
    || !Array.isArray(result.preview.fields) || !Array.isArray(result.preview.ignored) || !Array.isArray(result.preview.issues)) {
    throw new Error(t('The preview was not confirmed.'))
  }
  return result
}

function requireDecision(result) {
  if (!result || typeof result.id !== 'string' || !['selected', 'skipped', 'duplicate', 'conflict'].includes(result.status)) {
    throw new Error(t('The import decision was not confirmed.'))
  }
  if (result.status === 'selected' && typeof result.presetId !== 'string') throw new Error(t('The selected preset was not confirmed.'))
  return result
}

function DraftFields({ draft, onChange, onUploading, busy }) {
  const [showCharacters, setShowCharacters] = useState(false)
  const patch = change => onChange(current => ({ ...current, ...change }))
  const appearance = change => onChange(current => ({ ...current, appearance: { ...current.appearance, ...change } }))
  const upload = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    onUploading(true)
    try { appearance({ image: await avatarImage(file) }) }
    catch (failure) { onChange(current => current, failure.message) }
    finally { onUploading(false) }
  }
  const field = (label, key, props = {}) => h(Row, { label: t(label), stack: key === 'instructions' || key === 'skills' },
    key === 'instructions' || key === 'skills'
      ? h('textarea', { className: 'bt-bs-input bt-bs-area', rows: key === 'instructions' ? 4 : 2,
        'aria-label': t(label), disabled: busy, value: draft[key], onChange: event => patch({ [key]: event.target.value }), ...props })
      : h('input', { className: 'bt-bs-input', 'aria-label': t(label), disabled: busy, value: draft[key],
        onChange: event => patch({ [key]: event.target.value }), ...props }))
  return h(Card, { title: t('Preset profile') },
    field('Preset ID', 'id', { required: true, maxLength: 128 }),
    field('Name', 'name', { required: true, maxLength: 128 }),
    field('Model provider', 'provider', { required: true, maxLength: 128 }),
    field('Model ID', 'model', { required: true, maxLength: 128 }),
    field('Thinking effort', 'effort', { maxLength: 128 }),
    field('Instructions', 'instructions', { maxLength: 16384 }),
    field('Skills', 'skills', { placeholder: t('Comma-separated skill names') }),
    h('div', { className: 'bt-set-row bt-product-preset-appearance' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Appearance')),
        h('span', { className: 'bt-set-hint' }, t('The appearance stays with the preset, not role permissions.'))),
      h(BotMark, { look: appearanceOf(draft), size: 36, label: t('Preset appearance') }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
        'aria-expanded': showCharacters, onClick: () => setShowCharacters(value => !value) }, t('Choose character'))),
    showCharacters ? h('fieldset', { className: 'bt-product-preset-picker', disabled: busy }, h(CharacterGrid, {
      look: appearanceOf(draft), hasPhoto: Boolean(draft.appearance.image),
      onShape: shape => onChange(current => {
        const { image, ...rest } = current.appearance
        return { ...current, appearance: { ...rest, shape } }
      }),
      onColor: color => appearance({ color }),
    }), h('label', null, t('Upload image'), h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
      disabled: busy, onChange: event => { void upload(event) } })),
    draft.appearance.image ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
      onClick: () => onChange(current => {
        const { image, ...rest } = current.appearance
        return { ...current, appearance: rest }
      }) }, t('Remove photo')) : null) : null)
}

/** Settings page content. The parent supplies its authorized productCall and current settings revision. */
export function ProductPresetSettings({ binding, call, settingsRevision, onApplied }) {
  const instanceId = binding.instanceId
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [listError, setListError] = useState('')
  const [mode, setMode] = useState(null)
  const [draft, setDraft] = useState(null)
  const [preview, setPreview] = useState(null)
  const [reviewCopy, setReviewCopy] = useState(null)
  const [ignored, setIgnored] = useState([])
  const [sourceText, setSourceText] = useState('')
  const [sourceIdentity, setSourceIdentity] = useState('')
  const [sourceBotId, setSourceBotId] = useState('')
  const [targetRole, setTargetRole] = useState('worker')
  const [applyRole, setApplyRole] = useState('worker')
  const [revision, setRevision] = useState(settingsRevision)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activity, setActivity] = useState(null)
  const [activityError, setActivityError] = useState('')
  const [activityBusy, setActivityBusy] = useState(false)
  const commands = useRef({})
  const request = useRef(0)
  const submitting = useRef(false)
  const uploading = useRef(false)

  const refresh = useCallback(async (after, append = false) => {
    const own = ++request.current
    try {
      const page = requireList(await call('preset-list', { instanceId, limit: 50, ...(after ? { after } : {}) }))
      if (own !== request.current) return
      setItems(previous => append ? [...(previous ?? []), ...page.items] : page.items)
      setCursor(page.cursor ?? null)
      setListError('')
    } catch (failure) { if (own === request.current) setListError(failure.message) }
  }, [call, instanceId])
  useEffect(() => {
    setItems(null); setMode(null); setPreview(null); setReviewCopy(null); setNotice(''); setError('')
    setActivity(null); setActivityError('')
    commands.current = {}
    void refresh()
    return () => { request.current++ }
  }, [refresh])
  useEffect(() => { setRevision(settingsRevision); setStale(false) }, [settingsRevision])

  const commandId = (kind, payload) => {
    const fingerprint = JSON.stringify(payload)
    if (commands.current[kind]?.fingerprint !== fingerprint) commands.current[kind] = { fingerprint, id: crypto.randomUUID() }
    return commands.current[kind].id
  }
  const submit = async (kind, endpoint, payload, receive) => {
    if (submitting.current || uploading.current) return
    submitting.current = true
    setBusy(kind); setError(''); setNotice('')
    const id = commandId(kind, payload)
    try {
      const result = await call(endpoint, { instanceId, commandId: id, ...payload })
      await receive(result)
      delete commands.current[kind]
    } catch (failure) {
      if (kind === 'apply' && (failure?.code === 'COMMIT_UNKNOWN' || failure?.code === 'CLIENT_JOURNAL_UNAVAILABLE')) {
        try {
          const recorded = await call('preset-application-read', { instanceId, commandId: id })
          if (recorded?.presetId === payload.presetId && recorded.targetRole === payload.targetRole
            && recorded.revision > payload.expectedRevision) {
            await receive(recorded)
            delete commands.current[kind]
            return
          }
        } catch { /* The original command ID remains available for retry. */ }
      }
      if (kind === 'apply' && failure?.code === 'CONFIG_REVISION_CONFLICT') setStale(true)
      setError(failure?.message ?? t('The preset operation failed.'))
    } finally { submitting.current = false; setBusy(null) }
  }

  const loadActivity = async (previous = null) => {
    setActivityBusy(true); setActivityError('')
    try {
      const [imports, applications] = await Promise.all([
        previous?.importsCursor === null ? { items: [] } : call('preset-imports', { instanceId, limit: 50,
          ...(previous?.importsCursor ? { after: previous.importsCursor } : {}) }),
        previous?.applicationsCursor === null ? { items: [] } : call('preset-applications', { instanceId, limit: 50,
          ...(previous?.applicationsCursor ? { after: previous.applicationsCursor } : {}) }),
      ])
      if (!Array.isArray(imports?.items) || !Array.isArray(applications?.items)) throw new Error(t('Preset activity is unavailable.'))
      setActivity({ imports: [...(previous?.imports ?? []), ...imports.items], applications: [...(previous?.applications ?? []), ...applications.items],
        importsCursor: imports.cursor ?? null, applicationsCursor: applications.cursor ?? null })
    } catch (failure) { setActivityError(failure?.message ?? t('Preset activity is unavailable.')) }
    finally { setActivityBusy(false) }
  }

  const create = event => {
    event.preventDefault()
    const preset = toPreset(draft)
    void submit('create', 'preset-create', { preset }, async result => {
      requireEntry(result)
      if (result.id !== preset.id) throw new Error(t('The created preset does not match your draft.'))
      setMode(null); setDraft(null); setNotice(t('Preset created.'))
      await refresh()
    })
  }
  const prepare = event => {
    event.preventDefault()
    let selected
    try { selected = selectedCopy(sourceText, sourceIdentity.trim(), sourceBotId.trim(), targetRole) }
    catch (failure) { setError(failure.message); return }
    void submit('preview', 'preset-preview', { copy: selected.copy }, result => {
      const record = requirePreview(result)
      if (record.preview.source.identity !== selected.copy.sourceIdentity || record.preview.source.botId !== selected.copy.sourceBotId
        || record.preview.targetRole !== targetRole) {
        throw new Error(t('The preview does not match the selected source and target.'))
      }
      setReviewCopy(selected.copy); setIgnored(selected.ignored); setDraft(draftFromPreview(record)); setPreview(record)
    })
  }
  const decide = decision => {
    const payload = { previewId: preview.id, decision,
      ...(decision === 'select' ? { copy: reviewCopy, preset: toPreset(draft) } : {}) }
    void submit('select', 'preset-select', payload, async result => {
      const record = requireDecision(result)
      if (record.previewId !== preview.id) throw new Error(t('The import decision does not match this review.'))
      if (record.status === 'conflict') {
        setError(t('Import conflict: {reason}. Review the source and preset again.', { reason: t(record.reason ?? 'unknown') }))
        return
      }
      if (decision === 'select' && record.status === 'skipped' || decision === 'skip' && record.status === 'selected') {
        throw new Error(t('The import decision does not match your choice.'))
      }
      if (record.status === 'selected' && record.presetId !== payload.preset.id) {
        throw new Error(t('The selected preset does not match your review.'))
      }
      setNotice(t(record.status === 'duplicate' ? 'This import decision was already recorded.'
        : record.status === 'skipped' ? 'Import skipped.' : 'Preset selected from the reviewed copy.'))
      setPreview(null); setReviewCopy(null); setDraft(null); setSourceText(''); setMode(null)
      await refresh()
    })
  }
  const apply = presetId => {
    if (!Number.isSafeInteger(revision) || stale) return
    const expectedRevision = revision
    void submit('apply', 'preset-apply', { presetId, targetRole: applyRole, expectedRevision }, result => {
      if (!Number.isSafeInteger(result?.revision) || result.revision <= expectedRevision) {
        throw new Error(t('The role configuration revision was not confirmed.'))
      }
      setRevision(result.revision)
      setNotice(t('Configuration v{revision} is active for new turns.', { revision: result.revision }))
      if (onApplied) void Promise.resolve().then(() => onApplied(result)).catch(failure => {
        setError(failure?.message ?? t('Could not refresh role settings.'))
      })
    })
  }

  return h('section', { className: 'bt-product-presets', 'aria-label': t('Role presets') },
    h(Card, { title: t('Role presets') },
      h('div', { className: 'bt-set-row bt-product-preset-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy) || items === null || Boolean(listError) || Boolean(mode),
          onClick: () => { setDraft(emptyDraft()); setMode('new'); setError(''); setNotice('') } }, t('New preset')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy) || items === null || Boolean(listError) || Boolean(mode),
          onClick: () => { setMode('import'); setError(''); setNotice('') } }, t('Review old configuration'))),
      listError ? h('div', { className: 'bt-set-row' }, h('p', { className: 'bt-main-error', role: 'alert' }, listError),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void refresh() } }, t('Retry'))) : null,
      items === null && !listError ? h('p', { className: 'bt-set-row bt-main-status', role: 'status' }, t('Loading…')) : null,
      items?.length === 0 ? h('p', { className: 'bt-set-row bt-main-status' }, t('No role presets yet.')) : null,
      items?.length ? h('div', { className: 'bt-set-row bt-product-preset-target' },
        h('label', null, t('Apply to'), h('select', { className: 'bt-select', 'aria-label': t('Apply to'), value: applyRole,
          disabled: Boolean(busy), onChange: event => setApplyRole(event.target.value) },
        roles.map(([id, name]) => h('option', { key: id, value: id }, t(name))))),
        !Number.isSafeInteger(revision) ? h('span', { className: 'bt-set-hint' }, t('Open role settings to load its current revision.')) : null) : null,
      items?.map(entry => h('div', { key: entry.id, className: 'bt-set-row bt-product-preset-item' },
        h(BotMark, { look: appearanceOf(entry.preset), size: 36, label: entry.preset.name }),
        h('span', { className: 'bt-set-copy' }, h('strong', null, entry.preset.name),
          h('span', { className: 'bt-set-hint' }, `${entry.preset.model.provider}/${entry.preset.model.model} · ${t('Preset')} v${entry.revision}`),
          entry.origin ? h('span', { className: 'bt-set-hint' }, `${t('From')} ${entry.origin.source.identity} / ${entry.origin.source.botId} → ${entry.origin.targetRole}`) : null),
        entry.status === 'active' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
          disabled: Boolean(busy) || Boolean(listError) || stale || !Number.isSafeInteger(revision), onClick: () => apply(entry.id) }, t('Apply preset'))
          : h('span', { className: 'bt-set-hint' }, t('Deleted')))),
      cursor ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
        onClick: () => { void refresh(cursor, true) } }, t('Load more')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: activityBusy,
        onClick: () => { void loadActivity() } }, t('Preset activity'))),
    activityError ? h('p', { role: 'alert', className: 'bt-main-error' }, activityError) : null,
    activity ? h(Card, { title: t('Preset activity') },
      activity.imports.map(item => h('p', { key: item.id, className: 'bt-set-row bt-set-hint' },
        `${item.source.identity} / ${item.source.botId} → ${item.targetRole}: ${t(item.status)}${item.reason ? ` (${t(item.reason)})` : ''}`)),
      activity.applications.map(item => h('p', { key: `${item.sourceInstanceId}:${item.actorId}:${item.commandId}`, className: 'bt-set-row bt-set-hint' },
        `${item.presetId} v${item.presetRevision} → ${item.targetRole}: ${t('Configuration')} v${item.revision}`)),
      !activity.imports.length && !activity.applications.length ? h('p', { className: 'bt-set-row bt-set-hint' }, t('No preset activity yet.')) : null,
      activity.importsCursor || activity.applicationsCursor ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm',
        disabled: activityBusy, onClick: () => { void loadActivity(activity) } }, t('Load more')) : null) : null,
    stale ? h('p', { role: 'alert', className: 'bt-main-error' }, t('Role settings changed. Reload settings before applying a preset.')) : null,
    error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
    notice ? h('p', { role: 'status', className: 'bt-main-status' }, notice) : null,
    mode === 'import' && !preview ? h('form', { className: 'bt-product-preset-form', onSubmit: prepare },
      h(Card, { title: t('Review old configuration') },
        h(Row, { label: t('Copy identity'), hint: t('A name for the explicit copy you provide.') },
          h('input', { className: 'bt-bs-input', 'aria-label': t('Copy identity'), value: sourceIdentity, required: true,
            disabled: Boolean(busy), onChange: event => setSourceIdentity(event.target.value) })),
        h(Row, { label: t('Old Bot ID') }, h('input', { className: 'bt-bs-input', 'aria-label': t('Old Bot ID'),
          value: sourceBotId, required: true, disabled: Boolean(busy), onChange: event => setSourceBotId(event.target.value) })),
        h(Row, { label: t('Target role') }, h('select', { className: 'bt-select', 'aria-label': t('Target role'), value: targetRole,
          disabled: Boolean(busy), onChange: event => setTargetRole(event.target.value) },
        roles.map(([id, name]) => h('option', { key: id, value: id }, t(name))))),
        h(Row, { label: t('Old configuration copy'), hint: t('Paste a copy of bot/state.json. Only the selected profile fields are sent for review.'), stack: true },
          h('textarea', { className: 'bt-bs-input bt-bs-area', 'aria-label': t('Old configuration copy'), rows: 5,
            required: true, value: sourceText, disabled: Boolean(busy), onChange: event => setSourceText(event.target.value) }))),
      h('div', { className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
        onClick: () => { setMode(null); setSourceText('') } }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: Boolean(busy) }, busy ? t('Loading…') : t('Preview')))) : null,
    preview ? h('div', { className: 'bt-product-preset-form' },
      h(Card, { title: t('Review source and target') },
        h('p', { className: 'bt-set-row' }, `${preview.preview.source.identity} / ${preview.preview.source.botId} → ${preview.preview.targetRole}`),
        h('p', { className: 'bt-set-row bt-set-hint' }, `${t('Source digest')}: ${preview.preview.source.digest}`),
        preview.preview.fields.map(field => h('p', { key: field.from, className: 'bt-set-row bt-set-hint' }, `${field.from} → ${field.to}`)),
        new Set([...preview.preview.ignored, ...ignored]).size ? h('p', { className: 'bt-set-row bt-set-hint' },
          `${t('Ignored fields')}: ${[...new Set([...preview.preview.ignored, ...ignored])].join(', ')}`) : null,
        preview.preview.issues.map((issue, index) => h('p', { key: index, role: 'status', className: 'bt-set-row bt-main-error' },
          `${issue.field}: ${t(issue.reason)}`))),
      h(DraftFields, { draft, busy: Boolean(busy),
        onUploading: value => { uploading.current = value; setBusy(value ? 'image' : null) },
        onChange: (value, failure) => { setDraft(value); setError(failure ?? '') } }),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
          onClick: () => decide('skip') }, t('Skip import')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
          onClick: () => { setPreview(null); setReviewCopy(null); setDraft(null) } }, t('Review again')),
        h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: Boolean(busy),
          onClick: () => decide('select') }, busy ? t('Saving…') : t('Select preset')))) : null,
    mode === 'new' && draft ? h('form', { className: 'bt-product-preset-form', onSubmit: create },
      h(DraftFields, { draft, busy: Boolean(busy),
        onUploading: value => { uploading.current = value; setBusy(value ? 'image' : null) },
        onChange: (value, failure) => { setDraft(value); setError(failure ?? '') } }),
      h('div', { className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: Boolean(busy),
        onClick: () => { setMode(null); setDraft(null) } }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: Boolean(busy) }, busy ? t('Saving…') : t('Create preset')))) : null)
}

export const PRODUCT_PRESET_CSS = `
.bt-product-presets{display:flex;flex-direction:column;gap:16px}
.bt-product-presets .bt-set-row{min-width:0;overflow-wrap:anywhere}
.bt-product-preset-actions,.bt-product-preset-target,.bt-product-preset-appearance{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.bt-product-preset-target label{display:flex;align-items:center;gap:8px}
.bt-product-preset-item .bt-set-copy{min-width:0}
.bt-product-preset-form{display:flex;flex-direction:column;gap:12px}
.bt-product-preset-form .bt-bs-input,.bt-product-preset-form .bt-select{min-width:0;max-width:100%}
.bt-product-preset-form .bt-bs-area{width:100%;box-sizing:border-box}
.bt-product-preset-form .bt-actions{justify-content:flex-end;flex-wrap:wrap;gap:8px}
.bt-product-preset-picker{display:flex;flex-direction:column;gap:12px;margin:0;padding:12px;border:0;border-top:.5px solid var(--bt-line);min-width:0}
.bt-product-preset-picker .bt-color{width:28px;height:28px}
.bt-product-presets button:focus-visible,.bt-product-presets input:focus-visible,.bt-product-presets select:focus-visible,
.bt-product-presets textarea:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(max-width:640px){.bt-product-preset-item{flex-wrap:wrap}.bt-product-preset-item>button{margin-left:48px}}
`
