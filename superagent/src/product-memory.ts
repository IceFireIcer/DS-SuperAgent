import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, commandTransaction } from './commands.js'
import { CoreError, identifier, type Work } from './model.js'
import {
  credentialLike, decodeMemoryExport, parseMemoryImport,
  type MemoryImportOrigin, type MemoryImportOriginalScope,
} from './product-memory-import.js'
import type { AsyncTx, Storage } from './storage.js'
import type { NativeTool } from './native-sessions.js'

export type MemoryScope = { kind: 'main' } | { kind: 'work'; workItemId: string }
  | { kind: 'shared'; main: boolean; workItemIds: string[] }
export type MemoryReader = { role: 'main'; sessionId: string }
  | { role: 'worker'; ticketId: string; assignmentId: string; sessionId: string }
export type MemorySideTarget = { kind: 'main' } | { kind: 'work'; workItemId: string }

export interface MemoryProvenance {
  batchId: string
  sourceItemId: string
  sourceHash: string
  originalOwner: string
  originalScope: MemoryImportOriginalScope
}
export interface MemoryEntry {
  id: string
  scope: MemoryScope
  revision: number
  status: 'active' | 'forgotten'
  text?: string
  contentHash?: string
  provenance?: MemoryProvenance
  createdAt: number
  updatedAt: number
}
export interface MemoryProposal {
  id: string
  scope: Extract<MemoryScope, { kind: 'main' | 'work' }>
  text?: string
  reason: string
  status: 'pending' | 'approved' | 'declined' | 'stale'
  createdAt: number
  expiresAt: number
  accessRevision?: number
  assignmentId?: string
  sessionId: string
  entryId?: string
}
export interface WorkAccess { revision: number; enabled: boolean }
export interface MemoryImportBatch {
  id: string
  sourceHash: string
  sourceName: string
  origin: MemoryImportOrigin
  status: 'ready' | 'partial' | 'completed' | 'cancelled'
  itemIds: string[]
  createdAt: number
  updatedAt: number
}
export interface MemoryImportItem {
  id: string
  sourceId: string
  sourceHash: string
  originalScope: MemoryImportOriginalScope
  status: 'ready' | 'rejected' | 'imported' | 'conflict'
  text?: string
  reason?: string
  target?: MemoryScope
  entryId?: string
  existingMemoryId?: string
  existingBatchId?: string
}
interface MemoryImportSourceIdentity {
  id: string
  sourceId: string
  contentHash: string
  batchId: string
  itemId: string
  createdAt: number
}
interface Receipt { fingerprint: string; entryId?: string; proposalId?: string; batchId?: string; revision?: number; status: string }
interface MainState { instanceId: string; mainId: string; mainSessionId: string }
interface Assignment { id: string; sessionId: string; state: string }

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const workAccessKey = (workItemId: string) => workItemId
const MAX_SCAN = 1000

function validText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new CoreError('INVALID_INPUT', `${label} needs 1–${max} bytes of text.`)
  }
  const text = value.trim()
  if (credentialLike(text)) {
    throw new CoreError('MEMORY_SENSITIVE', 'Credentials belong in the protected credential store, not memory.')
  }
  return text
}

function bounded(limit: number | undefined, max: number) {
  const value = limit ?? Math.min(20, max)
  if (!Number.isInteger(value) || value < 1 || value > max) throw new CoreError('INVALID_INPUT', `Choose a limit between 1 and ${max}.`)
  return value
}

function scopeOf(value: MemoryScope): MemoryScope {
  if (!value || typeof value !== 'object') throw new CoreError('INVALID_INPUT', 'Choose a memory owner.')
  if (value.kind === 'main' && Object.keys(value).length === 1) return { kind: 'main' }
  if (value.kind === 'work' && Object.keys(value).length === 2) {
    identifier(value.workItemId, 'workItemId')
    return { kind: 'work', workItemId: value.workItemId }
  }
  if (value.kind === 'shared' && Object.keys(value).length === 3 && typeof value.main === 'boolean'
    && Array.isArray(value.workItemIds) && value.workItemIds.length <= 20) {
    value.workItemIds.forEach(id => identifier(id, 'workItemId'))
    if (new Set(value.workItemIds).size !== value.workItemIds.length) throw new CoreError('INVALID_INPUT', 'Shared work recipients must be unique.')
    return { kind: 'shared', main: value.main, workItemIds: [...value.workItemIds].sort() }
  }
  throw new CoreError('INVALID_INPUT', 'Choose Main, one work, or explicit shared recipients.')
}

