import { createHash } from 'node:crypto'
import type { ProductCredentialRecords } from '../product-credential-vault.js'
import type { ImPersistence, ImStoredConnection } from './types.js'

interface ConnectionEnvelope {
  format: 'ds-superagent-im-connection-v1'
  instanceId: string
  id: string
  secretDigest: string
  connection: Omit<ImStoredConnection, 'fields' | 'runtime'>
}

interface SecretEnvelope {
  format: 'ds-superagent-im-secret-v1'
  instanceId: string
  id: string
  fields: Record<string, string>
}

interface RuntimeEnvelope {
  format: 'ds-superagent-im-runtime-v1'
  instanceId: string
  id: string
  runtime: Record<string, unknown>
}

interface IndexEnvelope {
  format: 'ds-superagent-im-index-v1'
  instanceId: string
  ids: string[]
}

interface ReceiptEnvelope {
  format: 'ds-superagent-im-receipt-v1'
  instanceId: string
  key: string
  state: 'pending' | 'sent' | 'unknown'
  messageId?: string
  sentAt: number
}

const owner = 'ds-superagent-profile/im'
const maximumConnections = 100

function instanceDigest(instanceId: string): string {
  return createHash('sha256').update(instanceId).digest('hex')
}

function recordDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function metadataKey(instanceId: string, id: string): string {
  return `${owner}/connection-${instanceDigest(instanceId)}-${recordDigest(id)}`
}

function secretKey(instanceId: string, id: string): string {
  return `${owner}/secret-${instanceDigest(instanceId)}-${recordDigest(id)}`
}

function runtimeKey(instanceId: string, id: string): string {
  return `${owner}/runtime-${instanceDigest(instanceId)}-${recordDigest(id)}`
}

function indexKey(instanceId: string): string {
  return `${owner}/index-${instanceDigest(instanceId)}`
}

function receiptKey(instanceId: string, key: string): string {
  return `${owner}/receipt-${instanceDigest(instanceId)}-${recordDigest(key)}`
}

function validConnectionEnvelope(value: unknown, instanceId: string, id: string): value is ConnectionEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  const connection = envelope.connection
  return envelope.format === 'ds-superagent-im-connection-v1' && envelope.instanceId === instanceId
    && envelope.id === id && connection !== null && typeof connection === 'object' && !Array.isArray(connection)
}

function validSecretEnvelope(value: unknown, instanceId: string, id: string): value is SecretEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return envelope.format === 'ds-superagent-im-secret-v1' && envelope.instanceId === instanceId && envelope.id === id
    && envelope.fields !== null && typeof envelope.fields === 'object' && !Array.isArray(envelope.fields)
    && Object.values(envelope.fields as Record<string, unknown>).every(field => typeof field === 'string')
}

function validIndexEnvelope(value: unknown, instanceId: string): value is IndexEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return envelope.format === 'ds-superagent-im-index-v1' && envelope.instanceId === instanceId
    && Array.isArray(envelope.ids) && envelope.ids.length <= maximumConnections
    && envelope.ids.every(id => typeof id === 'string' && id !== '')
}

function validRuntimeEnvelope(value: unknown, instanceId: string, id: string): value is RuntimeEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return envelope.format === 'ds-superagent-im-runtime-v1' && envelope.instanceId === instanceId && envelope.id === id
    && envelope.runtime !== null && typeof envelope.runtime === 'object' && !Array.isArray(envelope.runtime)
}

/** Connection metadata is a grant; all credential and transport fields are an api-key record. */
export class CredentialImPersistence implements ImPersistence {
  constructor(private readonly records: ProductCredentialRecords, private readonly instanceId: string) {
    if (!records || typeof records.readRecord !== 'function' || typeof records.modifyRecord !== 'function'
      || typeof records.deleteRecord !== 'function') {
      throw new Error('IM persistence needs the DSH credential record service.')
    }
  }

