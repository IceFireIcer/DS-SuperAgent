import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'

const MAX_BYTES = 1024 * 1024
const MAX_ITEMS = 50
const MAX_PENDING = 16
const TTL_MS = 10 * 60_000
const SCOPES = new Set(['main', 'work', 'shared', 'unknown'])
const TYPES = new Set(['api-key', 'token', 'password'])

function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} has unsupported fields`)
  return value
}

function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|secret|token)\s*[:=]\s*\S+/iu.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value.trim()
}

function secret(value, label) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16_384
    || /[\r\n\u0000]/u.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function sourceRef(owner, itemId) {
  return createHash('sha256').update(JSON.stringify([
    'credential-import-source-v1', owner.instanceId ?? '', owner.label, itemId,
  ])).digest('hex')
}

function originalScope(value, index) {
  const raw = object(value ?? { kind: 'unknown' }, `credential ${index} original scope`,
    ['kind', 'role', 'work', 'environment', 'sharedWith'])
  if (!SCOPES.has(raw.kind)) throw new Error(`credential ${index} original scope is invalid`)
  const sharedWith = raw.sharedWith
  if (sharedWith !== undefined && (!Array.isArray(sharedWith) || sharedWith.length > 20)) {
    throw new Error(`credential ${index} original shared scope is invalid`)
  }
  return {
    kind: raw.kind,
    ...(raw.role === undefined ? {} : { role: text(raw.role, `credential ${index} original role`) }),
    ...(raw.work === undefined ? {} : { work: text(raw.work, `credential ${index} original work`) }),
    ...(raw.environment === undefined ? {} : { environment: text(raw.environment, `credential ${index} original Environment`) }),
    ...(sharedWith === undefined ? {} : { sharedWith: sharedWith.map((entry, position) => text(entry, `credential ${index} reader ${position + 1}`)) }),
  }
}

export function parseCredentialExport(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('credential export must be between 1 byte and 1 MiB')
  if (!isUtf8(bytes)) throw new Error('credential export must be valid UTF-8')
  let document
  try { document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) }
  catch { throw new Error('credential export is not valid JSON') }
  const root = object(document, 'credential export', ['schema', 'version', 'origin', 'credentials'])
  if (root.schema !== 'ds-superagent-credential-export' || root.version !== 1) throw new Error('credential export schema is unsupported')
  const source = object(root.origin, 'credential export owner', ['label', 'instanceId'])
  const owner = { label: text(source.label, 'credential export owner'),
    ...(source.instanceId === undefined ? {} : { instanceId: text(source.instanceId, 'credential export Instance') }) }
  if (!Array.isArray(root.credentials) || root.credentials.length < 1 || root.credentials.length > MAX_ITEMS) {
    throw new Error(`credential export must contain between 1 and ${MAX_ITEMS} items`)
  }
  const ids = new Set()
  const entries = root.credentials.map((value, index) => {
    const row = object(value, `credential ${index + 1}`, ['id', 'label', 'type', 'value', 'originalScope'])
    const id = text(row.id, `credential ${index + 1} id`, 128)
    if (ids.has(id)) throw new Error('credential IDs must be unique')
    ids.add(id)
    if (!TYPES.has(row.type)) throw new Error(`credential ${index + 1} type is unsupported`)
    const item = { id, label: text(row.label, `credential ${index + 1} label`), type: row.type,
      value: secret(row.value, `credential ${index + 1} value`),
      originalScope: originalScope(row.originalScope, index + 1) }
    return { ...item, sourceRef: sourceRef(owner, item.id) }
  })
  return { owner, entries, preview: { owner, entries: entries.map(({ value: _value, ...entry }) => entry) } }
}

/** Secret-bearing values stay in Electron main memory and are read only for the selected item. */
export class CredentialImports {
  #pending = new Map()

  store(bytes, sourceLabel = 'Credential JSON export') {
    this.sweep()
    const parsed = parseCredentialExport(bytes)
    const cleanSourceLabel = text(sourceLabel, 'credential export filename')
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value)
    const id = randomUUID()
    this.#pending.set(id, { entries: new Map(parsed.entries.map(entry => [entry.sourceRef, entry])),
      preview: { ...parsed.preview, sourceLabel: cleanSourceLabel }, expiresAt: Date.now() + TTL_MS })
    return { id, preview: structuredClone({ ...parsed.preview, sourceLabel: cleanSourceLabel }) }
  }

  read(id, sourceRef, credentialId) {
    const pending = this.peek(id)
    const entry = pending?.entries.get(sourceRef)
    if (!entry || credentialId !== undefined && entry.id !== credentialId) {
      const error = new Error('credential import is not available')
      error.code = 'CREDENTIAL_IMPORT_NOT_FOUND'
      throw error
    }
    return { id: entry.id, sourceRef: entry.sourceRef, value: entry.value }
  }

  finish(id, sourceRef) {
    const pending = this.peek(id)
    pending?.entries.delete(sourceRef)
    if (pending && pending.entries.size === 0) this.#pending.delete(id)
  }

  cancel(id, sourceRef) {
    if (!sourceRef) return this.drop(id)
    this.finish(id, sourceRef)
  }

  drop(id) { this.#pending.delete(id) }

  peek(id) {
    const pending = this.#pending.get(id)
    if (!pending) return null
    if (pending.expiresAt < Date.now()) { this.#pending.delete(id); return null }
    return pending
  }

  sweep() {
    const now = Date.now()
    for (const [id, pending] of this.#pending) if (pending.expiresAt < now) this.#pending.delete(id)
  }
}

export { sourceRef as credentialImportSourceRef }
