import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { BotMark } from '../../../../../superagent/dsh/src/client/mark.js'
import { MAIN_LOOK } from '../../../../../superagent/dsh/src/client/characters.js'
import { ArrowUpIcon, CheckIcon, ChevronRightIcon, CloseIcon, ConnectorIcon, FolderIcon, GaugeIcon, MicIcon, PaperclipIcon, PlusIcon, SidebarIcon, SlidersIcon, WaveIcon } from '../../../../../superagent/dsh/src/client/icons.js'
import { ProductBrandMark } from '../../../../../superagent/dsh/src/client/product-brand.js'
import { ProductShellHeader } from '../../../../../superagent/dsh/src/client/product-shell.js'
import { SuperagentAccountFooter } from '../../../../../superagent/dsh/src/client/product-account.js'
import { MODEL_ONBOARDING_CSS, SuperagentModelChoice } from '../../../../../superagent/dsh/src/client/product-model-onboarding.js'
import { SETTINGS_SHELL_CSS, SettingsShell } from '../../../../../superagent/dsh/src/client/settings-shell.js'
import { FieldRow, SectionCard, StatGrid, EmptyState } from '../../../../../superagent/dsh/src/client/product-settings-components.js'
import { MainQuestion } from '../../../../../superagent/dsh/src/client/main-question.js'
import { FOLDER_CSS } from '../../../../../superagent/dsh/src/client/folder-menu.js'
import { SPRING_SHAPE, SPRING_TAP, useLinger } from '../../../../../superagent/dsh/src/client/motion.js'
import { CONVERSATION_CSS, SHELL_CSS } from '../../../../../superagent/dsh/src/client/styles.js'
import { allThemes, themeCss } from '../../../../../superagent/dsh/src/client/themes.js'
import previewCss from './desktop-preview.css'

const themes = allThemes()
const mainWorkspace = { title: 'SuperAgent workspace', path: 'C:/Work/Studio' }
const folders = [mainWorkspace, { title: 'Release notes', path: 'C:/Work/Release notes' }, { title: 'Design reviews', path: 'C:/Work/Design reviews' }]
const models = ['DeepSeek V4 Flash', 'DeepSeek V4 Pro', 'Local sample model']
const exampleText = 'Can you draft the release notes for the desktop update?'
const transcript = 'What has the Worker finished so far?'
const exampleReply = 'I opened a Ticket for the release notes. The Worker is checking the desktop changes. I’ll bring the draft back here.'
const spokenReply = 'The Worker has grouped the desktop changes. The draft is ready for a final wording pass.'
const roleLooks = { router: { shape: 'star', color: 'cyan' }, worker: { shape: 'kitty', color: 'orange' } }
const attention = { question: 'Should the release notes include the Classic Agent preview?', options: ['Include a short note', 'Keep it for later'], freeText: true }
const workLabels = { queued: 'Queued', working: 'In progress', done: 'Completed', stopped: 'Stopped', failed: 'Failed' }
const workChinese = { queued: '已接纳', working: '进行中', done: '已完成', stopped: '已停止', failed: '失败' }
const voiceLabels = { off: '', listening: 'Listening', waiting: 'Waiting for Main’s reply', reading: 'Speaking', paused: 'Paused' }
const voiceChinese = { listening: '正在收听', waiting: '等待本轮 Main 回复', reading: '正在朗读本轮回复', paused: '已暂停' }

function initial(scenario, epoch = 0) {
  return {
    scenario, epoch, boot: scenario === 'boot' ? 'starting' : 'ready', route: 'main', hidden: false,
    folder: mainWorkspace, workspaceError: '', model: scenario === 'settings' ? '' : models[0],
    draft: '', attachment: false, dictating: false, question: false, answer: '', error: '', voice: 'off', reason: '',
    work: scenario === 'settings' || scenario === 'boot' ? null : scenario === 'activity' ? 'queued' : 'working',
    messages: scenario === 'settings' || scenario === 'boot' ? [] : [{ id: 'example', user: exampleText, reply: exampleReply, work: true }],
    turn: null, receipt: 0, note: '',
  }
}