  async load(): Promise<ImStoredConnection[]> {
    const index = await this.readIndex()
    const connections: ImStoredConnection[] = []
    for (const id of index.ids) {
      const metadata = await this.records.readRecord(metadataKey(this.instanceId, id))
      if (!metadata || metadata.kind !== 'grant' || !validConnectionEnvelope(metadata.payload, this.instanceId, id)) {
        throw new Error('The stored IM connection metadata is unreadable.')
      }
      const secret = await this.records.readRecord(secretKey(this.instanceId, id))
      if (!secret || secret.kind !== 'api-key' || secret.env !== undefined || typeof secret.key !== 'string') {
        throw new Error('The stored IM connection credential is unavailable.')
      }
      let parsed: unknown
      try { parsed = JSON.parse(secret.key) } catch { throw new Error('The stored IM connection credential is unreadable.') }
      if (!validSecretEnvelope(parsed, this.instanceId, id)) {
        throw new Error('The stored IM connection credential is unreadable.')
      }
      if (recordDigest(secret.key) !== metadata.payload.secretDigest) {
        throw new Error('The IM connection metadata and credential snapshot are inconsistent.')
      }
      const runtimeRecord = await this.records.readRecord(runtimeKey(this.instanceId, id))
      let runtime: Record<string, unknown> = {}
      if (runtimeRecord) {
        if (runtimeRecord.kind !== 'api-key' || runtimeRecord.env !== undefined || typeof runtimeRecord.key !== 'string') {
          throw new Error('The stored IM transport state is unreadable.')
        }
        let runtimeValue: unknown
        try { runtimeValue = JSON.parse(runtimeRecord.key) } catch { throw new Error('The stored IM transport state is unreadable.') }
        if (!validRuntimeEnvelope(runtimeValue, this.instanceId, id)) throw new Error('The stored IM transport state is unreadable.')
        runtime = structuredClone(runtimeValue.runtime)
      }
      connections.push({ ...metadata.payload.connection, fields: { ...parsed.fields }, runtime } as ImStoredConnection)
    }
    return connections
  }

  async save(connection: ImStoredConnection): Promise<void> {
    if (!connection || connection.version !== 1 || connection.id === '') throw new Error('The IM connection snapshot is invalid.')
    const { fields, runtime, ...metadata } = connection
    const secret: SecretEnvelope = {
      format: 'ds-superagent-im-secret-v1',
      instanceId: this.instanceId,
      id: connection.id,
      fields: { ...fields },
    }
    const secretJson = JSON.stringify(secret)
    const runtimeValue: RuntimeEnvelope = {
      format: 'ds-superagent-im-runtime-v1',
      instanceId: this.instanceId,
      id: connection.id,
      runtime: structuredClone(runtime),
    }
    const runtimeJson = JSON.stringify(runtimeValue)
    if (Buffer.byteLength(secretJson) > 16_000 || Buffer.byteLength(runtimeJson) > 16_000) {
      throw new Error('The IM credential record exceeds the DSH credential size limit.')
    }
    const envelope: ConnectionEnvelope = {
      format: 'ds-superagent-im-connection-v1',
      instanceId: this.instanceId,
      id: connection.id,
      secretDigest: recordDigest(secretJson),
      connection: metadata,
    }
    await this.modifySecret(secretKey(this.instanceId, connection.id), secretJson)
    await this.modifySecret(runtimeKey(this.instanceId, connection.id), runtimeJson)
    await this.modifyGrant(metadataKey(this.instanceId, connection.id), envelope)
    await this.addToIndex(connection.id)
  }

  async remove(id: string): Promise<void> {
    await this.records.deleteRecord(metadataKey(this.instanceId, id))
    await this.records.deleteRecord(secretKey(this.instanceId, id))
    await this.records.deleteRecord(runtimeKey(this.instanceId, id))
    await this.removeFromIndex(id)
    if (await this.records.readRecord(metadataKey(this.instanceId, id)) !== undefined
      || await this.records.readRecord(secretKey(this.instanceId, id)) !== undefined
      || await this.records.readRecord(runtimeKey(this.instanceId, id)) !== undefined) {
      throw new Error('The IM connection records could not be removed.')
    }
  }

