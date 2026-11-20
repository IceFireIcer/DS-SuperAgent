import { createHash } from 'node:crypto'
import { canonicalJson } from '../commands.js'
import { CoreError, identifier } from '../model.js'
import type { ProductCredentialRecords } from '../product-credential-vault.js'

export interface ConnectorStateStore {
  read<T>(collection: string, id: string): Promise<T | undefined>
  write<T>(collection: string, id: string, value: T, index?: string): Promise<void>
  delete(collection: string, id: string, index?: string): Promise<void>
  unindex(collection: string, id: string, index: string): Promise<void>
  entries<T>(collection: string, index: string): Promise<Array<{ id: string; value: T }>>
}

interface StateEnvelope {
  format: 'ds-superagent-connector-state-v1'
  collection: string
  id: string
  value: unknown
}

interface StateIndex {
  ids: string[]
}

interface CommandReceipt {
  fingerprint: string
  result: unknown
}

const format = 'ds-superagent-connector-state-v1'
const owner = 'ds-superagent-connectors'
const MAX_INDEX = 1000

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(withoutUndefined(value))).digest('hex')
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(item => item !== undefined).map(withoutUndefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)]))
  }
  return value
}

function stateRecordKey(instanceId: string, collection: string, id: string): string {
  const instance = createHash('sha256').update(instanceId).digest('hex').slice(0, 16)
  return `${owner}/state-${instance}-${digest([collection, id])}`
}

function validEnvelope(value: unknown, collection: string, id: string): value is StateEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return envelope.format === format && envelope.collection === collection && envelope.id === id
    && Object.hasOwn(envelope, 'value')
}

function validIndex(value: unknown): value is StateIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const index = value as Record<string, unknown>
  return Array.isArray(index.ids) && index.ids.length <= MAX_INDEX
    && index.ids.every(id => typeof id === 'string' && id.length > 0)
}

class CredentialRecordStateStore implements ConnectorStateStore {
  constructor(private readonly records: ProductCredentialRecords, private readonly instanceId: string) {
    identifier(instanceId, 'instanceId')
  }

  private key(collection: string, id: string) {
    return stateRecordKey(this.instanceId, collection, id)
  }

  async read<T>(collection: string, id: string): Promise<T | undefined> {
    identifier(collection, 'collection'); identifier(id, 'id')
    const record = await this.records.readRecord(this.key(collection, id))
    if (!record) return undefined
    if (record.kind !== 'grant' || !validEnvelope(record.payload, collection, id)) {
      throw new CoreError('INCOMPLETE_STATE', 'The stored connector state is not readable.')
    }
    return record.payload.value as T
  }

  async write<T>(collection: string, id: string, value: T, index?: string): Promise<void> {
    identifier(collection, 'collection'); identifier(id, 'id')
    if (index !== undefined) identifier(index, 'index')
    if (index !== undefined) await this.addToIndex(collection, index, id)
    const key = this.key(collection, id)
    const result = await this.records.modifyRecord(key, async current => {
      if (current !== undefined && (current.kind !== 'grant' || !validEnvelope(current.payload, collection, id))) {
        throw new CoreError('INCOMPLETE_STATE', 'The stored connector state is not writable.')
      }
      return { kind: 'grant', payload: { format, collection, id, value } satisfies StateEnvelope }
    })
    if (!result) throw new CoreError('CONNECTOR_STATE_FAILED', 'The connector state could not be saved.')
  }

  async delete(collection: string, id: string, index?: string): Promise<void> {
    identifier(collection, 'collection'); identifier(id, 'id')
    await this.records.deleteRecord(this.key(collection, id))
    if (index !== undefined) await this.removeFromIndex(collection, index, id)
  }

  async unindex(collection: string, id: string, index: string): Promise<void> {
    identifier(collection, 'collection'); identifier(id, 'id'); identifier(index, 'index')
    await this.removeFromIndex(collection, index, id)
  }

  async entries<T>(collection: string, index: string): Promise<Array<{ id: string; value: T }>> {
    identifier(collection, 'collection'); identifier(index, 'index')
    const stored = await this.read<StateIndex>('index', `${collection}:${index}`)
    if (!stored) return []
    if (!validIndex(stored)) throw new CoreError('INCOMPLETE_STATE', 'The stored connector index is not readable.')
    const items: Array<{ id: string; value: T }> = []
    for (const id of stored.ids) {
      const value = await this.read<T>(collection, id)
      if (value !== undefined) items.push({ id, value })
    }
    return items
  }