function pageText(entry: MemoryEntry, after: string | undefined, maxBytes: number) {
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 4096) throw new CoreError('INVALID_INPUT', 'Read 256–4096 bytes per page.')
  const text = entry.text!
  const version = digest([entry.id, entry.revision, text])
  let offset = 0
  if (after !== undefined) {
    const [raw, hash, extra] = after.split(':')
    if (extra !== undefined || !/^(0|[1-9]\d*)$/u.test(raw ?? '') || hash !== version) {
      throw new CoreError('MEMORY_CURSOR_STALE', 'Memory changed since the last page; start over.')
    }
    offset = Number(raw)
  }
  const totalBytes = Buffer.byteLength(text)
  if (!Number.isSafeInteger(offset) || offset > totalBytes) throw new CoreError('INVALID_INPUT', 'The memory cursor is invalid.')
  let from = 0; let bytes = 0; let end = 0; let counted = 0
  for (const char of text) {
    const width = Buffer.byteLength(char)
    if (counted < offset) {
      if (counted + width > offset) throw new CoreError('INVALID_INPUT', 'The memory cursor splits a character.')
      counted += width; from += char.length; end = from; continue
    }
    if (bytes + width > maxBytes) break
    bytes += width; end += char.length; counted += width
  }
  if (counted !== offset + bytes) throw new CoreError('INVALID_INPUT', 'The memory cursor is invalid.')
  const truncated = offset + bytes < totalBytes
  return { id: entry.id, scope: entry.scope, revision: entry.revision, ...(entry.provenance ? { provenance: entry.provenance } : {}),
    text: text.slice(from, end),
    pagination: { totalBytes, returnedBytes: bytes, truncated,
      ...(truncated ? { cursor: `${offset + bytes}:${version}` } : {}) } }
}

export class ProductMemory {
  constructor(private readonly storage: Storage, private readonly instanceId: string, private readonly now = Date.now) {}

  private async main(tx: AsyncTx) {
    const main = await tx.get<MainState>('main-state', 'main')
    if (!main || main.instanceId !== this.instanceId) throw new CoreError('SOURCE_NOT_AUTHORIZED', 'No current Main owns this memory.')
    return main
  }

  private async work(tx: AsyncTx, workItemId: string) {
    identifier(workItemId, 'workItemId')
    const main = await this.main(tx)
    const index = await tx.get<{ ticketId: string; workBriefId: string }>('work-item-ticket', workItemId)
    const brief = index && await tx.get<{ mainId: string; instanceId: string }>('work-brief', index.workBriefId)
    if (!index || !brief || brief.mainId !== main.mainId || brief.instanceId !== this.instanceId) {
      throw new CoreError('NOT_FOUND', 'This work does not belong to the current Main.')
    }
    return index.ticketId
  }

  private async authorize(tx: AsyncTx, reader: MemoryReader): Promise<{ workItemId?: string; accessRevision?: number }> {
    if (reader?.role === 'main') {
      identifier(reader.sessionId, 'sessionId')
      if ((await this.main(tx)).mainSessionId !== reader.sessionId) throw new CoreError('MEMORY_DENIED', 'This Main generation is no longer current.')
      return {}
    }
    if (reader?.role !== 'worker') throw new CoreError('MEMORY_DENIED', 'The role cannot read memory.')
    identifier(reader.ticketId, 'ticketId'); identifier(reader.assignmentId, 'assignmentId'); identifier(reader.sessionId, 'sessionId')
    const assignment = await tx.get<Assignment>('assignment', reader.ticketId)
    const ticket = await tx.get<Work['ticket']>('ticket', reader.ticketId)
    const index = await tx.get<{ workItemId: string }>('work-ticket', reader.ticketId)
    if (!assignment || assignment.id !== reader.assignmentId || assignment.sessionId !== reader.sessionId
      || assignment.state !== 'running' || !ticket || ticket.state !== 'open' || ticket.constraint || !index
      || await this.work(tx, index.workItemId) !== reader.ticketId) {
      throw new CoreError('MEMORY_DENIED', 'This Worker is no longer authorized for work memory.')
    }
    const access = await tx.get<WorkAccess>('product-memory-access', workAccessKey(index.workItemId))
    if (!access?.enabled) throw new CoreError('MEMORY_DENIED', 'Memory access has not been granted for this work.')
    return { workItemId: index.workItemId, accessRevision: access.revision }
  }

  private visible(entry: MemoryEntry, reader: MemoryReader, workItemId?: string) {
    if (entry.status !== 'active' || !entry.text) return false
    if (reader.role === 'main') return entry.scope.kind === 'main' || entry.scope.kind === 'shared' && entry.scope.main
    return entry.scope.kind === 'work' && entry.scope.workItemId === workItemId
      || entry.scope.kind === 'shared' && entry.scope.workItemIds.includes(workItemId!)
  }

  private readerScope(scope: MemoryScope, reader: MemoryReader, workItemId?: string): MemoryScope {
    if (reader.role !== 'worker' || scope.kind !== 'shared') return scope
    return { kind: 'shared', main: false, workItemIds: [workItemId!] }
  }