  private async readIndex(): Promise<IndexEnvelope> {
    const record = await this.records.readRecord(indexKey(this.instanceId))
    if (!record) return { format: 'ds-superagent-im-index-v1', instanceId: this.instanceId, ids: [] }
    if (record.kind !== 'grant' || !validIndexEnvelope(record.payload, this.instanceId)) {
      throw new Error('The stored IM connection index is unreadable.')
    }
    return record.payload
  }

  private async modifyGrant(key: string, value: ConnectionEnvelope | IndexEnvelope) {
    const result = await this.records.modifyRecord(key, async current => {
      if (current !== undefined) {
        if (current.kind !== 'grant' || current.payload === null || typeof current.payload !== 'object') {
          throw new Error('The existing IM metadata record is not owned by IM.')
        }
        const valid = 'ids' in value
          ? validIndexEnvelope(current.payload, this.instanceId)
          : validConnectionEnvelope(current.payload, this.instanceId, value.id)
        if (!valid) throw new Error('The existing IM metadata record is not owned by this Instance.')
      }
      return { kind: 'grant', payload: structuredClone(value) }
    })
    if (!result) throw new Error('The IM credential record could not be saved.')
  }

  private async modifySecret(key: string, value: string) {
    const next = JSON.parse(value) as SecretEnvelope | RuntimeEnvelope
    const result = await this.records.modifyRecord(key, async current => {
      if (current !== undefined) {
        if (current.kind !== 'api-key' || current.env !== undefined || typeof current.key !== 'string') {
          throw new Error('The existing IM secret record is not owned by IM.')
        }
        let existing: unknown
        try { existing = JSON.parse(current.key) } catch { throw new Error('The existing IM secret record is unreadable.') }
        const valid = 'fields' in next
          ? validSecretEnvelope(existing, this.instanceId, next.id)
          : validRuntimeEnvelope(existing, this.instanceId, next.id)
        if (!valid) throw new Error('The existing IM secret record is not owned by this Instance.')
      }
      return { kind: 'api-key', key: value }
    })
    if (!result) throw new Error('The IM credential record could not be saved.')
  }

  private async addToIndex(id: string) {
    const result = await this.records.modifyRecord(indexKey(this.instanceId), async record => {
      if (record === undefined) return { kind: 'grant', payload: {
        format: 'ds-superagent-im-index-v1', instanceId: this.instanceId, ids: [id],
      } satisfies IndexEnvelope }
      if (record.kind !== 'grant' || !validIndexEnvelope(record.payload, this.instanceId)) {
        throw new Error('The stored IM connection index is not owned by this Instance.')
      }
      if (record.payload.ids.includes(id)) return record
      if (record.payload.ids.length >= maximumConnections) throw new Error('The IM connection limit is reached.')
      return { kind: 'grant', payload: { ...record.payload, ids: [...record.payload.ids, id] } }
    })
    if (!result) throw new Error('The IM connection index could not be saved.')
  }

  private async removeFromIndex(id: string) {
    await this.records.modifyRecord(indexKey(this.instanceId), async record => {
      if (record === undefined) return undefined
      if (record.kind !== 'grant' || !validIndexEnvelope(record.payload, this.instanceId)) {
        throw new Error('The stored IM connection index is not owned by this Instance.')
      }
      return { kind: 'grant', payload: { ...record.payload, ids: record.payload.ids.filter(entry => entry !== id) } }
    })
  }
}

export interface ImReceipt {
  state: 'pending' | 'sent' | 'unknown'
  messageId?: string
  sentAt: number
}

/** A pending receipt prevents an ambiguous platform send from being replayed after restart. */
export class CredentialImReceipts {
  constructor(private readonly records: ProductCredentialRecords, private readonly instanceId: string) {}