function transition(state, command) {
  const update = patch => ({ ...state, ...patch })
  const pause = reason => state.voice === 'off' ? {} : { voice: 'paused', reason }
  const sending = state.turn !== null
  switch (command.type) {
    case 'reset': return initial(command.value, state.epoch + 1)
    case 'mainReady': return state.boot === 'starting' ? update({ boot: 'handoff', note: '' }) : state
    case 'handoffDone': return state.boot === 'handoff' ? update({ boot: 'ready', note: 'Main 已就绪。焦点在输入框。' }) : state
    case 'bootFail': return state.boot === 'starting' ? update({ boot: 'failed', note: '启动失败。可在原窗口重试。' }) : state
    case 'retry': return state.boot === 'failed' ? update({ boot: 'starting', note: '' }) : state
    case 'folder': return update({ folder: command.value, workspaceError: '', note: '已更新下一条 Main 的目录。已接纳的 Ticket 继续用原目录。' })
    case 'folderError': return update({ workspaceError: 'This folder is outside the approved workspace. Choose an available folder.', note: '目录无访问权限。保留上一次选择。' })
    case 'model': return update({ model: command.value, note: 'Main 已选定模型。' })
    case 'draft': return update({ draft: command.value, error: '' })
    case 'attach': return update({ attachment: command.value })
    case 'dictate': return state.dictating
      ? update({ dictating: false, draft: [state.draft.trim(), transcript].filter(Boolean).join(' ') })
      : update({ dictating: true, note: '单次听写。再次点击麦克风将样例文本写入输入框。' })
    case 'send':
    case 'transcript': {
      const spoken = command.type === 'transcript'
      if (state.boot !== 'ready' || state.hidden || state.route !== 'main' || state.question || sending || !state.model) return state
      if (spoken ? state.voice !== 'listening' : state.voice !== 'off' || state.dictating || !state.draft.trim() && !state.attachment) return state
      const receipt = state.receipt + 1
      const turn = { id: receipt, user: spoken ? transcript : state.draft.trim(), attachment: !spoken && state.attachment, folder: state.folder.title }
      return update({ receipt, turn, messages: [...state.messages, turn], draft: spoken ? state.draft : '',
        attachment: spoken && state.attachment, folder: mainWorkspace, voice: spoken ? 'waiting' : 'off', reason: '', error: '',
        note: `Main 已接纳第 ${receipt} 条输入，使用 ${turn.folder}。` })
    }
    case 'otherReply': return state.voice === 'waiting' ? update({ note: '忽略与本次回执不匹配的回复。' }) : state
    case 'mainReply': return !sending ? state : update({ turn: null, voice: state.voice === 'waiting' ? 'reading' : state.voice,
      messages: state.messages.map(item => item.id === state.turn.id ? { ...item, reply: spokenReply } : item),
      note: state.voice === 'waiting' ? '收到当前回执对应的完整回复。' : 'Main 已回复。' })
    case 'speechEnded': return state.voice === 'reading' ? update({ voice: 'listening', note: '朗读完成，继续收听。' }) : state
    case 'voiceOpen': return !sending && state.model ? update({ voice: 'listening', reason: '', dictating: false, note: '' }) : state
    case 'voicePause': return state.voice === 'paused' ? update({ voice: 'listening', reason: '', note: '已手动继续。' })
      : update({ ...pause('Listening paused.'), note: '语音已暂停。' })
    case 'voiceClose': return update({ voice: 'off', reason: '', note: '连续语音已结束。' })
    case 'deny': return state.voice === 'listening' ? update(pause('Microphone permission denied. Resume to retry.')) : state
    case 'sendError': return state.voice === 'listening' ? update(pause('Could not send the transcription. Resume to retry.'))
      : state.draft.trim() || state.attachment ? update({ error: 'Could not send the message. Your draft is still here.', note: '发送失败。原草稿和目录保留，可重试。' }) : state
    case 'stopReply': return !sending ? state : update({ turn: null, ...pause('Main’s reply stopped. Resume to listen again.'),
      messages: state.messages.map(item => item.id === state.turn.id ? { ...item, stopped: true } : item),
      note: '已停止本轮回复。后台 Ticket 保持原状态。' })
    case 'question': return state.question || state.hidden ? state : update({ question: true, answer: '', dictating: false,
      ...pause('Main needs an answer. Resume to continue.'), note: '问题卡接管输入位。' })
    case 'answerDraft': return update({ answer: command.value })
    case 'answer': return update({ question: false, answer: '', note: state.voice === 'paused' ? '已回答。语音仍暂停。' : '回答已提交。',
      messages: [...state.messages, { id: `answer-${state.messages.length}`, user: command.value, reply: 'Got it. I’ll follow that for the release notes.' }] })
    case 'hide': return update({ hidden: true, dictating: false, ...pause('The window was hidden. Resume to listen again.'), note: '窗口已隐藏。' })
    case 'show': return update({ hidden: false, note: state.voice === 'paused' ? '窗口已恢复。语音仍暂停。' : '窗口已恢复。' })
    case 'route': return update({ route: command.value, voice: 'off', reason: '', dictating: false, note: '' })
    case 'workStart': return update({ work: 'working', note: 'Worker 开始处理原 Ticket。' })
    case 'workDone': return update({ work: 'done', note: 'Worker 已交付发布说明草稿。' })
    case 'workFail': return update({ work: 'failed', note: 'Worker 无法读取原工作目录，可以重试。' })
    case 'stopWork': return update({ work: 'stopped', note: '后台 Ticket 已停止。Main 和连续语音保持当前状态。' })
    default: return state
  }
}