  private async sideReader(tx: AsyncTx, target: MemorySideTarget): Promise<{ reader: MemoryReader; workItemId?: string }> {
    if (target?.kind === 'main' && Object.keys(target).length === 1) {
      const reader: MemoryReader = { role: 'main', sessionId: (await this.main(tx)).mainSessionId }
      await this.authorize(tx, reader)
      return { reader }
    }
    if (target?.kind !== 'work' || Object.keys(target).length !== 2) {
      throw new CoreError('INVALID_INPUT', 'Choose Main or one work for a side query.')
    }
    identifier(target.workItemId, 'workItemId')
    const ticketId = await this.work(tx, target.workItemId)
    const assignment = await tx.get<Assignment>('assignment', ticketId)
    if (!assignment) throw new CoreError('MEMORY_DENIED', 'No current Worker can read this work memory.')
    const reader: MemoryReader = { role: 'worker', ticketId, assignmentId: assignment.id, sessionId: assignment.sessionId }
    const { workItemId } = await this.authorize(tx, reader)
    if (workItemId !== target.workItemId) throw new CoreError('MEMORY_DENIED', 'The Worker no longer owns this work memory.')
    return { reader, workItemId }
  }

  private async searchIn(tx: AsyncTx, reader: MemoryReader, workItemId: string | undefined, wanted: string[], limit: number) {
    const matches: Array<{ id: string; scope: MemoryScope; snippet: string; score: number }> = []
    let after: string | undefined
    for (let scanned = 0; scanned < MAX_SCAN; scanned += 100) {
      const page = await tx.scan<MemoryEntry>('product-memory', { limit: 100, ...(after ? { after } : {}) })
      for (const { value } of page.items) {
        if (!this.visible(value, reader, workItemId)) continue
        const text = value.text!.toLocaleLowerCase()
        const score = wanted.filter(token => text.includes(token)).length
        if (score) matches.push({ id: value.id, scope: this.readerScope(value.scope, reader, workItemId), snippet: value.text!.slice(0, 200), score })
      }
      if (!page.cursor) break
      if (scanned + 100 >= MAX_SCAN) throw new CoreError('MEMORY_BUDGET', 'Search exceeded its bounded memory index.')
      after = page.cursor
    }
    return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
  }

  async search(reader: MemoryReader, query: string, limit = 10) {
    const wanted = validText(query, 'Search', 256).toLocaleLowerCase().split(/\s+/u)
    bounded(limit, 20)
    return this.storage.transaction(this.instanceId, async tx => {
      const { workItemId } = await this.authorize(tx, reader)
      return this.searchIn(tx, reader, workItemId, wanted, limit)
    })
  }

  async sideSearch(target: MemorySideTarget, query: string, limit = 10) {
    const wanted = validText(query, 'Search', 256).toLocaleLowerCase().split(/\s+/u)
    bounded(limit, 20)
    return this.storage.transaction(this.instanceId, async tx => {
      const { reader, workItemId } = await this.sideReader(tx, target)
      return this.searchIn(tx, reader, workItemId, wanted, limit)
    })
  }

  async sideRead(target: MemorySideTarget, id: string, after?: string, maxBytes = 4096) {
    identifier(id, 'memoryId')
    return this.storage.transaction(this.instanceId, async tx => {
      const { reader, workItemId } = await this.sideReader(tx, target)
      const entry = await tx.get<MemoryEntry>('product-memory', id)
      if (!entry || !this.visible(entry, reader, workItemId)) throw new CoreError('NOT_FOUND', 'The memory is unavailable in this scope.')
      return { ...pageText(entry, after, maxBytes), scope: this.readerScope(entry.scope, reader, workItemId) }
    })
  }

  async read(reader: MemoryReader, id: string, after?: string, maxBytes = 4096) {
    identifier(id, 'memoryId')
    return this.storage.transaction(this.instanceId, async tx => {
      const { workItemId } = await this.authorize(tx, reader)
      const entry = await tx.get<MemoryEntry>('product-memory', id)
      if (!entry || !this.visible(entry, reader, workItemId)) throw new CoreError('NOT_FOUND', 'The memory is unavailable in this scope.')
      return { ...pageText(entry, after, maxBytes), scope: this.readerScope(entry.scope, reader, workItemId) }
    })
  }

