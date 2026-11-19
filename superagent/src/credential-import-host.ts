import { randomUUID } from 'node:crypto'
import { CoreError } from './model.js'
import type { CredentialImportAdapter, CredentialImportValue } from './product-credential-imports.js'

const errors = new Set(['CREDENTIAL_IMPORT_NOT_FOUND', 'CREDENTIAL_IMPORT_CONFLICT', 'CREDENTIAL_IMPORT_UNKNOWN'])

function notify(type: 'ds-superagent:credential-import-cancel' | 'ds-superagent:credential-import-finish', pendingId: string, sourceRef: string) {
  const send = process.send
  if (!send) return Promise.reject(new CoreError('CREDENTIAL_IMPORT_UNAVAILABLE', 'The desktop credential import bridge is unavailable.'))
  return new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new CoreError('CREDENTIAL_IMPORT_UNKNOWN', 'The pending credential could not be cleared.')), 5_000)
    send.call(process, { type, pendingId, sourceRef }, error => {
      if (error) finish(new CoreError('CREDENTIAL_IMPORT_UNKNOWN', 'The pending credential could not be cleared.'))
      else finish()
    })
  })
}

/** The app process owns the selected file; only the exact reviewed item crosses this bridge. */
export class HostCredentialImportAdapter implements CredentialImportAdapter {
  read(pendingId: string, credentialId: string, sourceRef: string): Promise<CredentialImportValue> {
    const send = process.send
    if (!send) return Promise.reject(new CoreError('CREDENTIAL_IMPORT_UNAVAILABLE', 'The desktop credential import bridge is unavailable.'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (error?: Error, value?: CredentialImportValue) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        process.off('message', receive)
        if (error) reject(error)
        else if (value) resolve(value)
        else reject(new CoreError('CREDENTIAL_IMPORT_UNKNOWN', 'The selected credential could not be received.'))
      }
      const receive = (message: unknown) => {
        const reply = message as { type?: string; id?: string; code?: string; credentialId?: string;
          sourceRef?: string; value?: string } | null
        if (reply?.type !== 'ds-superagent:credential-import-response' || reply.id !== id) return
        if (reply.code) {
          const code = errors.has(reply.code) ? reply.code : 'CREDENTIAL_IMPORT_UNKNOWN'
          finish(new CoreError(code, 'The selected credential could not be received.'))
        } else if (reply.credentialId === credentialId && reply.sourceRef === sourceRef && typeof reply.value === 'string') {
          finish(undefined, { id: reply.credentialId, sourceRef: reply.sourceRef, value: reply.value })
        } else finish(new CoreError('CREDENTIAL_IMPORT_CONFLICT', 'The selected export item changed.'))
      }
      const timeout = setTimeout(() => finish(new CoreError('CREDENTIAL_IMPORT_UNKNOWN', 'The credential import response timed out.')), 30_000)
      process.on('message', receive)
      send.call(process, { type: 'ds-superagent:credential-import-read', id, pendingId, credentialId, sourceRef }, error => {
        if (error) finish(new CoreError('CREDENTIAL_IMPORT_UNKNOWN', 'The credential import request could not be sent.'))
      })
    })
  }

  cancel(pendingId: string, sourceRef: string): Promise<void> {
    return notify('ds-superagent:credential-import-cancel', pendingId, sourceRef)
  }

  finish(pendingId: string, sourceRef: string): Promise<void> {
    return notify('ds-superagent:credential-import-finish', pendingId, sourceRef)
  }
}
