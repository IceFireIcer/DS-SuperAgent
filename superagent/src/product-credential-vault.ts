import { createHash, randomUUID } from 'node:crypto'
import { CoreError, identifier } from './model.js'
import type { CredentialVault } from './resource-credentials.js'

type CredentialRecord = { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
  | { readonly kind: 'grant'; readonly payload: unknown }

/** The record half of the public DSH 0.2.1-rc.4 ctx.credentials service. */
export interface ProductCredentialRecords {
  readRecord(key: string): Promise<CredentialRecord | undefined>
  modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  deleteRecord(key: string): Promise<void>
}

const owner = 'ds-superagent-profile'
const unavailable = () => new CoreError('RESOURCE_UNAVAILABLE', 'The vault reference is unavailable for this Instance.')
const writeFailed = () => new CoreError('CREDENTIAL_WRITE_FAILED', 'The credential could not be changed.')

function keyFor(instanceId: string, reference: string): string {
  identifier(instanceId, 'instanceId')
  const digest = createHash('sha256').update(instanceId).digest('hex')
  const match = typeof reference === 'string'
    ? /^ds-superagent-profile\/vault-([a-f0-9]{64})-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.exec(reference)
    : null
  if (match?.[1] !== digest) {
    throw unavailable()
  }
  return reference
}

export function assertCredentialValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16384 || /[\r\n]/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'The credential value is invalid.')
  }
}

function stableUuid(instanceId: string, commandId: string) {
  const bytes = createHash('sha256').update(JSON.stringify([instanceId, commandId])).digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Host-only adapter. Record keys cannot resolve ambient env or profile credentials. */
export class ProductCredentialVault implements CredentialVault {
  constructor(private readonly records: ProductCredentialRecords) {
    if (!records || typeof records.readRecord !== 'function' || typeof records.modifyRecord !== 'function'
      || typeof records.deleteRecord !== 'function') throw unavailable()
  }

  referenceFor(instanceId: string, commandId: string) {
    identifier(instanceId, 'instanceId'); identifier(commandId, 'commandId')
    return `${owner}/vault-${createHash('sha256').update(instanceId).digest('hex')}-${stableUuid(instanceId, commandId)}`
  }

  async create(instanceId: string, value: string, commandId?: string): Promise<string> {
    identifier(instanceId, 'instanceId'); assertCredentialValue(value)
    if (commandId !== undefined) identifier(commandId, 'commandId')
    const reference = commandId === undefined
      ? `${owner}/vault-${createHash('sha256').update(instanceId).digest('hex')}-${randomUUID()}`
      : this.referenceFor(instanceId, commandId)
    try {
      await this.records.modifyRecord(reference, async current => {
        if (current !== undefined) {
          if (current.kind === 'api-key' && current.env === undefined && current.key === value) return current
          throw writeFailed()
        }
        return { kind: 'api-key', key: value }
      })
      if (await this.readSecret(instanceId, reference) !== value) throw writeFailed()
    } catch { throw writeFailed() }
    return reference
  }

  async assertReference(instanceId: string, reference: string): Promise<void> {
    await this.readSecret(instanceId, reference)
  }

  async withSecret<T>(instanceId: string, reference: string, consume: (secret: string) => Promise<T>): Promise<T> {
    const secret = await this.readSecret(instanceId, reference)
    try { return await consume(secret) }
    catch { throw new CoreError('CREDENTIAL_USE_FAILED', 'The credential could not be used.') }
  }

  async revoke(instanceId: string, reference: string): Promise<void> {
    const key = keyFor(instanceId, reference)
    await this.readSecret(instanceId, reference)
    try {
      await this.records.deleteRecord(key)
      if (await this.records.readRecord(key) !== undefined) throw writeFailed()
    } catch { throw writeFailed() }
  }

  async ensureRevoked(instanceId: string, reference: string): Promise<void> {
    const key = keyFor(instanceId, reference)
    try {
      await this.records.deleteRecord(key)
      if (await this.records.readRecord(key) !== undefined) throw writeFailed()
    } catch { throw writeFailed() }
  }

  private async readSecret(instanceId: string, reference: string): Promise<string> {
    const key = keyFor(instanceId, reference)
    try {
      const record = await this.records.readRecord(key)
      if (record?.kind !== 'api-key' || typeof record.key !== 'string' || !record.key.trim() || record.env !== undefined) {
        throw unavailable()
      }
      return record.key
    } catch { throw unavailable() }
  }
}