  async list(limit = 50, after?: string, query?: string) {
    bounded(limit, 100)
    if (after !== undefined) identifier(after, 'cursor')
    const terms = query === undefined || query.trim() === '' ? [] : validText(query, 'Search', 256).toLocaleLowerCase().split(/\s+/u)
    return this.storage.transaction(this.instanceId, async tx => {
      await this.main(tx)
      const entries: MemoryEntry[] = []
      let cursor = after
      let scanned = 0
      while (scanned < MAX_SCAN && entries.length < limit) {
        const starting = cursor
        const page = await tx.scan<MemoryEntry>('product-memory', { limit: Math.min(100, limit - entries.length, MAX_SCAN - scanned),
          ...(cursor ? { after: cursor } : {}) })
        scanned += page.items.length
        for (const row of page.items) {
          cursor = row.id
          if (row.value.status === 'active' && terms.every(term => row.value.text!.toLocaleLowerCase().includes(term))) {
            entries.push({ ...row.value, text: row.value.text!.slice(0, 200) })
          }
        }
        if (!page.cursor) return { items: entries }
        if (scanned >= MAX_SCAN || page.cursor === starting) throw new CoreError('MEMORY_BUDGET', 'The memory list exceeded its bounded scan.')
      }
      return { items: entries, ...(cursor ? { cursor } : {}) }
    })
  }

  async readUser(id: string, after?: string, maxBytes = 4096) {
    identifier(id, 'memoryId')
    return this.storage.transaction(this.instanceId, async tx => {
      await this.main(tx)
      const entry = await tx.get<MemoryEntry>('product-memory', id)
      if (!entry || entry.status !== 'active') throw new CoreError('NOT_FOUND', 'The memory was forgotten or does not exist.')
      return pageText(entry, after, maxBytes)
    })
  }

  private async importItems(tx: AsyncTx, batch: MemoryImportBatch) {
    const items: MemoryImportItem[] = []
    for (const id of batch.itemIds) {
      const item = await tx.get<MemoryImportItem>('product-memory-import-item', id)
      if (!item) throw new CoreError('MEMORY_IMPORT_STALE', 'A memory import item is missing.')
      items.push(item)
    }
    return items
  }

  private async loadImportBatch(tx: AsyncTx, batchId: string) {
    const batch = await tx.get<MemoryImportBatch>('product-memory-import', batchId)
    if (!batch) throw new CoreError('NOT_FOUND', 'This memory import batch does not exist.')
    return { batch, items: await this.importItems(tx, batch) }
  }

  private async importBatchView(tx: AsyncTx, batchId: string) {
    identifier(batchId, 'importBatchId')
    const { batch, items } = await this.loadImportBatch(tx, batchId)
    return { ...batch, targetInstanceId: this.instanceId, targetRoles: ['main', 'worker', 'shared'], items }
  }

  private importStatus(items: MemoryImportItem[]): MemoryImportBatch['status'] {
    if (items.every(item => item.status === 'imported')) return 'completed'
    if (items.every(item => item.status === 'ready')) return 'ready'
    return 'partial'
  }

  private async scanActiveMemory(tx: AsyncTx) {
    const entries: MemoryEntry[] = []
    let after: string | undefined
    for (let scanned = 0; scanned < MAX_SCAN; scanned += 100) {
      const page = await tx.scan<MemoryEntry>('product-memory', { limit: 100, ...(after ? { after } : {}) })
      entries.push(...page.items.map(item => item.value).filter(entry => entry.status === 'active' && entry.text))
      if (!page.cursor) return entries
      if (scanned + 100 >= MAX_SCAN) throw new CoreError('MEMORY_BUDGET', 'The import conflict check exceeded its bounded scan.')
      after = page.cursor
    }
    return entries
  }

  private importSelection(value: { sourceId: string; scope: MemoryScope }) {
    identifier(value.sourceId, 'sourceMemoryId')
    const scope = scopeOf(value.scope)
    if (scope.kind === 'shared' && !scope.main && !scope.workItemIds.length) {
      throw new CoreError('INVALID_INPUT', 'Choose at least one recipient for imported shared memory.')
    }
    return { sourceId: value.sourceId, scope }
  }

