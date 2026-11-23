// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/host/computer/{index,catalog}.js.
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const protectedIdentity = /(?:^|[\s._/\\-])(?:superagent|dsbot|dsh|computer.use|cua.driver|powershell|pwsh|cmd|terminal|console|bash|sh|zsh|code|codex|regedit|taskmgr|settings|control|credential|keychain|passwords|chrome|chromium|firefox|msedge|safari|brave|opera|vivaldi|explorer|finder|electron|systemsettings|applicationframehost|rundll32|runas|msiexec|consent|ssh|putty|mstsc|remotedesktop)(?:$|[\s._/\\-])/iu
const cleanLabel = value => typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').trim().slice(0, 100) : ''
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const rows = (value, key) => Array.isArray(value?.[key]) ? value[key].slice(0, 400) : []
const positiveId = value => Number.isSafeInteger(value) && value > 0

async function appIdentity(row, platform, ownPids) {
  const pid = row?.pid
  if (!positiveId(pid) || ownPids.has(pid) || row.running === false) return null
  const name = cleanLabel(row.name ?? row.app_name)
  const path = row.executable_path ?? row.executablePath ?? row.exe_path ?? row.launch_path ?? row.path
  const bundle = row.bundle_id ?? row.bundleId
  if (!name || typeof path !== 'string' || !isAbsolute(path) || path.length > 2048 || /[\u0000-\u001f]/u.test(path)
    || [name, bundle, path].some(value => typeof value === 'string' && protectedIdentity.test(value))) return null
  try {
    const resolved = await realpath(path)
    if (protectedIdentity.test(resolved) || platform === 'win32' && !/\.exe$/iu.test(resolved)) return null
    const file = await stat(resolved, { bigint: true })
    if (!file.isFile()) return null
    const key = createHash('sha256').update(JSON.stringify([platform, platform === 'win32' ? resolved.toLowerCase() : resolved,
      typeof bundle === 'string' ? bundle : null, String(file.dev), String(file.ino), String(file.birthtimeNs), String(file.mtimeNs), String(file.size)])).digest('hex')
    return { id: `app-${key}`, name, pid, active: row.active === true }
  } catch { return null }
}

function allowedPermissions(result, platform) {
  if (platform === 'win32') return result.uia === true && result.post_message === true && result.elevated === false
  if (platform === 'linux') return result.x11 === true && result.wayland !== true && result.atspi === true && result.xsend_event === true
  return result.accessibility === true && result.screen_recording === true && result.session_locked !== true
}

function imageOf(result) {
  const image = rows(result, 'content').find(entry => entry?.type === 'image' && entry.mimeType === 'image/png')
  if (typeof image?.data !== 'string' || image.data.length > 1_000_000 || !/^[a-z0-9+/]+={0,2}$/iu.test(image.data)) return undefined
  const header = Buffer.from(image.data.slice(0, 40), 'base64')
  if (header.length < 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384) return undefined
  return { image: { mimeType: 'image/png', data: image.data }, width, height }
}

function windowDetails(row) {
  const bounds = object(row.bounds ?? row.window_bounds ?? row.frame)
  const windowId = row.window_id ?? row.windowId
  if (!positiveId(windowId) || !positiveId(row.pid)) return null
  return { windowId, pid: row.pid, order: row.z_index,
    onScreen: row.is_on_screen === true && row.is_minimized !== true,
    bounds: { x: bounds.x ?? bounds.left, y: bounds.y ?? bounds.top, width: bounds.width, height: bounds.height } }
}

const sameBounds = (left, right) => ['x', 'y', 'width', 'height'].every(key => Number.isFinite(left[key])
  && Number.isFinite(right[key]) && left[key] === right[key])
const clearPermissions = () => new Error('Desktop permissions could not be verified.')
const covers = ({ bounds: { x, y, width, height } }, point) => Number.isFinite(x) && Number.isFinite(y)
  && x <= point.x && point.x < x + width && y <= point.y && point.y < y + height