function sendReview(data) {
  parent.postMessage({ preview: 'desktop', ...data }, '*')
}

function reviewState(state) {
  const items = pairs => pairs.map(([name, enabled = true]) => ({ name, enabled }))
  if (state.boot !== 'ready') {
    return { title: { starting: '正在启动', failed: '启动失败', handoff: '正在交接到 Main' }[state.boot], detail: state.note || '等待 Main 就绪。',
      events: items([['mainReady', state.boot === 'starting'], ['bootFail', state.boot === 'starting']]) }
  }
  if (state.hidden) return { title: '窗口已隐藏', detail: state.note, events: items([['show']]) }
  const active = state.voice !== 'off'
  const workActive = state.work === 'working'
  const ready = state.route === 'main' && !state.question
  const reply = ['mainReply', Boolean(state.turn)]
  const question = ['question', !state.question]
  const events = state.scenario === 'voice' ? items([
    ['transcript', ready && state.voice === 'listening' && !state.turn], ['otherReply', state.voice === 'waiting'], reply,
    ['speechEnded', state.voice === 'reading'], question, ['hide'], ['stopWork', workActive],
    ['deny', state.voice === 'listening'], ['sendError', state.voice === 'listening'],
  ]) : state.scenario === 'activity' ? items([
    ['workStart', !workActive], ['workDone', workActive], ['workFail', workActive], ['stopWork', workActive], question, reply,
  ]) : state.scenario === 'workspace' ? items([reply, ['sendError', ready && !state.turn && Boolean(state.draft.trim() || state.attachment)]]) : []
  const title = state.question ? '等待回答' : active ? voiceChinese[state.voice] : state.turn ? 'Main 正在回复'
    : state.scenario === 'activity' ? `Worker · ${workChinese[state.work]}` : state.model ? 'Main 已就绪' : 'Main 等待配置模型'
  const detail = state.note || (state.scenario === 'workspace' ? `下一条 · ${state.folder.title}。Ticket #24 · ${mainWorkspace.title}。`
    : active ? state.reason || '音频使用模拟状态。' : state.work ? `Ticket #24 · ${workChinese[state.work]}。`
      : state.model ? `当前模型 · ${state.model}。` : '可以通过 Main 引导或账户菜单选模型。')
  return { title, detail, events }
}