  async importBatches(limit = 20) {
    const take = bounded(limit, 100)
    return this.storage.transaction(this.instanceId, async tx => {
      await this.main(tx)
      const batches: MemoryImportBatch[] = []
      let after: string | undefined
      for (let scanned = 0; scanned < MAX_SCAN; scanned += 100) {
        const page = await tx.scan<MemoryImportBatch>('product-memory-import', { limit: 100, ...(after ? { after } : {}) })
        batches.push(...page.items.map(item => item.value))
        if (!page.cursor) break
        if (scanned + 100 >= MAX_SCAN) throw new CoreError('MEMORY_BUDGET', 'The import list exceeded its bounded scan.')
        after = page.cursor
      }
      return { items: batches.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, take) }
    })
  }

  async importBatch(batchId: string) {
    return this.storage.transaction(this.instanceId, async tx => {
      await this.main(tx)
      return this.importBatchView(tx, batchId)
    })
  }

  async previewImport(command: { commandId: string; sourceName: string; data: string | Uint8Array }) {
    const sourceName = validText(command.sourceName, 'Memory export file name', 256)
    const { bytes, text: exported } = decodeMemoryExport(command.data)
    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    return this.command(command.commandId, { sourceName, sourceHash }, async tx => {
      await this.main(tx)
      const batchId = digest(['memory-import-batch', sourceHash])
      const existing = await tx.get<MemoryImportBatch>('product-memory-import', batchId)
      if (existing) {
        return { receipt: { fingerprint: '', batchId, status: existing.status }, value: await this.importBatchView(tx, batchId) }
      }
      const parsed = parseMemoryImport(exported, (value, label) => validText(value, label))
      const now = this.now()
      const items: MemoryImportItem[] = []
      for (const item of parsed.items) {
        const id = digest(['memory-import-item', batchId, item.sourceId])
        const contentHash = item.text ? digest(item.text) : digest([item.sourceId, item.originalScope, item.status])
        const sourceId = digest(['memory-import-source', parsed.origin.owner, parsed.origin.instanceId ?? '', item.sourceId])
        const previous = item.status === 'ready'
          ? await tx.get<MemoryImportSourceIdentity>('product-memory-import-source', sourceId) : undefined
        const conflict = previous && previous.contentHash !== contentHash
        if (item.status === 'ready' && !previous) {
          await tx.insert('product-memory-import-source', sourceId, { id: sourceId, sourceId: item.sourceId,
            contentHash, batchId, itemId: id, createdAt: now })
        }
        items.push({
          id, sourceId: item.sourceId, sourceHash: contentHash, originalScope: item.originalScope,
          status: conflict ? 'conflict' : item.status,
          ...(conflict ? { reason: 'SOURCE_CONTENT_CONFLICT', existingBatchId: previous.batchId } : {}),
          ...(item.text ? { text: item.text } : {}),
          ...(item.reason ? { reason: item.reason } : {}),
        })
      }
      const batch: MemoryImportBatch = {
        id: batchId, sourceHash, sourceName, origin: parsed.origin, status: this.importStatus(items),
        itemIds: items.map(item => item.id), createdAt: now, updatedAt: now,
      }
      for (const item of items) await tx.insert('product-memory-import-item', item.id, item)
      await tx.insert('product-memory-import', batch.id, batch)
      return { receipt: { fingerprint: '', batchId: batch.id, status: batch.status },
        value: await this.importBatchView(tx, batch.id) }
    }, async (tx, receipt) => this.importBatchView(tx, receipt.batchId!))
  }

  async commitImport(command: {
    commandId: string; batchId: string; selections: Array<{ sourceId: string; scope: MemoryScope }>
  }) {
    identifier(command.batchId, 'importBatchId')
    if (!Array.isArray(command.selections) || command.selections.length < 1 || command.selections.length > 50) {
      throw new CoreError('INVALID_INPUT', 'Choose between 1 and 50 memory items to import.')
    }
    const selections = command.selections.map(value => this.importSelection(value))
    if (new Set(selections.map(selection => selection.sourceId)).size !== selections.length) {
      throw new CoreError('INVALID_INPUT', 'Each imported memory item can be selected only once.')
    }
    return this.command(command.commandId, { batchId: command.batchId, selections }, async tx => {
      await this.main(tx)
      const { batch, items } = await this.loadImportBatch(tx, command.batchId)
      if (batch.status === 'cancelled') throw new CoreError('MEMORY_IMPORT_CANCELLED', 'Retry this import before choosing items.')
      const bySource = new Map(items.map(item => [item.sourceId, item]))
      for (const selection of selections) {
        const item = bySource.get(selection.sourceId)
        if (!item || item.status === 'rejected') throw new CoreError('MEMORY_IMPORT_STALE', 'A selected memory item cannot be imported.')
        if (item.reason === 'SOURCE_CONTENT_CONFLICT') {
          throw new CoreError('MEMORY_IMPORT_CONFLICT', 'This source item changed after it was first previewed.')
        }
        await this.checkScope(tx, selection.scope)
        if (item.status === 'imported' && digest(item.target) !== digest(selection.scope)) {
          throw new CoreError('MEMORY_IMPORT_CONFLICT', 'This item was already imported to another target.')
        }
      }
      const activeEntries = await this.scanActiveMemory(tx)
      for (const selection of selections) {
        const item = bySource.get(selection.sourceId)!
        if (item.status === 'imported') continue
        const duplicate = activeEntries.find(entry => digest(entry.scope) === digest(selection.scope)
          && (entry.contentHash ?? digest(entry.text!)) === item.sourceHash)
        if (duplicate) {
          const conflict: MemoryImportItem = { ...item, status: 'conflict', reason: 'DUPLICATE_MEMORY',
            existingMemoryId: duplicate.id, target: selection.scope }
          bySource.set(item.sourceId, conflict)
          await tx.replace('product-memory-import-item', item.id, conflict)
          continue
        }
        const entry = await this.createImportedMemory(tx, batch, item, selection.scope)
        activeEntries.push(entry)
        const imported: MemoryImportItem = { ...item, status: 'imported', target: selection.scope, entryId: entry.id }
        bySource.set(item.sourceId, imported)
        await tx.replace('product-memory-import-item', item.id, imported)
      }
      const nextItems = items.map(item => bySource.get(item.sourceId)!)
      const updated = { ...batch, status: this.importStatus(nextItems), updatedAt: this.now() }
      await tx.replace('product-memory-import', batch.id, updated)
      return { receipt: { fingerprint: '', batchId: batch.id, status: updated.status },
        value: await this.importBatchView(tx, batch.id) }
    }, async (tx, receipt) => this.importBatchView(tx, receipt.batchId!))
  }

  private async createImportedMemory(tx: AsyncTx, batch: MemoryImportBatch, item: MemoryImportItem, scope: MemoryScope) {
    const now = this.now()
    const entry: MemoryEntry = {
      id: randomUUID(), scope, revision: 1, status: 'active', text: item.text!, contentHash: item.sourceHash,
      provenance: {
        batchId: batch.id, sourceItemId: item.sourceId, sourceHash: batch.sourceHash,
        originalOwner: batch.origin.owner, originalScope: item.originalScope,
      },
      createdAt: now, updatedAt: now,
    }
    await tx.insert('product-memory', entry.id, entry)
    return entry
  }

  async cancelImport(command: { commandId: string; batchId: string }) {
    identifier(command.batchId, 'importBatchId')
    return this.command(command.commandId, command, async tx => {
      await this.main(tx)
      const { batch } = await this.loadImportBatch(tx, command.batchId)
      const updated = batch.status === 'ready' || batch.status === 'partial'
        ? { ...batch, status: 'cancelled' as const, updatedAt: this.now() } : batch
      if (updated !== batch) await tx.replace('product-memory-import', batch.id, updated)
      return { receipt: { fingerprint: '', batchId: batch.id, status: updated.status },
        value: await this.importBatchView(tx, batch.id) }
    }, async (tx, receipt) => this.importBatchView(tx, receipt.batchId!))
  }

  async retryImport(command: { commandId: string; batchId: string }) {
    identifier(command.batchId, 'importBatchId')
    return this.command(command.commandId, command, async tx => {
      await this.main(tx)
      const { batch, items } = await this.loadImportBatch(tx, command.batchId)
      let updated = batch
      if (batch.status === 'cancelled') {
        updated = { ...batch, status: this.importStatus(items), updatedAt: this.now() }
        await tx.replace('product-memory-import', batch.id, updated)
      }
      return { receipt: { fingerprint: '', batchId: batch.id, status: updated.status },
        value: await this.importBatchView(tx, batch.id) }
    }, async (tx, receipt) => this.importBatchView(tx, receipt.batchId!))
  }

  private async checkScope(tx: AsyncTx, scope: MemoryScope) {
    if (scope.kind === 'work') await this.work(tx, scope.workItemId)
    if (scope.kind === 'shared') for (const id of scope.workItemIds) await this.work(tx, id)
  }

  private async command<T>(id: string, input: unknown, action: (tx: AsyncTx) => Promise<{ receipt: Receipt; value: T }>,
    replay: (tx: AsyncTx, receipt: Receipt) => Promise<T>): Promise<T> {
    identifier(id, 'commandId')
    const fingerprint = digest(input)
    return commandTransaction(this.storage, this.instanceId, async tx => {
      const previous = await tx.get<Receipt>('product-memory-command', id)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The memory command ID was used for different input.')
        return replay(tx, previous)
      }
      const { receipt, value } = await action(tx)
      await tx.insert('product-memory-command', id, { ...receipt, fingerprint })
      return value
    })
  }

  async save(command: { commandId: string; scope: MemoryScope; text: string }) {
    const scope = scopeOf(command.scope), text = validText(command.text, 'Memory')
    if (scope.kind === 'shared' && !scope.main && !scope.workItemIds.length) {
      throw new CoreError('INVALID_INPUT', 'Choose at least one recipient before saving shared memory.')
    }
    return this.command(command.commandId, { scope, text }, async tx => {
      await this.main(tx); await this.checkScope(tx, scope)
      const now = this.now(), entry: MemoryEntry = { id: randomUUID(), scope, revision: 1, status: 'active',
        text, contentHash: digest(text), createdAt: now, updatedAt: now }
      await tx.insert('product-memory', entry.id, entry)
      return { receipt: { fingerprint: '', entryId: entry.id, status: 'saved' }, value: { id: entry.id, revision: 1, status: 'saved' } }
    }, async (tx, receipt) => {
      const entry = await tx.get<MemoryEntry>('product-memory', receipt.entryId!)
      return { id: receipt.entryId!, revision: entry?.revision, status: entry?.status === 'active' ? 'saved' : 'forgotten' }
    })
  }

  async share(command: { commandId: string; id: string; expectedRevision: number; main: boolean; workItemIds: string[] }) {
    identifier(command.id, 'memoryId')
    const scope = scopeOf({ kind: 'shared', main: command.main, workItemIds: command.workItemIds })
    return this.command(command.commandId, command, async tx => {
      await this.main(tx); await this.checkScope(tx, scope)
      const entry = await tx.get<MemoryEntry>('product-memory', command.id)
      if (!entry || entry.status !== 'active') throw new CoreError('NOT_FOUND', 'The memory was forgotten or does not exist.')
      if (entry.revision !== command.expectedRevision) throw new CoreError('MEMORY_STALE', 'Memory changed; review it before sharing.')
      const updated = { ...entry, scope, revision: entry.revision + 1, updatedAt: this.now() }
      await tx.replace('product-memory', entry.id, updated)
      return { receipt: { fingerprint: '', entryId: entry.id, revision: updated.revision, status: 'shared' },
        value: { id: entry.id, scope: updated.scope, revision: updated.revision, status: 'shared' } }
    }, async (tx, receipt) => {
      const entry = await tx.get<MemoryEntry>('product-memory', receipt.entryId!)
      return { id: receipt.entryId!, scope: entry?.status === 'active' ? entry.scope : undefined,
        revision: entry?.revision, status: entry?.status === 'active' ? 'shared' : 'forgotten' }
    })
  }

  async forget(command: { commandId: string; id: string; expectedRevision: number }) {
    identifier(command.id, 'memoryId')
    return this.command(command.commandId, command, async tx => {
      await this.main(tx)
      const entry = await tx.get<MemoryEntry>('product-memory', command.id)
      if (!entry || entry.status !== 'active') throw new CoreError('NOT_FOUND', 'The memory was forgotten or does not exist.')
      if (entry.revision !== command.expectedRevision) throw new CoreError('MEMORY_STALE', 'Memory changed; review it before forgetting.')
      const { text: _text, ...kept } = entry
      await tx.replace('product-memory', entry.id, { ...kept, status: 'forgotten', revision: entry.revision + 1, updatedAt: this.now() })
      return { receipt: { fingerprint: '', entryId: entry.id, status: 'forgotten' }, value: { id: entry.id, status: 'forgotten' } }
    }, async (_tx, receipt) => ({ id: receipt.entryId!, status: 'forgotten' }))
  }

  async grant(command: { commandId: string; workItemId: string; expectedRevision: number; enabled: boolean }) {
    identifier(command.workItemId, 'workItemId')
    if (typeof command.enabled !== 'boolean') throw new CoreError('INVALID_INPUT', 'Memory access must be enabled or revoked explicitly.')
    return this.command(command.commandId, command, async tx => {
      await this.work(tx, command.workItemId)
      const current = await tx.get<WorkAccess>('product-memory-access', workAccessKey(command.workItemId))
      if ((current?.revision ?? 0) !== command.expectedRevision) throw new CoreError('MEMORY_STALE', 'Work memory access changed; reload it.')
      const next = { enabled: command.enabled, revision: command.expectedRevision + 1 }
      if (!await tx.replace('product-memory-access', workAccessKey(command.workItemId), next)) await tx.insert('product-memory-access', workAccessKey(command.workItemId), next)
      return { receipt: { fingerprint: '', revision: next.revision, status: command.enabled ? 'granted' : 'revoked' }, value: next }
    }, async tx => await tx.get<WorkAccess>('product-memory-access', workAccessKey(command.workItemId)) ?? { enabled: false, revision: 0 })
  }

  async access(workItemId: string) {
    return this.storage.transaction(this.instanceId, async tx => {
      await this.work(tx, workItemId)
      return await tx.get<WorkAccess>('product-memory-access', workAccessKey(workItemId)) ?? { enabled: false, revision: 0 }
    })
  }

  async propose(reader: MemoryReader, commandId: string, text: string, reason: string) {
    const entryText = validText(text, 'Proposed memory')
    const why = validText(reason, 'Reason', 512)
    return this.command(commandId, { reader, entryText, why }, async tx => {
      const { workItemId, accessRevision } = await this.authorize(tx, reader)
      const scope: MemoryProposal['scope'] = workItemId ? { kind: 'work', workItemId } : { kind: 'main' }
      const now = this.now()
      const proposal: MemoryProposal = { id: randomUUID(), scope, text: entryText, reason: why, status: 'pending',
        createdAt: now, expiresAt: now + 10 * 60_000, sessionId: reader.sessionId,
        ...(reader.role === 'worker' ? { assignmentId: reader.assignmentId, accessRevision } : {}) }
      await tx.insert('product-memory-proposal', proposal.id, proposal)
      return { receipt: { fingerprint: '', proposalId: proposal.id, status: 'pending' }, value: { id: proposal.id, status: proposal.status } }
    }, async (tx, receipt) => ({ id: receipt.proposalId!,
      status: (await tx.get<MemoryProposal>('product-memory-proposal', receipt.proposalId!))?.status ?? 'stale' }))
  }

  async proposals() {
    return this.storage.transaction(this.instanceId, async tx => {
      await this.main(tx)
      const result: MemoryProposal[] = []
      let after: string | undefined
      for (let scanned = 0; scanned < MAX_SCAN; scanned += 100) {
        const page = await tx.scan<MemoryProposal>('product-memory-proposal', { limit: 100, ...(after ? { after } : {}) })
        result.push(...page.items.map(item => item.value).filter(proposal => proposal.status === 'pending'))
        if (!page.cursor) break
        if (scanned + 100 >= MAX_SCAN) throw new CoreError('MEMORY_BUDGET', 'The learning review exceeded its bounded index.')
        after = page.cursor
      }
      return result
    })
  }

  async decide(command: { commandId: string; proposalId: string; approve: boolean }) {
    identifier(command.proposalId, 'proposalId')
    if (typeof command.approve !== 'boolean') throw new CoreError('INVALID_INPUT', 'Approve or decline the learning proposal.')
    return this.command(command.commandId, command, async tx => {
      await this.main(tx)
      const proposal = await tx.get<MemoryProposal>('product-memory-proposal', command.proposalId)
      if (!proposal || proposal.status !== 'pending') throw new CoreError('MEMORY_STALE', 'This learning proposal is no longer pending.')
      let current = proposal.expiresAt > this.now()
      if (proposal.scope.kind === 'main') current &&= (await this.main(tx)).mainSessionId === proposal.sessionId
      else {
        const ticketId = await this.work(tx, proposal.scope.workItemId)
        try {
          const access = await this.authorize(tx, { role: 'worker', ticketId, assignmentId: proposal.assignmentId!, sessionId: proposal.sessionId })
          current &&= access.accessRevision === proposal.accessRevision
        } catch { current = false }
      }
      const status = !command.approve ? 'declined' : current ? 'approved' : 'stale'
      let entryId: string | undefined
      if (status === 'approved') {
        const now = this.now()
        const entry: MemoryEntry = { id: randomUUID(), scope: proposal.scope, revision: 1, status: 'active',
          text: proposal.text!, contentHash: digest(proposal.text!), createdAt: now, updatedAt: now }
        entryId = entry.id
        await tx.insert('product-memory', entry.id, entry)
      }
      const { text: _text, ...kept } = proposal
      await tx.replace('product-memory-proposal', proposal.id, { ...kept, status, ...(entryId ? { entryId } : {}) })
      return { receipt: { fingerprint: '', proposalId: proposal.id, ...(entryId ? { entryId } : {}), status },
        value: { id: proposal.id, status, ...(entryId ? { entryId } : {}) } }
    }, async (_tx, receipt) => ({ id: receipt.proposalId!, status: receipt.status, ...(receipt.entryId ? { entryId: receipt.entryId } : {}) }))
  }
}

