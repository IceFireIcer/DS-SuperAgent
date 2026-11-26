import { isAbsolute, resolve } from 'node:path'
import { CoreError, type PathGrant, type PathGrantOperation } from './model.js'
import { protectedPath } from './path-safety.js'

const pathGrantOperations: readonly PathGrantOperation[] = ['read', 'write', 'search', 'command']
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path

export function normalizePathGrants(value: unknown): PathGrant[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new CoreError('INVALID_INPUT', 'A task needs one to eight explicit path grants.')
  }
  const paths = new Set<string>()
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CoreError('INVALID_INPUT', `Path grant ${index + 1} must be an object.`)
    }
    const record = entry as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'path' && key !== 'operations')) {
      throw new CoreError('INVALID_INPUT', 'A path grant accepts only a path and operations.')
    }
    if (typeof record.path !== 'string' || !record.path.trim() || Buffer.byteLength(record.path) > 1024
      || record.path.includes('\0') || !isAbsolute(record.path)) {
      throw new CoreError('INVALID_INPUT', 'A path grant needs one absolute path of at most 1024 bytes.')
    }
    const path = resolve(record.path)
    const key = pathKey(path)
    if (protectedPath(path) || paths.has(key)) {
      throw new CoreError('INVALID_INPUT', 'Path grants cannot repeat paths or include protected locations.')
    }
    paths.add(key)
    const requested = record.operations
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > pathGrantOperations.length
      || requested.some(operation => typeof operation !== 'string'
        || !pathGrantOperations.includes(operation as PathGrantOperation))
      || new Set(requested).size !== requested.length) {
      throw new CoreError('INVALID_INPUT', 'Each path grant needs distinct read, write, search or command operations.')
    }
    const operations = pathGrantOperations.filter(operation => requested.includes(operation))
    return { path, operations: [...operations] }
  })
}

export function mergePathGrants(existing: readonly PathGrant[] | undefined, added: readonly PathGrant[]): PathGrant[] {
  const paths = new Map((existing ?? []).map(grant =>
    [pathKey(grant.path), { path: grant.path, operations: new Set(grant.operations) }]))
  for (const grant of added) {
    const key = pathKey(grant.path)
    const current = paths.get(key)
    const operations = current?.operations ?? new Set<PathGrantOperation>()
    for (const operation of grant.operations) operations.add(operation)
    paths.set(key, { path: current?.path ?? grant.path, operations })
  }
  return [...paths.values()].map(grant => ({ path: grant.path,
    operations: pathGrantOperations.filter(operation => grant.operations.has(operation)) }))
}
