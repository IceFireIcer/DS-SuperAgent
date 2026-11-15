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

function secretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 16384 || /[\r\n]/u.test(value)) {
    throw new CoreError('INVALID_INPUT', 'The credential value is invalid.')
  }
}

/** Host-only adapter. Record keys cannot resolve ambient env or profile credentials. */
export class ProductCredentialVault implements CredentialVault {
  constructor(private readonly records: ProductCredentialRecords) {
    if (!records || typeof records.readRecord !== 'function' || typeof records.modifyRecord !== 'function'
      || typeof records.deleteRecord !== 'function') throw unavailable()
  }

  async create(instanceId: string, value: string): Promise<string> {
    identifier(instanceId, 'instanceId'); secretValue(value)
    const reference = `${owner}/vault-${createHash('sha256').update(instanceId).digest('hex')}-${randomUUID()}`
    try {
      await this.records.modifyRecord(reference, async current => {
        if (current !== undefined) throw writeFailed()
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

  async rotate(instanceId: string, reference: string, value: string): Promise<void> {
    const key = keyFor(instanceId, reference)
    secretValue(value)
    let missing = false
    try {
      const updated = await this.records.modifyRecord(key, async current => {
        if (current?.kind !== 'api-key' || typeof current.key !== 'string' || !current.key.trim() || current.env !== undefined) {
          missing = true
          return undefined
        }
        return { kind: 'api-key', key: value }
      })
      if (missing) throw unavailable()
      if (updated?.kind !== 'api-key' || updated.key !== value || updated.env !== undefined) throw writeFailed()
    } catch { throw missing ? unavailable() : writeFailed() }
  }

  async revoke(instanceId: string, reference: string): Promise<void> {
    const key = keyFor(instanceId, reference)
    await this.readSecret(instanceId, reference)
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