export function createComputerDriver({ platform = process.platform, load = () => import('@trycua/cua-driver'),
  ownPids = new Set([process.pid, process.ppid]), canUseForeground = async () => false, onCursor = async () => {} } = {}) {
  let driver
  let opening
  let toolSchemas
  let closed = false
  let observed
  const ensure = () => {
    if (closed || !['win32', 'linux', 'darwin'].includes(platform)) throw new Error('Computer driver unavailable.')
    return opening ??= load().then(async ({ CuaDriver }) => {
      if (closed) throw new Error('Computer driver closed.')
      driver = CuaDriver.create(undefined)
      const catalog = JSON.parse(await driver.listToolsJson({ signal: AbortSignal.timeout(5000) }))
      toolSchemas = new Map(rows(catalog, 'tools').map(item => [item.name, object(item.inputSchema ?? item.input_schema)]))
      if (!toolSchemas.has('check_permissions') || !toolSchemas.has('list_apps') || !toolSchemas.has('list_windows')
        || !toolSchemas.has('get_window_state')) throw new Error('Expected computer driver tools are missing.')
      return driver
    })
  }
  const invoke = async (name, args, signal, launchInput) => {
    signal.throwIfAborted()
    const native = await ensure()
    signal.throwIfAborted()
    if (!toolSchemas.has(name)) throw new Error('The native driver does not support this action.')
    const input = JSON.stringify(args)
    const send = async () => {
      const { rawJson } = await native.callTool(name, input, { signal })
      signal.throwIfAborted()
      if (typeof rawJson !== 'string' || rawJson.length > 12_000_000) throw new Error('Invalid computer driver response.')
      const result = JSON.parse(rawJson)
      if (!result || result.isError === true || result.is_error === true) throw new Error('The computer driver refused the action.')
      return { raw: result, body: object(result.structuredContent ?? result.structured_content ?? result) }
    }
    return launchInput ? launchInput(send) : send()
  }
  const status = async signal => {
    try { await ensure() } catch { return 'unavailable' }
    try { return allowedPermissions((await invoke('check_permissions', { prompt: false }, signal)).body, platform) ? 'ready' : 'permission-required' }
    catch { signal.throwIfAborted(); return 'permission-required' }
  }
  const apps = async signal => {
    const { body } = await invoke('list_apps', {}, signal)
    return (await Promise.all(rows(body, 'apps').map(row => appIdentity(row, platform, ownPids)))).filter(Boolean)
  }
  const windows = async (app, signal) => {
    const { body } = await invoke('list_windows', { pid: app.pid }, signal)
    return rows(body, 'windows').map(windowDetails).filter(window => window?.pid === app.pid)
  }
  const background = name => {
    const properties = object(toolSchemas.get(name)?.properties)
    if (properties.delivery_mode?.enum?.includes('background')) return { delivery_mode: 'background' }
    if (properties.foreground?.type === 'boolean') return { foreground: false }
    throw new Error('The provider cannot explicitly address this operation to the background window.')
  }
  return {
    status,
    async apps(signal) {
      if (await status(signal) !== 'ready') throw clearPermissions()
      const seen = new Set()
      return (await apps(signal)).filter(app => {
        if (seen.has(app.id)) return false
        seen.add(app.id)
        return true
      }).map(({ id, name }) => ({ id, name }))
    },
    async execute(action, signal, authorize, launchInput) {
      if (await status(signal) !== 'ready') throw clearPermissions()
      await authorize()
      const currentApps = (await apps(signal)).filter(app => app.id === action.appId)
      if (currentApps.length !== 1) throw new Error('The approved application is not uniquely running.')
      const app = currentApps[0]
      await authorize()
      const listed = await windows(app, signal)
      if (action.action === 'windows') return { windows: listed.map(({ windowId, onScreen }) => ({ windowId, onScreen })) }
      const target = listed.find(window => window.windowId === action.windowId)
      if (!target || !target.onScreen) throw new Error('The approved application does not own a visible copy of that window.')
      const selected = { pid: app.pid, window_id: target.windowId }
      if (action.action !== 'snapshot' && (!observed || observed.appId !== app.id || observed.pid !== app.pid
        || observed.windowId !== target.windowId || !sameBounds(observed.bounds, target.bounds) || Date.now() > observed.until)) {
        throw new Error('Read a fresh snapshot of the current window first.')
      }
      if (await status(signal) !== 'ready') throw clearPermissions()
      await authorize()
      if (action.action === 'snapshot') {
        const properties = object(toolSchemas.get('get_window_state')?.properties)
        const screenshot = properties.include_screenshot?.type === 'boolean' ? { include_screenshot: true } : {}
        const accessibility = properties.include_accessibility_tree?.type === 'boolean' ? { include_accessibility_tree: false } : {}
        const result = await invoke('get_window_state', { ...selected, ...screenshot, ...accessibility }, signal)
        const screen = imageOf(result.raw)
        if (!screen) throw new Error('The provider returned no usable screenshot for the approved window.')
        observed = { appId: app.id, pid: app.pid, windowId: target.windowId, bounds: target.bounds,
          width: screen.width, height: screen.height, until: Date.now() + 20_000 }
        return { screenshot: screen.image }
      }
      if (typeof launchInput !== 'function') throw new Error('Desktop input requires a tracked dispatch.')
      const view = observed
      observed = undefined
      if (action.action === 'click' && action.point?.x >= 0 && action.point.y >= 0
        && action.point.x < view.width && action.point.y < view.height) {
        await invoke('click', { ...selected, ...action.point, ...background('click') }, signal, launchInput)
        try {
          if (app.active && Number.isFinite(target.bounds.x) && Number.isFinite(target.bounds.y)) {
            const point = { x: target.bounds.x + action.point.x * target.bounds.width / view.width,
              y: target.bounds.y + action.point.y * target.bounds.height / view.height, pid: app.pid }
            const { body } = await invoke('list_windows', {}, signal)
            const top = rows(body, 'windows').map(windowDetails).filter(window => window?.onScreen && covers(window, point))
            if (top.length && top.every(window => Number.isSafeInteger(window.order))) {
              top.sort((left, right) => left.order - right.order)
              if (top[0].windowId === target.windowId && top[0].pid === app.pid && top[0].order !== top[1]?.order) await onCursor(point, signal)
            }
          }
        } catch {}
      } else if (action.action === 'type' && typeof action.text === 'string') {
        await invoke('type_text', { ...selected, text: action.text, ...background('type_text') }, signal, launchInput)
      } else if (action.action === 'activate') {
        if (!await canUseForeground(signal)) throw new Error('The user is using the desktop. Foreground access is not available.')
        await authorize()
        await invoke('bring_to_front', selected, signal, launchInput)
      } else throw new Error('Unsupported or out-of-window computer action.')
      return {}
    },
    reset() { observed = undefined },
    async close() {
      closed = true
      observed = undefined
      await opening?.catch(() => {})
      if (driver) {
        try { await driver.shutdown() } finally { driver.uniffiDestroy?.(); driver = undefined }
      }
    },
  }
}
