import { t } from './i18n.js'
import { uploadWithRetry } from './product-attachments.js'

const pageBytes = 8192
const maxAssetBytes = 8 * 1024 * 1024
const imageExtensions = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']])

function fail(code, message) { throw Object.assign(new Error(t(message)), { code }) }

const changed = () => fail('bot/stale', 'This file is no longer available.')

async function readPage(request, endpoint, target, offset, version, maxBytes = pageBytes) {
  const page = await request(endpoint, { ...target, offset, maxBytes })
  if (page?.offset !== offset || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < offset
    || page.totalBytes > maxAssetBytes || !page.reference || typeof page.sha256 !== 'string'
    || (version !== undefined && page.sha256 !== version)) changed()
  let bytes
  if (page.encoding === 'utf8') bytes = new TextEncoder().encode(page.text)
  else if (page.encoding === 'base64') bytes = Uint8Array.from(atob(page.text), character => character.charCodeAt(0))
  else changed()
  if (page.nextOffset !== offset + bytes.length || page.nextOffset > page.totalBytes || bytes.length > maxBytes
    || (bytes.length === 0 && offset !== page.totalBytes)) changed()
  return { bytes, reference: page.reference, nextOffset: page.nextOffset, totalBytes: page.totalBytes, version: page.sha256 }
}

export async function readAsset(request, endpoint, target, limit = maxAssetBytes) {
  const chunks = []
  let offset = 0
  let version
  let totalBytes
  for (let pages = 0; offset < limit && pages < 2048; pages++) {
    const page = await readPage(request, endpoint, target, offset, version, Math.min(pageBytes, limit - offset))
    if (totalBytes !== undefined && totalBytes !== page.totalBytes) changed()
    chunks.push(page.bytes)
    offset = page.nextOffset
    version = page.version
    totalBytes = page.totalBytes
    if (offset === totalBytes || offset === limit) {
      return { chunks, reference: page.reference, totalBytes, whole: offset === totalBytes }
    }
  }
  return changed()
}

export async function readAssetChunk(request, endpoint, target, offset, version) {
  if (!Number.isSafeInteger(offset) || offset < 0 || (version !== undefined && typeof version !== 'string')) {
    fail('bot/invalid', 'Use a valid file offset and version.')
  }
  const page = await readPage(request, endpoint, target, offset, version)
  return { name: page.reference.name ?? 'file', mime: page.reference.mediaType ?? 'application/octet-stream',
    bytes: btoa(String.fromCharCode(...page.bytes)), size: page.totalBytes, version: page.version,
    nextOffset: page.nextOffset, done: page.nextOffset === page.totalBytes }
}

export async function stageImage(input, binding, request, storage) {
  const ext = imageExtensions.get(input.mediaType)
  if (!ext || typeof input.data !== 'string' || !input.data.length || input.data.length > Math.ceil(maxAssetBytes / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.data) || input.data.length % 4 !== 0) {
    fail('bot/invalid', 'Choose a supported photo smaller than 8 MB.')
  }
  const options = await request('directory-options')
  const environmentId = options.default?.environmentId ?? options.directories[0]?.id
  if (!environmentId) fail('bot/refused', 'Choose a work directory before attaching a photo.')
  const payload = { kind: 'image', name: `photo.${ext}`, mediaType: input.mediaType, data: input.data }
  let store
  try { store = storage() } catch { /* The upload helper also retains retry identity in memory. */ }
  const result = await uploadWithRetry(request, store, binding.instanceId, environmentId, payload)
  return { id: result.id }
}
