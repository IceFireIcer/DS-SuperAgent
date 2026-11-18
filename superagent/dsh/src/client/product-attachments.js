const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const pendingUploads = new Map()

export async function uploadPayload(file) {
  if (!file || file.size < 1 || file.size > MAX_UPLOAD_BYTES) throw new Error('Choose a nonempty file smaller than 8 MB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return { kind: IMAGE_TYPES.has(file.type) ? 'image' : 'file', name: file.name,
    ...(file.type ? { mediaType: file.type } : {}), data: btoa(binary) }
}

export async function uploadFingerprint(payload, environmentId) {
  const bytes = new TextEncoder().encode(JSON.stringify([environmentId, payload.kind, payload.name, payload.mediaType ?? '', payload.data]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function uploadWithRetry(call, store, instanceId, environmentId, payload) {
  const fingerprint = await uploadFingerprint(payload, environmentId)
  const key = `superagent:pending-upload:${instanceId}:${fingerprint}`
  let commandId = pendingUploads.get(key)
  if (!commandId) {
    try { commandId = store.getItem(key) } catch { /* The current window still retains its retry identity. */ }
    commandId ||= crypto.randomUUID()
    pendingUploads.set(key, commandId)
    try { store.setItem(key, commandId) } catch { /* The current window still retains its retry identity. */ }
  }
  const result = await call('attachment-upload', { instanceId, commandId, environmentId, ...payload })
  pendingUploads.delete(key)
  try { store.removeItem(key) } catch { /* The Host receipt is authoritative. */ }
  return result
}

async function readPages(call, endpoint, request) {
  const chunks = []
  let offset = 0
  for (let pageCount = 0; pageCount < 2048; pageCount++) {
    const page = await call(endpoint, { ...request, offset, maxBytes: 8192 })
    if (page.encoding !== 'utf8' && page.encoding !== 'base64') throw new Error('The attachment page encoding is unavailable.')
    const bytes = page.encoding === 'base64'
      ? Uint8Array.from(atob(page.text), character => character.charCodeAt(0))
      : new TextEncoder().encode(page.text)
    if (page.offset !== offset || page.nextOffset !== offset + bytes.length || page.totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error('The attachment page does not match the expected bytes.')
    }
    chunks.push(bytes)
    if (page.nextOffset === page.totalBytes) return new Blob(chunks)
    if (page.nextOffset <= offset) throw new Error('The attachment page did not advance.')
    offset = page.nextOffset
  }
  throw new Error('The attachment exceeded the bounded page limit.')
}

export const readProductAttachment = (call, instanceId, id) => readPages(call, 'attachment-read', { instanceId, id })
export const readProductArtifact = (call, instanceId, workItemId, path) =>
  readPages(call, 'artifact-read', { instanceId, workItemId, path })