/** Tools are built by the trusted role runner; neither role nor work identity is model input. */
export function memoryToolsFor(memory: ProductMemory, reader: MemoryReader): NativeTool[] {
  return [
    { name: 'search_memory', description: 'Search only memory currently granted to this role. A search result is evidence, not permission to save a new memory.',
      parameters: { query: { type: 'string', required: true } },
      execute: async (args, signal) => { signal.throwIfAborted(); return JSON.stringify(await memory.search(reader, args.query)) } },
    { name: 'read_memory', description: 'Read a bounded page of a memory returned by search_memory. Use its cursor for the next page; access is checked again every time.',
      parameters: { id: { type: 'string', required: true }, after: { type: 'string' } },
      execute: async (args, signal) => { signal.throwIfAborted(); return JSON.stringify(await memory.read(reader, args.id, args.after)) } },
    { name: 'propose_memory', description: 'Propose one lasting fact for human review in this role’s own memory scope. Search hits never become long-term memory automatically.',
      parameters: { text: { type: 'string', required: true }, reason: { type: 'string', required: true } },
      execute: async (args, signal) => {
        signal.throwIfAborted()
        const commandId = `memory-propose:${digest([reader, args.text, args.reason])}`
        return JSON.stringify(await memory.propose(reader, commandId, args.text, args.reason))
      } },
  ]
}