function DesktopMenu({ label, title, className, icon, text, items, disabled, alignEnd = false }) {
  const trigger = useRef(null)
  const panel = useRef(null)
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState(null)
  const [shown, leaving] = useLinger(open && placement, 120)
  const close = (restore = true) => {
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (!open) return undefined
    function place() {
      const box = trigger.current.getBoundingClientRect()
      const width = Math.min(254, innerWidth - 16)
      const below = innerHeight - box.bottom
      const lift = below < Math.min(box.top, 240)
      const left = alignEnd ? box.right - width : box.left
      setPlacement({ left: Math.max(8, Math.min(left, innerWidth - width - 8)), width, maxHeight: Math.max(48, (lift ? box.top : below) - 12),
        ...(lift ? { bottom: innerHeight - box.top + 5 } : { top: box.bottom + 5 }) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, alignEnd])
  const placed = Boolean(placement)
  useLayoutEffect(() => {
    if (!open || !placed) return
    const selected = panel.current?.querySelector('[aria-checked=true]') ?? panel.current?.querySelector('button')
    selected?.focus({ preventScroll: true })
  }, [open, placed])
  useEffect(() => {
    if (!open) return undefined
    const outside = event => {
      if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      const scrim = event.target.closest('.bt-scrim')
      const focusTarget = event.target.closest('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')
      if (!focusTarget) event.preventDefault()
      if (scrim) {
        scrim.addEventListener('click', click => click.stopImmediatePropagation(), { once: true, capture: true })
      }
      close(!focusTarget)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  function navigate(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { close(); return }
    const entries = [...panel.current.querySelectorAll('button:not(:disabled)')]
    if (!entries.length) return
    const index = entries.indexOf(document.activeElement)
    const next = { Home: 0, End: entries.length - 1, ArrowDown: (index + 1) % entries.length,
      ArrowUp: (index + entries.length - 1) % entries.length }[event.key]
    if (next === undefined) return
    event.preventDefault()
    entries[next].focus()
  }
  return <>
    <button ref={trigger} type="button" className={className} aria-label={label} title={title || label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={menuId} disabled={disabled} onClick={() => open ? close() : setOpen(true)}>{icon}{text ? <span>{text}</span> : null}</button>
    {shown && createPortal(<div ref={panel} id={menuId} lang="en" role="menu" aria-label={label} inert={leaving} aria-hidden={leaving || undefined}
      className={`bt-menu pv-menu${shown.bottom ? ' bt-menu-up' : ''}`} style={shown} data-leaving={leaving ? '' : undefined} onKeyDown={navigate}>
      {items.map(item => <button key={item.title} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked}
        tabIndex={-1} onClick={() => { close(); item.action() }}>{item.icon}<span className="bt-folder-copy"><span className="bt-menu-label">{item.title}</span>
          {item.detail ? <span className="bt-folder-path">{item.detail}</span> : null}</span>{item.checked ? <span className="bt-model-tick"><CheckIcon /></span> : null}</button>)}
    </div>, document.body)}
  </>
}

function FolderPicker({ current, wide, composer, change, fail, disabled }) {
  const items = folders.map(folder => ({ title: folder.title, detail: folder.path, checked: folder === current, action: () => change(folder) }))
  items.push({ title: 'Unavailable folder', detail: 'C:/Work/Restricted', icon: <FolderIcon />, action: fail })
  return <DesktopMenu label={composer ? 'Composer working folder' : 'Working folder'} title={`Working folder: ${current.title}`}
    className={composer ? 'pv-tool pv-folder-tool' : wide ? 'pv-workspace' : 'bt-round'} icon={<FolderIcon />}
    text={wide ? current.title : undefined} items={items} disabled={disabled} alignEnd={composer} />
}

function WorkCard({ phase, open, stop, retry }) {
  const mark = { queued: 'waiting', working: 'working', done: 'done', failed: 'alert' }[phase]
  return <article className="pv-ticket" aria-label="Ticket 24 Release notes">
    <header><span className="pv-ticket-id"><span className="pv-ticket-mark"><GaugeIcon /></span> Ticket #24</span><span className="pv-chip" data-work={phase}>{workLabels[phase]}</span></header>
    <h3>Draft desktop release notes</h3>
    <p>{phase === 'failed' ? 'The Worker couldn’t read the selected workspace.' : phase === 'done' ? 'The Worker delivered the draft.' : 'Summarize the changes to setup, workspaces, and voice.'}</p>
    <footer><span className="pv-ticket-owner"><BotMark look={roleLooks.worker} size={22} state={mark} />Worker</span><span className="pv-ticket-folder"><FolderIcon />{mainWorkspace.title}</span>
      {open ? <button type="button" className="pv-text-button" onClick={open}>View activity <ChevronRightIcon /></button> : null}
      {stop && phase === 'working' ? <button type="button" className="pv-text-button" onClick={stop}>Stop work</button> : null}
      {retry && phase === 'failed' ? <button type="button" className="pv-text-button" onClick={retry}>Retry work</button> : null}</footer>
  </article>
}

function Composer({ state, act, folder }) {
  const sending = Boolean(state.turn)
  const ready = Boolean(state.model)
  const content = Boolean(state.draft.trim() || state.attachment)
  const label = sending ? 'Stop reply' : content ? 'Send' : 'Start voice chat'
  const icon = sending ? <span className="pv-stop-icon" /> : content ? <ArrowUpIcon /> : <WaveIcon />
  const submit = event => { event.preventDefault(); act('send') }
  return <form className="pv-composer" onSubmit={submit}>
    {state.error || state.workspaceError ? <p className="pv-input-error" role="alert">{state.error || state.workspaceError}</p> : null}
    {state.attachment ? <div className="pv-attachment"><PaperclipIcon /><span>release-checklist.md</span><button type="button" className="pv-tool" aria-label="Remove release-checklist.md" onClick={() => act('attach', false)}><CloseIcon /></button></div> : null}
    <div className="pv-compose-row">
      <DesktopMenu label="Add attachment" className="pv-tool" icon={<PlusIcon />} disabled={!ready || sending}
        items={[{ title: 'Attach release-checklist.md', icon: <PaperclipIcon />, action: () => act('attach', true) }]} />
      <textarea id="main-message" rows={1} aria-label="Message Main" placeholder={ready ? 'Message Main' : 'Choose a model to message Main'} disabled={!ready}
        value={state.draft} onChange={event => act('draft', event.currentTarget.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
        }} />
      <div className="pv-composer-actions">
        <FolderPicker {...folder} composer disabled={!ready} />
        <button type="button" className="pv-tool" aria-label={state.dictating ? 'Finish dictation' : 'Start dictation'} title={state.dictating ? 'Finish dictation' : 'Start dictation'}
          aria-pressed={state.dictating} disabled={!ready || sending} onClick={() => act('dictate')}><MicIcon /></button>
        <button type={!sending && content ? 'submit' : 'button'} className="pv-primary-tool" aria-label={label} title={label}
          disabled={!ready || state.dictating} onClick={sending ? () => act('stopReply') : !content ? () => act('voiceOpen') : undefined}>
          <span className="pv-primary-glyph" key={label}>{icon}</span>
        </button>
      </div>
    </div>
    {state.dictating ? <div className="pv-compose-status" role="status">Listening for dictation…</div> : null}
  </form>
}

function Voice({ phase, reason, canStop, act }) {
  const visualPhase = { waiting: 'thinking', reading: 'speaking' }[phase] ?? phase
  const look = { waiting: 'thinking', reading: 'sending' }[phase] ?? 'idle'
  return <section className="bt-voice-pane pv-voice" aria-label="Voice chat with Main">
    <div className="bt-voice-stage" data-phase={visualPhase}>
      <div className="bt-voice-orb"><span className="bt-voice-ring" aria-hidden="true" /><span className="bt-voice-ring bt-voice-ring-2" aria-hidden="true" />
        <BotMark look={MAIN_LOOK} size={112} state={look} live gaze={phase === 'listening'} /></div>
      <div className="bt-voice-name">Main</div><div className="bt-voice-status" role="status">{voiceLabels[phase]}</div>
      <div className="bt-voice-caption" key={phase}>{phase === 'reading' ? spokenReply : phase === 'waiting' ? transcript : ''}</div>
      {reason ? <div className="bt-voice-note" role="status">{reason}</div> : null}
    </div>
    <div className="bt-voice-bar">
      <button type="button" data-voice-focus className="bt-voice-btn" aria-label={phase === 'paused' ? 'Resume listening' : 'Pause voice'} title={phase === 'paused' ? 'Resume listening' : 'Pause voice'}
        aria-pressed={phase === 'paused'} onClick={() => act('voicePause')}><MicIcon size={20} />{phase === 'paused' ? <span className="bt-voice-slash" /> : null}</button>
      {canStop ? <button type="button" className="bt-voice-btn" aria-label="Stop reply" title="Stop reply" onClick={() => act('stopReply')}><span className="pv-stop-icon" /></button> : null}
      <button type="button" className="bt-voice-btn bt-voice-end" aria-label="End voice chat" title="End voice chat" onClick={() => act('voiceClose')}><CloseIcon /></button>
    </div>
  </section>
}

function Startup({ phase, reduced, act }) {
  const logo = useRef(null)
  useLayoutEffect(() => {
    if (phase !== 'handoff') return undefined
    const finish = () => act('handoffDone')
    if (reduced) { finish(); return undefined }
    const from = logo.current.getBoundingClientRect()
    const target = document.querySelector('.pv-main-header .bt-mark')?.getBoundingClientRect()
    if (!target?.width) { finish(); return undefined }
    const scale = target.width / from.width
    const start = { transform: 'translate(0, 0) scale(1)' }
    const end = { transform: `translate(${target.x - from.x}px, ${target.y - from.y}px) scale(${scale})` }
    const animation = logo.current.animate([start, end], { duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing, fill: 'both' })
    animation.onfinish = finish
    return () => { animation.onfinish = null; animation.cancel() }
  }, [phase, reduced])
  if (phase === 'ready') return null
  const failed = phase === 'failed'
  return <div className="pv-start" data-phase={phase}>
    <div className="pv-start-fill" />
    <div className="pv-start-content">
      <div className="pv-start-orbit" data-failed={failed || undefined}><div className="pv-start-ring" aria-hidden="true" />
        <span className="pv-start-mark" ref={logo}><BotMark look={MAIN_LOOK} size={108} state={phase === 'starting' ? 'thinking' : 'idle'} /></span></div>
      <div className="pv-start-copy"><h1>DS SuperAgent</h1>
        {failed ? <><p role="alert">Main did not become ready.</p><button type="button" data-retry className="pv-send-button" onClick={() => act('retry')}>Retry</button></>
          : <p role="status">{phase === 'handoff' ? 'Main is ready' : 'Starting Main…'}</p>}
      </div>
    </div>
  </div>
}

function SignIn({ onClose, onSelect }) {
  const dialog = useRef(null)
  useEffect(() => { dialog.current.showModal() }, [])
  return <dialog ref={dialog} className="pv-sign-in" aria-labelledby="sample-account" onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div><ProductBrandMark size={36} /><h2 id="sample-account">Sign in to DeepSeek</h2>
      <p>Try the flow with a sample account.</p>
      <div className="pv-dialog-actions"><button type="button" className="bt-soft" onClick={onClose}>Cancel</button>
        <button type="button" className="pv-send-button" onClick={onSelect}>Use sample account</button></div></div>
  </dialog>
}

function Desktop({ state, dispatch, appearance }) {
  const act = (type, value) => dispatch({ type, value })
  const [narrow, setNarrow] = useState(() => innerWidth < 770)
  const [collapsed, setCollapsed] = useState(false)
  const [settings, setSettings] = useState(null)
  const [login, setLogin] = useState(false)
  const [connector, setConnector] = useState(false)
  const scroll = useRef(null)
  const origin = useRef(null)
  const previous = useRef(null)
  const wide = !narrow
  const main = state.route === 'main'
  const voice = state.voice !== 'off' && !state.question && main
  const busy = Boolean(state.turn)
  const markState = state.question ? 'alert' : busy ? 'thinking' : state.messages.at(-1)?.reply && state.receipt ? 'done' : 'idle'
  const settingOpen = settings?.open === true
  const covered = state.boot !== 'ready' || state.hidden || settingOpen || login
  useEffect(() => {
    const onResize = () => setNarrow(innerWidth < 770)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = state
    if (state.boot === 'failed' && before?.boot !== 'failed') document.querySelector('[data-retry]')?.focus({ preventScroll: true })
    if (state.hidden && !before?.hidden) document.querySelector('[data-restore-window]')?.focus({ preventScroll: true })
    if (covered) return
    if (state.question && (!before?.question || before.hidden || before.route !== state.route) && main) document.querySelector('.bt-q-opt')?.focus({ preventScroll: true })
    else if (voice && (before?.question || before?.hidden || before?.voice === 'off')) document.querySelector('[data-voice-focus]')?.focus({ preventScroll: true })
    else if (before && (before.boot !== 'ready' || before.hidden || before.voice !== 'off' && !voice || before.route !== state.route && main)) {
      document.getElementById('main-message')?.focus({ preventScroll: true })
    }
  }, [state, covered, main, voice])
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [state.messages, busy, voice])
  useEffect(() => {
    const escape = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || covered || !voice || document.querySelector('[role=menu]:not([data-leaving])')) return
      event.preventDefault()
      act('voiceClose')
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [covered, voice])
  useEffect(() => {
    if (state.hidden) { setSettings(null); setLogin(false) }
  }, [state.hidden])
  function openSettings(page) {
    origin.current = document.activeElement
    setSettings({ page, open: true })
  }
  function returnFocus() {
    requestAnimationFrame(() => {
      const target = origin.current?.isConnected ? origin.current : document.getElementById('main-message')
      target?.focus({ preventScroll: true })
    })
  }
  function closeSettings() {
    setSettings(setting => ({ ...setting, open: false }))
    returnFocus()
  }
  function openLogin() {
    origin.current = document.activeElement
    setLogin(true)
  }
  function closeLogin() { setLogin(false); returnFocus() }
  const folder = { current: state.folder, change: value => act('folder', value), fail: () => act('folderError') }
  const heading = () => <><ProductBrandMark size={24} /><span>DS SuperAgent</span></>
  const panelTitle = state.work === 'failed' ? 'Needs attention' : 'Work activity'
  const links = [
    { key: 'main', label: 'Main', icon: <BotMark look={MAIN_LOOK} size={wide ? 60 : 44} state={markState} live gaze /> },
    { key: 'activity', label: 'Activity', icon: <GaugeIcon /> },
  ]
  const showActivity = () => act('route', 'activity')
  const chooseModel = model => { act('model', model); closeSettings() }
  const modelMenu = <DesktopMenu className="pv-settings-select" label="Choose Main model" icon={<SlidersIcon />} text={state.model || 'Choose a model'} alignEnd
    items={models.map(model => ({ title: model, detail: model === models[2] ? 'Local provider' : 'DeepSeek', checked: state.model === model, action: () => act('model', model) }))} />
  const sections = {
    models: { render: () => <><SectionCard title="Main model"><FieldRow label="Model" control={modelMenu} /></SectionCard><SectionCard title="Providers"><FieldRow label="DeepSeek" control={<span className="pv-chip">Fixture provider</span>} /><FieldRow label="Local provider" control={<button type="button" className="bt-soft-sm" onClick={() => chooseModel(models[2])}>Use sample model</button>} /></SectionCard></> },
    general: { render: () => <SectionCard title="Appearance"><FieldRow label="Theme" control={<span>{themes[appearance.theme].label}</span>} /><FieldRow label="Color mode" control={<span>{appearance.dark ? 'Dark' : 'Light'}</span>} /><FieldRow label="Motion" control={<span>{appearance.reduced ? 'Reduced' : 'Normal'}</span>} /></SectionCard> },
    connectors: { render: () => <SectionCard title="Connected services"><FieldRow label="Mail" hint="Sample connector" control={<button type="button" className="bt-soft-sm" onClick={() => setConnector(value => !value)}>{connector ? 'Disconnect' : 'Connect'}</button>} />
      <FieldRow label="Status" control={<span className="pv-chip">{connector ? 'Connected' : 'Not connected'}</span>} /></SectionCard> },
    'usage-overview': { render: () => <SectionCard title="Today"><StatGrid items={[{ label: 'Main requests', value: String(state.receipt + Number(Boolean(state.work))) }, { label: 'Tickets', value: state.work ? '1' : '0' }]} columns={2} /></SectionCard> },
    status: { render: () => <SectionCard title="Host"><FieldRow label="Local connection" control={<span className="pv-chip">Ready</span>} /></SectionCard> },
    'scheduled-tasks': { render: () => <EmptyState title="No scheduled tasks" /> },
    calendar: { render: () => <EmptyState title="Nothing scheduled today" /> },
  }

  return <>
    <div className="pv-window" inert={covered}>
      <header className="pv-titlebar"><button type="button" className="pv-tool" aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'} title={collapsed ? 'Show sidebar' : 'Hide sidebar'} onClick={() => setCollapsed(value => !value)}><SidebarIcon /></button>
        <div className="pv-titlebar-brand">{heading()}</div>
        <button type="button" className="pv-tool pv-minimize" aria-label="Hide window" title="Hide window" onClick={() => act('hide')}><span /></button>
      </header>
      <div className="pv-shell" data-sidebar={collapsed ? 'hidden' : narrow ? 'rail' : 'wide'}>
        <aside className="pv-sidebar" inert={collapsed} aria-label="Workspace and navigation">
          <div className="pv-sidebar-tools"><FolderPicker {...folder} wide={wide} /></div>
          <nav className="pv-nav" aria-label="Work navigation">
            {links.map(item => <button key={item.key} type="button" title={item.label} aria-label={item.label}
              className={item.key === 'main' && wide ? 'bt-tile pv-main-tile' : 'bt-row pv-nav-row'} aria-current={state.route === item.key ? 'page' : undefined}
              onClick={() => act('route', item.key)}>{item.icon}{wide ? <span>{item.label}</span> : null}{item.key === 'main' && state.question ? <span className="pv-attention" aria-label="Waiting for your answer">?</span> : null}</button>)}
          </nav>
          <SuperagentAccountFooter wide={wide} modalOpen={settingOpen || login} openSettings={openSettings} signIn={state.model ? undefined : openLogin} />
        </aside>
        <main className="pv-main" aria-label={main ? 'Main conversation' : 'Work activity'}>
          <div className="pv-main-header"><ProductShellHeader activity={!main} markState={markState} onMain={() => act('route', 'main')} onActivity={showActivity} /></div>
          {!main ? <div className="pv-activity">
            <div className="pv-activity-title"><h1>{panelTitle}</h1><p>{state.work ? 'One Ticket in this workspace' : 'No Tickets in this workspace'}</p></div>
            <div className="pv-role-list"><div><BotMark look={MAIN_LOOK} size={36} state={markState} /><span><strong>Main</strong><small>{state.question ? 'Waiting for your answer' : busy ? 'Thinking' : 'Ready'}</small></span></div>
              <div><BotMark look={roleLooks.router} size={36} state={state.work === 'queued' ? 'orbit' : 'idle'} /><span><strong>Router</strong><small>{state.work === 'queued' ? 'Assigning Ticket' : state.work ? 'Ticket assigned' : 'Ready'}</small></span></div>
              <div><BotMark look={roleLooks.worker} size={36} state={{ working: 'working', done: 'done', failed: 'alert' }[state.work]} /><span><strong>Worker</strong><small>{workLabels[state.work] || 'Idle'}</small></span></div></div>
            {state.work ? <WorkCard phase={state.work} stop={() => act('stopWork')} retry={() => act('workStart')} /> : null}
          </div> : voice ? <Voice phase={state.voice} reason={state.reason} canStop={busy} act={act} /> : <>
            <div className="pv-chat-scroll" ref={scroll}><div className="pv-chat">
              {state.messages.length ? <div className="pv-day">Today</div> : null}
              {state.messages.map(item => <div className="pv-turn" key={item.id}>
                <div className="pv-user-line"><div className="bt-ububble">{item.attachment ? <span className="pv-inline-file"><PaperclipIcon />release-checklist.md</span> : null}{item.user}</div></div>
                {item.reply ? <div className="bt-astack" data-lead=""><div className="bt-msg"><div className="bt-msg-line"><BotMark look={MAIN_LOOK} size={22} /><div className="bt-bubble">{item.reply}</div></div></div></div> : null}
                {item.work ? <div className="pv-ticket-in-chat"><WorkCard phase={state.work} open={showActivity} /></div> : null}
                {item.stopped ? <p className="pv-turn-state">Reply stopped</p> : null}
              </div>)}
              {busy ? <div className="pv-action-row" role="status"><BotMark look={MAIN_LOOK} size={28} state="thinking" /><span className="bt-shimmer">Main is thinking…</span></div> : null}
              {!state.model ? <div className="pv-first-model"><SuperagentModelChoice setup={{ keyProvider: 'deepseek-official', canChooseModel: false }} signIn={openLogin}
                saveKey={async (provider, value) => { if (provider !== 'deepseek-official' || value.trim() !== 'sample-key') throw Error('Invalid sample key'); act('model', models[0]); return true }}
                openCustomModels={() => openSettings('models')} /></div> : null}
              {!state.messages.length && state.model ? <div className="pv-empty-chat"><BotMark look={MAIN_LOOK} size={64} live gaze /><h1>What are we working on?</h1></div> : null}
            </div></div>
            <div className="pv-input-dock">
              {state.question ? <MainQuestion attention={attention} draft={state.answer} onDraft={value => act('answerDraft', value)} onSubmit={value => act('answer', value)} />
                : <Composer state={state} act={act} folder={folder} />}
            </div>
          </>}
        </main>
      </div>
    </div>
    {state.hidden ? <div className="pv-start pv-hidden-window"><div className="pv-start-fill" /><div className="pv-start-content"><ProductBrandMark size={42} /><h1>DS SuperAgent</h1>
      <button type="button" data-restore-window className="pv-send-button" onClick={() => act('show')}>Restore window</button></div></div> : null}
    <Startup phase={state.boot} reduced={appearance.reduced} act={act} />
    {settings ? <SettingsShell open={settingOpen} onClose={closeSettings} initialPage={settings.page} sections={sections} /> : null}
    {login ? <SignIn onClose={closeLogin} onSelect={() => { act('model', models[0]); closeLogin() }} /> : null}
  </>
}

function App() {
  const [state, dispatch] = useReducer(transition, 'workspace', initial)
  const [appearance, setAppearance] = useState({ theme: 'deepseek', dark: false, reduced: false })
  useLayoutEffect(() => {
    document.body.toggleAttribute('data-ds-dark-theme', appearance.dark)
    document.body.toggleAttribute('data-preview-reduced', appearance.reduced)
    document.body.dataset.btMotion = appearance.reduced ? 'quiet' : 'normal'
    document.documentElement.style.colorScheme = appearance.dark ? 'dark' : 'light'
  }, [appearance])
  useEffect(() => {
    const receive = event => {
      if (event.source !== parent || event.data?.preview !== 'desktop') return
      const message = event.data
      if (message.type === 'appearance' && Object.hasOwn(themes, message.theme)) {
        setAppearance({ theme: message.theme, dark: Boolean(message.dark), reduced: Boolean(message.reduced) })
      } else if (message.type === 'scenario' && ['workspace', 'settings', 'voice', 'activity', 'boot'].includes(message.choice)) {
        dispatch({ type: 'reset', value: message.choice })
      } else if (message.type === 'event') dispatch({ type: message.name })
    }
    window.addEventListener('message', receive)
    sendReview({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  const review = reviewState(state)
  const eventKey = JSON.stringify(review.events)
  useEffect(() => { sendReview({ type: 'state', title: review.title, detail: review.detail, events: JSON.parse(eventKey) }) }, [review.title, review.detail, eventKey])
  return <>
    <style>{`${SHELL_CSS}${CONVERSATION_CSS}${SETTINGS_SHELL_CSS}${FOLDER_CSS}${MODEL_ONBOARDING_CSS}
      :root { --pv-tap: ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}; --pv-shape: ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}; }
      ${previewCss}`}</style>
    <style>{themeCss(themes[appearance.theme])}</style>
    <Desktop key={state.epoch} state={state} dispatch={dispatch} appearance={appearance} />
  </>
}

createRoot(document.getElementById('preview')).render(<App />)
