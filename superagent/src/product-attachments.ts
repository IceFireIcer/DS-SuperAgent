import { createHash } from 'node:crypto'
import type { AdmittedPromptContentPart, AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { canonicalJson, commandTransaction } from './commands.js'
import { maxProductAttachmentBytes, type EnvironmentAssetPage, type EnvironmentAssetReference } from './environment-assets.js'
import type { ExecutionEnvironment } from './environment.js'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'

const maxUploadBytes = maxProductAttachmentBytes
const imageTypes = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface ProductAttachmentUpload {
  instanceId: string
  actorId: string
  clientId?: string
  commandId: string
  environmentId: string
  kind: 'file' | 'image'
  name: string
  mediaType?: string
  data: string
}

export interface ProductAttachmentView {
  id: string
  kind: 'file' | 'image'
  environmentId: string
  name: string
  bytes: number
  mediaType?: string
  state: 'active' | 'revoked'
}

interface ProductAttachmentRecord extends ProductAttachmentView {
  version: 1
  instanceId: string
  actorId: string
  clientId?: string
  native: FileAttachmentRef | ImageAttachmentRef
  asset: EnvironmentAssetReference
  createdAt: number
  revokedAt?: number
}

interface UploadReceipt { fingerprint: string; id: string }

export interface SourceAttachment {
  id: string
  kind: 'file' | 'image'
  name: string
  asset: EnvironmentAssetReference
  content: Extract<AdmittedPromptContentPart, { type: 'file' | 'image' }>
}

export function sourceAttachmentView(attachment: SourceAttachment, state: ProductAttachmentView['state'] = 'active'): ProductAttachmentView {
  return { id: attachment.id, kind: attachment.kind, name: attachment.name, environmentId: attachment.asset.environmentId,
    bytes: attachment.asset.bytes, ...(attachment.asset.mediaType ? { mediaType: attachment.asset.mediaType } : {}), state }
}

const recordKey = (id: string) => `ref:${id}`
const uploadKey = (instanceId: string, actorId: string, clientId: string | undefined, commandId: string) =>
  `upload:${createHash('sha256').update(canonicalJson([instanceId, actorId, clientId ?? null, commandId])).digest('hex')}`

function view(record: ProductAttachmentRecord): ProductAttachmentView {
  const { id, kind, environmentId, name, bytes, mediaType, state } = record
  return { id, kind, environmentId, name, bytes, ...(mediaType ? { mediaType } : {}), state }
}

/** Resolve the original upload identity inside the same business transaction as its new grant. */
export async function resolveProductAttachments(tx: AsyncTx, request: {
  instanceId: string; actorId: string; clientId?: string; environmentId: string; ids: string[];
  expected?: SourceAttachment[]
}) {
  identifier(request.actorId, 'actorId')
  identifier(request.environmentId, 'environmentId')
  if (request.clientId !== undefined) identifier(request.clientId, 'clientId')
  if (!Array.isArray(request.ids) || request.ids.length > 10 || new Set(request.ids).size !== request.ids.length) {
    throw new CoreError('INVALID_INPUT', 'Choose at most ten distinct attachments.')
  }
  const records = await Promise.all(request.ids.map(async id => {
    identifier(id, 'attachmentId')
    const record = await tx.get<ProductAttachmentRecord>('product-attachment', recordKey(id))
    if (!record || record.instanceId !== request.instanceId || record.actorId !== request.actorId
      || record.clientId !== request.clientId) throw new CoreError('NOT_FOUND', 'This attachment is unavailable.')
    if (record.state !== 'active') throw new CoreError('ATTACHMENT_REVOKED', 'The attachment is no longer authorized.')
    if (record.environmentId !== request.environmentId) throw new CoreError('ENVIRONMENT_DENIED', 'The attachment belongs to another work directory.')
    return record
  }))
  const attachments: SourceAttachment[] = records.map(record => ({ id: record.id, kind: record.kind, name: record.name,
    asset: record.asset, content: record.kind === 'file'
      ? { type: 'file', attachment: record.native as FileAttachmentRef }
      : { type: 'image', attachment: record.native as ImageAttachmentRef } }))
  if (request.expected && canonicalJson(attachments) !== canonicalJson(request.expected)) {
    throw new CoreError('REFERENCE_STALE', 'The source attachment no longer matches its admitted reference.')
  }
  return { attachments, content: attachments.map(attachment => attachment.content), views: records.map(view),
    assets: records.map(record => record.asset) }
}

/** Product-scoped admission sits in front of DSH's durable attachment service. */
export class ProductAttachments {
  constructor(private readonly storage: Storage, private readonly instanceId: string,
    private readonly attachments: Pick<AttachmentStore, 'admitEncodedFile' | 'admitPromptContent'>,
    private readonly environment: (id: string) => ExecutionEnvironment | undefined,
    private readonly environmentActorId?: string) {}

  private identity(request: { instanceId: string; actorId: string; clientId?: string }) {
    if (request.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'This attachment belongs to another Instance.')
    identifier(request.actorId, 'actorId')
    if (request.clientId !== undefined) identifier(request.clientId, 'clientId')
  }

  private async record(tx: AsyncTx, id: string, request: { actorId: string; clientId?: string }) {
    identifier(id, 'attachmentId')
    const record = await tx.get<ProductAttachmentRecord>('product-attachment', recordKey(id))
    if (!record || record.instanceId !== this.instanceId || record.actorId !== request.actorId
      || record.clientId !== request.clientId) throw new CoreError('NOT_FOUND', 'This attachment is unavailable.')
    return record
  }

  async upload(request: ProductAttachmentUpload): Promise<ProductAttachmentView> {
    this.identity(request)
    identifier(request.commandId, 'commandId')
    identifier(request.environmentId, 'environmentId')
    if (request.kind !== 'file' && request.kind !== 'image' || typeof request.name !== 'string'
      || !request.name || Buffer.byteLength(request.name) > 256 || Array.from(request.name).some(character => {
        const code = character.codePointAt(0)!
        return character === '/' || character === '\\' || code < 32 || code === 127
      })) {
      throw new CoreError('INVALID_INPUT', 'Choose a bounded file name without path components.')
    }
    if (request.kind === 'image' && !imageTypes.has(request.mediaType as ImageMediaType)
      || request.mediaType !== undefined && (typeof request.mediaType !== 'string' || request.mediaType.length > 128)) {
      throw new CoreError('INVALID_INPUT', 'Choose a supported image type or a bounded file media type.')
    }
    if (typeof request.data !== 'string' || request.data.length > Math.ceil(maxUploadBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(request.data)) {
      throw new CoreError('INVALID_INPUT', 'Upload canonical base64 within the product size limit.')
    }
    const bytes = Buffer.from(request.data, 'base64')
    if (!bytes.length || bytes.length > maxUploadBytes || bytes.toString('base64') !== request.data) {
      throw new CoreError('INVALID_INPUT', 'Upload canonical nonempty bytes within the product size limit.')
    }
    const owner = this.environment(request.environmentId)
    if (!owner) throw new CoreError('ENVIRONMENT_NOT_FOUND', 'Choose an available work directory before uploading.')
    owner.authorize({ instanceId: this.instanceId, actorId: this.environmentActorId ?? request.actorId })
    const key = uploadKey(this.instanceId, request.actorId, request.clientId, request.commandId)
    const fingerprint = createHash('sha256').update(canonicalJson([request.kind, request.name, request.mediaType ?? null,
      request.environmentId, createHash('sha256').update(bytes).digest('hex')])).digest('hex')
    const prior = await this.storage.transaction(this.instanceId, async tx => {
      const receipt = await tx.get<UploadReceipt>('product-attachment', key)
      if (!receipt) return undefined
      if (receipt.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This upload identity was already used for different content.')
      return view(await this.record(tx, receipt.id, request))
    })
    if (prior) return prior
    let native: FileAttachmentRef | ImageAttachmentRef
    if (request.kind === 'file') native = await this.attachments.admitEncodedFile({ data: request.data, name: request.name })
    else {
      const admitted = (await this.attachments.admitPromptContent([{ type: 'image', mediaType: request.mediaType as ImageMediaType,
        data: request.data, name: request.name }]))[0]
      if (admitted?.type !== 'image') throw new CoreError('ATTACHMENT_UNAVAILABLE', 'The attachment service did not admit the image.')
      native = admitted.attachment
    }
    const bound = await owner.prepare({ instanceId: this.instanceId, actorId: this.environmentActorId ?? request.actorId })
    const save = bound.saveProductAttachment?.bind(bound) ?? bound.saveAttachment?.bind(bound)
    if (!save) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment has no attachment store.')
    const asset = await save({ name: request.name, data: bytes, ...(request.mediaType ? { mediaType: request.mediaType } : {}) })
    const id = key.slice('upload:'.length)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const existing = await tx.get<UploadReceipt>('product-attachment', key)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'This upload identity was already used for different content.')
        return view(await this.record(tx, existing.id, request))
      }
      const record: ProductAttachmentRecord = { version: 1, id, instanceId: this.instanceId,
        actorId: request.actorId, ...(request.clientId ? { clientId: request.clientId } : {}),
        environmentId: request.environmentId, kind: request.kind, name: request.name, bytes: bytes.length,
        ...(request.mediaType ? { mediaType: request.mediaType } : {}), native, asset, state: 'active', createdAt: Date.now() }
      await tx.insert('product-attachment', recordKey(id), record)
      await tx.insert('product-attachment', key, { fingerprint, id } satisfies UploadReceipt)
      return view(record)
    })
  }

  async resolve(tx: AsyncTx, request: { instanceId: string; actorId: string; clientId?: string; environmentId: string; ids: string[] }) {
    this.identity(request)
    return resolveProductAttachments(tx, request)
  }

  async read(request: { instanceId: string; actorId: string; clientId?: string; id: string; offset?: number; maxBytes?: number }): Promise<EnvironmentAssetPage> {
    this.identity(request)
    const record = await this.storage.transaction(this.instanceId, tx => this.record(tx, request.id, request))
    if (record.state !== 'active') throw new CoreError('ATTACHMENT_REVOKED', 'The attachment is no longer authorized.')
    const owner = this.environment(record.environmentId)
    if (!owner) throw new CoreError('ENVIRONMENT_NOT_FOUND', 'The original work directory is unavailable.')
    const bound = await owner.prepare({ instanceId: this.instanceId, actorId: this.environmentActorId ?? request.actorId })
    if (!bound.readProductAsset) throw new CoreError('ENVIRONMENT_UNSUPPORTED', 'This Environment cannot download original attachments.')
    const page = await bound.readProductAsset(record.asset, { ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }) })
    const current = await this.storage.transaction(this.instanceId, tx => this.record(tx, request.id, request))
    if (current.state !== 'active') throw new CoreError('ATTACHMENT_REVOKED', 'The attachment was revoked during this read.')
    if (canonicalJson(current.asset) !== canonicalJson(record.asset)) {
      throw new CoreError('REFERENCE_STALE', 'The original attachment reference changed during this read.')
    }
    return page
  }

  async revoke(request: { instanceId: string; actorId: string; clientId?: string; id: string }): Promise<ProductAttachmentView> {
    this.identity(request)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const record = await this.record(tx, request.id, request)
      if (record.state === 'revoked') return view(record)
      const updated: ProductAttachmentRecord = { ...record, state: 'revoked', revokedAt: Date.now() }
      await tx.replace('product-attachment', recordKey(record.id), updated)
      return view(updated)
    })
  }
}
