import { CoreError } from '../model.js'
import type { CredentialPurpose, CredentialResourceView, CredentialScope, CredentialUse } from '../resource-credentials.js'
import { assertNonToolTarget, grantAllows, targetScope, type ProductTarget } from './target.js'

export interface ConnectorCredentialPort {
  create(input: { instanceId: string; commandId: string; label: string; value: string }): Promise<CredentialResourceView>
  get(input: { instanceId: string; resourceId: string }): Promise<CredentialResourceView | undefined>
  grant(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number;
    scope: CredentialScope; purposes: CredentialPurpose[]; requestId?: string }): Promise<CredentialResourceView>
  rotate(input: { instanceId: string; commandId: string; resourceId: string; expectedRevision: number;
    value: string }): Promise<{ status: 'committed'; resource: CredentialResourceView; cleanupPending: boolean }>
  delete(input: { instanceId: string; commandId: string; resourceId: string;
    expectedRevision: number }): Promise<CredentialResourceView>
  use<T>(input: CredentialUse, consume: (secret: string) => Promise<T>): Promise<T>
}

export interface SavedCredential {
  resourceId: string
  grantId?: string
  revision: number
}

function matchingGrant(resource: CredentialResourceView, target: ProductTarget, purpose: CredentialPurpose) {
  return resource.grants.find(grant => grantAllows(grant, target, purpose))
}

async function ensureGrant(input: {
  credentials: ConnectorCredentialPort
  instanceId: string
  resource: CredentialResourceView
  target: ProductTarget
  purpose: CredentialPurpose
  commandId: string
  priorGrantId?: string
}): Promise<{ resource: CredentialResourceView; grantId?: string }> {
  const prior = input.priorGrantId
    ? input.resource.grants.find(grant => grant.id === input.priorGrantId && grantAllows(grant, input.target, input.purpose))
    : undefined
  if (prior) return { resource: input.resource, grantId: prior.id }
  const current = matchingGrant(input.resource, input.target, input.purpose)
  if (current) return { resource: input.resource, grantId: current.id }
  let granted: CredentialResourceView
  try {
    granted = await input.credentials.grant({ instanceId: input.instanceId, commandId: input.commandId,
      resourceId: input.resource.id, expectedRevision: input.resource.revision,
      scope: targetScope(input.target), purposes: [input.purpose] })
  } catch (error) {
    if (error instanceof CoreError && error.code === 'GRANT_CONFLICT') {
      const latest = await input.credentials.get({ instanceId: input.instanceId, resourceId: input.resource.id })
      const found = latest ? matchingGrant(latest, input.target, input.purpose) : undefined
      if (latest && found) return { resource: latest, grantId: found.id }
    }
    throw error
  }
  const grantId = matchingGrant(granted, input.target, input.purpose)?.id
  return { resource: granted, ...(grantId === undefined ? {} : { grantId }) }
}

export async function saveProductCredential(input: {
  credentials: ConnectorCredentialPort
  instanceId: string
  commandId: string
  label: string
  value: string
  target: ProductTarget
  purpose: CredentialPurpose
  existing?: { resourceId: string; grantId?: string }
}): Promise<SavedCredential> {
  assertNonToolTarget(input.target, input.purpose)
  let resource: CredentialResourceView | undefined
  if (input.existing) {
    const current = await input.credentials.get({ instanceId: input.instanceId, resourceId: input.existing.resourceId })
    if (current?.status === 'active') {
      const rotated = await input.credentials.rotate({ instanceId: input.instanceId,
        commandId: `${input.commandId}:rotate`, resourceId: current.id,
        expectedRevision: current.revision, value: input.value })
      resource = rotated.resource
    }
  }
  resource ??= await input.credentials.create({ instanceId: input.instanceId, commandId: input.commandId,
    label: input.label, value: input.value })
  const granted = await ensureGrant({ credentials: input.credentials, instanceId: input.instanceId, resource,
    target: input.target, purpose: input.purpose, commandId: `${input.commandId}:grant`,
    ...(input.existing?.grantId === undefined ? {} : { priorGrantId: input.existing.grantId }) })
  return { resourceId: granted.resource.id, revision: granted.resource.revision,
    ...(granted.grantId === undefined ? {} : { grantId: granted.grantId }) }
}

export async function deleteProductCredential(credentials: ConnectorCredentialPort, instanceId: string,
  commandId: string, resourceId: string): Promise<void> {
  const resource = await credentials.get({ instanceId, resourceId })
  if (!resource || resource.status !== 'active') return
  await credentials.delete({ instanceId, commandId, resourceId, expectedRevision: resource.revision })
}

export function grantFor(resource: CredentialResourceView, target: ProductTarget,
  purpose: CredentialPurpose): CredentialResourceView['grants'][number] | undefined {
  return matchingGrant(resource, target, purpose)
}
