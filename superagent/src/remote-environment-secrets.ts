import { createHash } from 'node:crypto'
import { CoreError, identifier } from './model.js'

type CredentialRecord = { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }

export interface RemoteCredentialRecords {
  readRecord(key: string): Promise<CredentialRecord | undefined>
  modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  deleteRecord(key: string): Promise<void>
}

const unavailable = () => new CoreError('RESOURCE_UNAVAILABLE', 'The remote Environment credential record is unavailable.')
const writeFailed = () => new CoreError('CREDENTIAL_WRITE_FAILED', 'The remote Environment credential could not be saved.')

/** Keeps the Host half of a paired device in DSH credential storage, outside business rows. */
export class RemoteEnvironmentSecrets {
  constructor(private readonly records: RemoteCredentialRecords) {
    if (!records || typeof records.readRecord !== 'function' || typeof records.modifyRecord !== 'function'
      || typeof records.deleteRecord !== 'function') throw unavailable()
  }

  referenceFor(instanceId: string, commandId: string) {
    identifier(instanceId, 'instanceId')
    identifier(commandId, 'commandId')
    return `ds-superagent-profile/remote-environment-${createHash('sha256').update(instanceId).digest('hex')}-${createHash('sha256').update(commandId).digest('hex').slice(0, 32)}`
  }

  async create(reference: string, value: string): Promise<void> {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 16384) throw writeFailed()
    try {
      await this.records.modifyRecord(reference, async current => {
        if (current !== undefined) {
          if (current.kind === 'api-key' && current.env === undefined && current.key === value) return current
          throw writeFailed()
        }
        return { kind: 'api-key', key: value }
      })
      if (await this.read(reference) !== value) throw writeFailed()
    } catch { throw writeFailed() }
  }

  async withSecret<T>(reference: string, consume: (secret: string) => Promise<T>): Promise<T> {
    const secret = await this.read(reference)
    return consume(secret)
  }

  async remove(reference: string): Promise<void> {
    try {
      await this.records.deleteRecord(reference)
      if (await this.records.readRecord(reference) !== undefined) throw writeFailed()
    } catch { throw writeFailed() }
  }

  async ensureRemoved(reference: string): Promise<void> {
    try {
      await this.records.deleteRecord(reference)
      if (await this.records.readRecord(reference) !== undefined) throw writeFailed()
    } catch { throw writeFailed() }
  }

  private async read(reference: string): Promise<string> {
    try {
      const record = await this.records.readRecord(reference)
      if (record?.kind !== 'api-key' || typeof record.key !== 'string' || !record.key
        || record.env !== undefined) throw unavailable()
      return record.key
    } catch { throw unavailable() }
  }
}
