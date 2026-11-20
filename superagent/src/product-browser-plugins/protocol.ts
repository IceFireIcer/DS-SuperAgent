import { CoreError } from '../model.js'

export const browserModes = ['off', 'refs', 'script', 'task'] as const
export type BrowserMode = typeof browserModes[number]
export type InteractiveBrowserMode = Exclude<BrowserMode, 'off'>
export interface BrowserPluginSetting { mode: BrowserMode; revision: number }

export type BrowserStep = { action: 'snapshot' } | { action: 'open'; url: string } | { action: 'follow'; ref: string }
export type BrowserAdapterRequest = { profileKey: string; action: BrowserStep['action']; url?: string; ref?: string;
  referenceScope?: string }

export class BrowserStepRejected extends CoreError {
  constructor(code: 'BROWSER_NO_PAGE' | 'BROWSER_REF_STALE' | 'BROWSER_LINK_DENIED', message: string) { super(code, message) }
}

export function browserMode(value: unknown): BrowserMode {
  if (value === 'off' || value === 'refs' || value === 'script' || value === 'task') return value
  throw new CoreError('INVALID_INPUT', 'Choose an available browser plugin mode.')
}

export function webUrl(value: unknown) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 2048 || !URL.canParse(value)) {
    throw new CoreError('INVALID_INPUT', 'Open an HTTP or HTTPS page.')
  }
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('INVALID_INPUT', 'Open an HTTP or HTTPS page without embedded credentials.')
  }
  return url
}

export function parseBrowserStep(value: unknown): BrowserStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Choose a browser step.')
  const step = value as Record<string, unknown>
  const keys = Object.keys(step)
  if (step.action === 'open' && keys.length === 2 && Object.hasOwn(step, 'url')) {
    return { action: 'open', url: webUrl(step.url).href }
  }
  if (step.action === 'snapshot' && keys.length === 1) return { action: 'snapshot' }
  if (step.action === 'follow' && keys.length === 2 && Object.hasOwn(step, 'ref')
    && typeof step.ref === 'string' && /^e[1-9]\d?-[a-f0-9]{16}$/u.test(step.ref)) {
    return { action: 'follow', ref: step.ref }
  }
  throw new CoreError('INVALID_INPUT', 'Use open, snapshot, or one link reference from the latest snapshot.')
}
