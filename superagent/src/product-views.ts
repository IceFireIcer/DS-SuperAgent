import { checkShownView, validateViewAnswer, viewReply, viewReplyText } from 'deep-view/core'
import { CoreError } from './model.js'
import { sanitizeSecrets } from './sanitize.js'

export interface ProductViewCard {
  title: string
  view: Record<string, unknown>
}

export interface ProductViewAnswer {
  action: string
  values: Record<string, unknown>
}

type Sanitizer = (text: string) => string

function sanitizeValue(value: unknown, sanitize: Sanitizer): unknown {
  if (typeof value === 'string') return sanitize(value)
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, sanitize))
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, { value: sanitizeValue(item, sanitize), enumerable: true, configurable: true, writable: true })
  }
  return result
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `${label} must be a JSON object.`)
  return value as Record<string, unknown>
}

function shown(title: unknown, view: unknown): ProductViewCard {
  const checked = checkShownView(title, view)
  if (checked.error !== undefined || !checked.view || typeof checked.title !== 'string') {
    throw new CoreError('INVALID_VIEW', checked.error ?? 'The view card could not be validated.')
  }
  return { title: checked.title, view: structuredClone(checked.view) }
}

export function parseReportView(value: unknown): ProductViewCard {
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 8192) throw new CoreError('INVALID_VIEW', 'The report view exceeds the 8 KiB limit.')
    try { parsed = JSON.parse(value) } catch { throw new CoreError('INVALID_VIEW', 'The report view must be JSON.') }
  }
  const source = record(parsed, 'view')
  const card = shown(source.title, source.view)
  const checked = checkShownView(card.title, card.view)
  if (checked.interactive) throw new CoreError('INVALID_VIEW', 'A completed report can contain a display-only view; use show_view for an answerable view.')
  return card
}

export function parseInteractiveView(title: unknown, value: unknown): ProductViewCard {
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 8192) throw new CoreError('INVALID_VIEW', 'The view exceeds the 8 KiB limit.')
    try { parsed = JSON.parse(value) } catch { throw new CoreError('INVALID_VIEW', 'The view must be JSON.') }
  }
  const card = shown(title, parsed)
  const checked = checkShownView(card.title, card.view)
  if (!checked.interactive) throw new CoreError('INVALID_VIEW', 'This view has nothing to submit; put a display-only view on report_ready.')
  return card
}

export function sanitizeProductView(card: ProductViewCard, sanitize: Sanitizer = sanitizeSecrets): ProductViewCard {
  return shown(sanitize(card.title), sanitizeValue(card.view, sanitize))
}

export function validateProductViewAnswer(card: ProductViewCard, action: unknown, values: unknown, sanitize: Sanitizer = sanitizeSecrets): {
  answer: ProductViewAnswer
  text: string
} {
  if (typeof action !== 'string' || !action) throw new CoreError('INVALID_INPUT', 'A view answer needs the submitted component ID.')
  const input = record(values, 'values')
  const checked = validateViewAnswer(card.view, action, input)
  if (checked.error !== undefined) throw new CoreError('INVALID_INPUT', checked.error)
  const { error: _error, ...normalized } = checked
  const safeAnswer = sanitizeValue({ action, values: normalized }, sanitize) as ProductViewAnswer
  const reply = viewReply({ id: 'work-view', title: card.title, view: card.view }, safeAnswer.action, safeAnswer.values, 'user')
  if (!reply) throw new CoreError('INVALID_INPUT', 'The view answer could not be validated.')
  return {
    answer: structuredClone(safeAnswer),
    text: viewReplyText(reply.text),
  }
}
