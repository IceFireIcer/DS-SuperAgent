import { createHash } from 'node:crypto'
import { canonicalJson } from '../commands.js'
import { CoreError, identifier } from '../model.js'
import type { CredentialGrant, CredentialPurpose, CredentialScope } from '../resource-credentials.js'

export type ProductTargetRole = 'main' | 'router' | 'worker'

export interface ProductTarget {
  role: ProductTargetRole
  workItemId?: string
  environmentId?: string
  sourceInstanceId?: string
}

const roles: ProductTargetRole[] = ['main', 'router', 'worker']

function plainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CoreError('INVALID_INPUT', `Choose an explicit ${label}.`)
  }
}

/** Validates the product target and never accepts a legacy bot identity. */
export function normalizeTarget(value: unknown): ProductTarget {
  plainObject(value, 'target')
  if (Object.keys(value).some(key => !['role', 'workItemId', 'environmentId', 'sourceInstanceId'].includes(key))) {
    throw new CoreError('INVALID_INPUT', 'The target contains unsupported fields; choose a role and exact work scope.')
  }
  if (!roles.includes(value.role as ProductTargetRole)) {
    throw new CoreError('INVALID_INPUT', 'The target role must be main, router, or worker.')
  }
  const target: ProductTarget = { role: value.role as ProductTargetRole }
  for (const key of ['workItemId', 'environmentId', 'sourceInstanceId'] as const) {
    const item = value[key]
    if (item === undefined || item === '') continue
    identifier(item, key)
    target[key] = item
  }
  if (target.role === 'worker' && target.workItemId === undefined && target.environmentId === undefined) {
    throw new CoreError('INVALID_INPUT', 'A worker target needs a work item or Environment.')
  }
  return target
}

export function targetKey(actorId: string, target: ProductTarget): string {
  identifier(actorId, 'actorId')
  return createHash('sha256').update(canonicalJson(['product-target-v1', actorId, target])).digest('hex')
}

export function targetFingerprint(target: ProductTarget): string {
  return createHash('sha256').update(canonicalJson(['product-target-v1', target])).digest('hex')
}

export function targetScope(target: ProductTarget): CredentialScope {
  return { role: target.role,
    ...(target.workItemId === undefined ? {} : { workItemId: target.workItemId }),
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    ...(target.sourceInstanceId === undefined ? {} : { sourceInstanceId: target.sourceInstanceId }) }
}

export function grantAllows(grant: CredentialGrant, target: ProductTarget, purpose: CredentialPurpose): boolean {
  const scope = grant.scope
  return grant.purposes.includes(purpose)
    && scope.role === target.role
    && (scope.workItemId === undefined || scope.workItemId === target.workItemId)
    && (scope.environmentId === undefined || scope.environmentId === target.environmentId)
    && (scope.sourceInstanceId === undefined || scope.sourceInstanceId === target.sourceInstanceId)
    && (purpose === 'tool' || scope.sourceInstanceId === target.sourceInstanceId)
}

export function assertNonToolTarget(target: ProductTarget, purpose: CredentialPurpose) {
  if (purpose !== 'tool' && target.sourceInstanceId === undefined) {
    throw new CoreError('INVALID_INPUT', 'Source and outbound grants need an exact source Instance.')
  }
}