  async get(key: string): Promise<ImReceipt | undefined> {
    const record = await this.records.readRecord(receiptKey(this.instanceId, key))
    if (!record) return undefined
    if (record.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object') {
      throw new Error('The IM reply receipt is unreadable.')
    }
    const envelope = record.payload as ReceiptEnvelope
    if (envelope.format !== 'ds-superagent-im-receipt-v1' || envelope.instanceId !== this.instanceId
      || envelope.key !== key || !Number.isFinite(envelope.sentAt)) {
      throw new Error('The IM reply receipt is unreadable.')
    }
    if (!['pending', 'sent', 'unknown'].includes(envelope.state)) throw new Error('The IM reply receipt state is unreadable.')
    return { state: envelope.state, sentAt: envelope.sentAt,
      ...(envelope.messageId === undefined ? {} : { messageId: envelope.messageId }) }
  }

  async begin(key: string, sentAt: number): Promise<{ created: boolean; receipt: ImReceipt }> {
    let prior: ReceiptEnvelope | undefined
    const result = await this.records.modifyRecord(receiptKey(this.instanceId, key), async current => {
      if (current !== undefined) {
        if (current.kind !== 'grant' || current.payload === null || typeof current.payload !== 'object') {
          throw new Error('The existing IM reply receipt is unreadable.')
        }
        const existing = current.payload as ReceiptEnvelope
        if (existing.format !== 'ds-superagent-im-receipt-v1' || existing.instanceId !== this.instanceId
          || existing.key !== key || !['pending', 'sent', 'unknown'].includes(existing.state)) {
          throw new Error('The existing IM reply receipt is unreadable.')
        }
        prior = existing
        return current
      }
      const envelope: ReceiptEnvelope = {
        format: 'ds-superagent-im-receipt-v1', instanceId: this.instanceId, key, state: 'pending', sentAt,
      }
      return { kind: 'grant', payload: envelope }
    })
    if (!result) throw new Error('The IM reply receipt could not be reserved.')
    if (prior) return { created: false, receipt: {
      state: prior.state,
      sentAt: prior.sentAt,
      ...(prior.messageId === undefined ? {} : { messageId: prior.messageId }),
    } }
    return { created: true, receipt: { state: 'pending', sentAt } }
  }

  async finish(key: string, receipt: ImReceipt): Promise<void> {
    const envelope: ReceiptEnvelope = {
      format: 'ds-superagent-im-receipt-v1',
      instanceId: this.instanceId,
      key,
      state: receipt.state,
      ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
      sentAt: receipt.sentAt,
    }
    const result = await this.records.modifyRecord(receiptKey(this.instanceId, key), async current => {
      if (current?.kind !== 'grant' || current.payload === null || typeof current.payload !== 'object') {
        throw new Error('The IM reply receipt reservation is missing.')
      }
      const existing = current.payload as ReceiptEnvelope
      if (existing.format !== 'ds-superagent-im-receipt-v1' || existing.instanceId !== this.instanceId || existing.key !== key) {
        throw new Error('The IM reply receipt reservation is invalid.')
      }
      return { kind: 'grant', payload: envelope }
    })
    if (!result) throw new Error('The IM reply receipt could not be saved.')
  }

  async abandon(key: string): Promise<void> {
    await this.records.modifyRecord(receiptKey(this.instanceId, key), async current => {
      if (current === undefined) return undefined
      if (current.kind !== 'grant' || current.payload === null || typeof current.payload !== 'object') {
        throw new Error('The IM reply receipt reservation is unreadable.')
      }
      const envelope = current.payload as ReceiptEnvelope
      if (envelope.format !== 'ds-superagent-im-receipt-v1' || envelope.instanceId !== this.instanceId || envelope.key !== key) {
        throw new Error('The IM reply receipt reservation is invalid.')
      }
      return envelope.state === 'pending' ? undefined : current
    })
  }
}

export class MemoryImPersistence implements ImPersistence {
  private readonly connections = new Map<string, ImStoredConnection>()

  async load(): Promise<ImStoredConnection[]> {
    return structuredClone([...this.connections.values()])
  }

  async save(connection: ImStoredConnection): Promise<void> {
    this.connections.set(connection.id, structuredClone(connection))
  }

  async remove(id: string): Promise<void> {
    this.connections.delete(id)
  }
}