  private async addToIndex(collection: string, index: string, id: string) {
    const indexId = `${collection}:${index}`
    const result = await this.records.modifyRecord(this.key('index', indexId), async current => {
      if (current !== undefined && (current.kind !== 'grant' || !validEnvelope(current.payload, 'index', indexId))) {
        throw new CoreError('INCOMPLETE_STATE', 'The stored connector index is not writable.')
      }
      const value = current?.kind === 'grant' && validEnvelope(current.payload, 'index', indexId)
        ? current.payload.value as StateIndex : { ids: [] }
      if (!validIndex(value)) throw new CoreError('INCOMPLETE_STATE', 'The stored connector index is invalid.')
      if (value.ids.includes(id)) return current
      if (value.ids.length >= MAX_INDEX) throw new CoreError('CONNECTOR_LIMIT', 'The connector registry reached its bound.')
      return { kind: 'grant', payload: { format, collection: 'index', id: indexId,
        value: { ids: [...value.ids, id] } } satisfies StateEnvelope }
    })
    if (!result) throw new CoreError('CONNECTOR_STATE_FAILED', 'The connector index could not be saved.')
  }

  private async removeFromIndex(collection: string, index: string, id: string) {
    const indexId = `${collection}:${index}`
    await this.records.modifyRecord(this.key('index', indexId), async current => {
      if (current === undefined) return undefined
      if (current.kind !== 'grant' || !validEnvelope(current.payload, 'index', indexId)) {
        throw new CoreError('INCOMPLETE_STATE', 'The stored connector index is not writable.')
      }
      const value = current.payload.value as StateIndex
      if (!validIndex(value)) throw new CoreError('INCOMPLETE_STATE', 'The stored connector index is invalid.')
      const ids = value.ids.filter(entry => entry !== id)
      return { kind: 'grant', payload: { format, collection: 'index', id: indexId,
        value: { ids } } satisfies StateEnvelope }
    })
  }
}

export class MemoryConnectorStateStore implements ConnectorStateStore {
  private readonly records = new Map<string, unknown>()
  private readonly indexes = new Map<string, Set<string>>()
  private readonly key = (collection: string, id: string) => `${collection}\0${id}`
  private readonly indexKey = (collection: string, index: string) => `${collection}\0${index}`

  async read<T>(collection: string, id: string): Promise<T | undefined> {
    return this.records.get(this.key(collection, id)) as T | undefined
  }

  async write<T>(collection: string, id: string, value: T, index?: string): Promise<void> {
    this.records.set(this.key(collection, id), structuredClone(value))
    if (index !== undefined) {
      const key = this.indexKey(collection, index)
      const ids = this.indexes.get(key) ?? new Set<string>()
      ids.add(id)
      this.indexes.set(key, ids)
    }
  }

  async delete(collection: string, id: string, index?: string): Promise<void> {
    this.records.delete(this.key(collection, id))
    if (index !== undefined) this.indexes.get(this.indexKey(collection, index))?.delete(id)
  }

  async unindex(collection: string, id: string, index: string): Promise<void> {
    this.indexes.get(this.indexKey(collection, index))?.delete(id)
  }

  async entries<T>(collection: string, index: string): Promise<Array<{ id: string; value: T }>> {
    const ids = [...(this.indexes.get(this.indexKey(collection, index)) ?? [])]
    const items: Array<{ id: string; value: T }> = []
    for (const id of ids) {
      const value = await this.read<T>(collection, id)
      if (value !== undefined) items.push({ id, value })
    }
    return items
  }
}

export function createCredentialRecordStateStore(records: ProductCredentialRecords,
  instanceId: string): ConnectorStateStore {
  return new CredentialRecordStateStore(records, instanceId)
}

export class CommandJournal {
  private readonly flights = new Map<string, Promise<unknown>>()

  constructor(private readonly store: ConnectorStateStore, private readonly collection: string) {}

  async run<T>(commandId: string, input: unknown, operation: () => Promise<T>): Promise<T> {
    identifier(commandId, 'commandId')
    const fingerprint = digest([this.collection, input])
    const prior = await this.store.read<CommandReceipt>(this.collection, commandId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new CoreError('IDENTITY_CONFLICT', 'This command ID was reused with different input.')
      }
      return prior.result as T
    }
    const active = this.flights.get(commandId)
    if (active) {
      const result = await active as T
      const receipt = await this.store.read<CommandReceipt>(this.collection, commandId)
      if (!receipt || receipt.fingerprint !== fingerprint) {
        throw new CoreError('IDENTITY_CONFLICT', 'This command ID is active with different input.')
      }
      return result
    }
    const flight = (async () => {
      const result = await operation()
      await this.store.write(this.collection, commandId, { fingerprint, result } satisfies CommandReceipt)
      return result
    })()
    this.flights.set(commandId, flight)
    try { return await flight as T }
    finally { if (this.flights.get(commandId) === flight) this.flights.delete(commandId) }
  }
}
