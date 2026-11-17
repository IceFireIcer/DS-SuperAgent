import { Buffer, isUtf8 } from 'node:buffer'
import { CoreError, identifier } from './model.js'

export type MemoryImportOriginalScope = {
  kind: 'main' | 'work' | 'shared' | 'unknown'
  role?: string
  work?: string
  label?: string
  sharedWith?: string[]
}
export type MemoryImportOrigin = {
  owner: string
  instanceId?: string
  kind?: string
  exportedAt?: string
}
export type ParsedMemoryImportItem = {
  sourceId: string
  originalScope: MemoryImportOriginalScope
  status: 'ready' | 'rejected'
  text?: string
  reason?: string
}
export type ParsedMemoryImport = {
  origin: MemoryImportOrigin
  items: ParsedMemoryImportItem[]
}

const exactKeys = (value: Record<string, unknown>, allowed: string[], label: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new CoreError('INVALID_INPUT', `${label} contains fields this export format does not accept.`)
  }
}

export function credentialLike(value: string) {
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:bearer\s+\S+|(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|password|secret|token|authorization)\s*[:=]\s*["']?\S+)|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/iu.test(value)
}

function text(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new CoreError('INVALID_INPUT', `${label} needs 1–${max} bytes of text.`)
  }
  if (credentialLike(value)) {
    throw new CoreError('MEMORY_SENSITIVE', 'Credentials belong in the protected credential store, not an import.')
  }
  return value.trim()
}

function originalScope(value: unknown): MemoryImportOriginalScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('INVALID_INPUT', 'Each imported item needs its original scope.')
  }
  const scope = value as Record<string, unknown>
  exactKeys(scope, ['kind', 'role', 'work', 'label', 'sharedWith'], 'Original scope')
  if (!['main', 'work', 'shared', 'unknown'].includes(scope.kind as string)) {
    throw new CoreError('INVALID_INPUT', 'Original scope kind must be main, work, shared or unknown.')
  }
  const sharedWith = scope.sharedWith === undefined ? undefined : scope.sharedWith
  if (sharedWith !== undefined && (!Array.isArray(sharedWith) || sharedWith.length > 20)) {
    throw new CoreError('INVALID_INPUT', 'Original shared recipients must be a list of at most 20 labels.')
  }
  const role = text(scope.role, 'Original role', 256)
  const work = text(scope.work, 'Original work', 256)
  const label = text(scope.label, 'Original scope label', 256)
  return {
    kind: scope.kind as MemoryImportOriginalScope['kind'],
    ...(role ? { role } : {}),
    ...(work ? { work } : {}),
    ...(label ? { label } : {}),
    ...(sharedWith ? { sharedWith: (sharedWith as unknown[]).map((item, index) =>
      text(item, `Original shared recipient ${index + 1}`, 256, true)!) } : {}),
  }
}

/** Parses only portable ownership and text. Identity, authorization and execution state stay outside this format. */
export function parseMemoryImport(data: string, validateText: (value: unknown, label: string) => string): ParsedMemoryImport {
  if (typeof data !== 'string' || !data.trim() || Buffer.byteLength(data) > 512 * 1024) {
    throw new CoreError('INVALID_INPUT', 'Memory export must be JSON text between 1 byte and 512 KiB.')
  }
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch {
    throw new CoreError('INVALID_INPUT', 'Memory export is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoreError('INVALID_INPUT', 'Memory export must be a JSON object.')
  }
  const root = parsed as Record<string, unknown>
  exactKeys(root, ['schema', 'version', 'origin', 'items'], 'Memory export')
  if (root.schema !== 'ds-bot-memory-export' || root.version !== 1) {
    throw new CoreError('INVALID_INPUT', 'Use a version 1 ds-bot-memory-export document.')
  }
  if (!root.origin || typeof root.origin !== 'object' || Array.isArray(root.origin)) {
    throw new CoreError('INVALID_INPUT', 'Memory export needs its original owner.')
  }
  const rawOrigin = root.origin as Record<string, unknown>
  exactKeys(rawOrigin, ['owner', 'instanceId', 'kind', 'exportedAt'], 'Original owner')
  const owner = text(rawOrigin.owner, 'Original owner', 256, true)!
  const originalInstance = text(rawOrigin.instanceId, 'Original instance', 256)
  const originalKind = text(rawOrigin.kind, 'Original owner kind', 64)
  const exportedAt = text(rawOrigin.exportedAt, 'Original export time', 64)
  const origin: MemoryImportOrigin = {
    owner,
    ...(originalInstance ? { instanceId: originalInstance } : {}),
    ...(originalKind ? { kind: originalKind } : {}),
    ...(exportedAt ? { exportedAt } : {}),
  }
  if (!Array.isArray(root.items) || root.items.length < 1 || root.items.length > 50) {
    throw new CoreError('INVALID_INPUT', 'Memory export needs between 1 and 50 items.')
  }
  const seen = new Set<string>()
  const items = root.items.map((value, index): ParsedMemoryImportItem => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CoreError('INVALID_INPUT', `Memory item ${index + 1} must be an object.`)
    }
    const item = value as Record<string, unknown>
    exactKeys(item, ['id', 'text', 'originalScope'], `Memory item ${index + 1}`)
    identifier(item.id, `Memory item ${index + 1} source ID`)
    if (seen.has(item.id)) throw new CoreError('INVALID_INPUT', `Memory item source ID ${item.id} appears more than once.`)
    seen.add(item.id)
    const scope = originalScope(item.originalScope)
    try {
      return { sourceId: item.id, text: validateText(item.text, `Memory item ${item.id}`), originalScope: scope, status: 'ready' }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'MEMORY_SENSITIVE') {
        return { sourceId: item.id, originalScope: scope, status: 'rejected', reason: 'MEMORY_SENSITIVE' }
      }
      throw error
    }
  })
  return { origin, items }
}

export function decodeMemoryExport(data: string | Uint8Array) {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
  if (!bytes.length || bytes.length > 512 * 1024) {
    throw new CoreError('INVALID_INPUT', 'Memory export must be between 1 byte and 512 KiB.')
  }
  if (!isUtf8(bytes)) throw new CoreError('INVALID_INPUT', 'Memory export must use UTF-8.')
  const decoded = bytes.toString('utf8')
  return { bytes, text: decoded.startsWith('\ufeff') ? decoded.slice(1) : decoded }
}

export function decodeMemoryExportBase64(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(512 * 1024 * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'Memory export data must be base64 text.')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new CoreError('INVALID_INPUT', 'Memory export base64 is not canonical.')
  return bytes
}
