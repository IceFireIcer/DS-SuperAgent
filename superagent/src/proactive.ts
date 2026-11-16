import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CoreError, identifier } from './model.js'
import type { AsyncTx, Storage } from './storage.js'
import { isCurrentSourceEvent, type SourceEvent } from './source-events.js'

export type ProactiveMode = 'observe' | 'auto'
export interface ProactiveMatch {
  actorKinds: ('human' | 'bot' | 'ci' | 'system')[]
  addressing: ('direct' | 'mention' | 'ambient')[]
  textPattern?: string
  sourceInstanceIds?: string[]
}
export interface ProactiveBudget { maxRuns: number; windowMs: number; maxArtifactBytes?: number }
export interface ProactiveRule {
  id: string
  name: string
  mode: ProactiveMode
  match: ProactiveMatch
  communication: 'silent' | 'notify'
  budget: ProactiveBudget
  scope?: string
  enabled: boolean
}
export interface ProactiveCandidate {
  sourceInstanceId: string
  eventId: string
  threadId: string
  objectId: string
  text: string
  authorId: string
  authorKind: 'human' | 'bot' | 'ci' | 'system'
  addressing: 'direct' | 'mention' | 'ambient'
}
export interface ProactiveArtifact { path: string; bytes: number; sha256: string }
export interface ProactivePreparation {
  summary: string
  evidence?: string
  modelSteps?: number
  artifacts?: ProactiveArtifact[]
}
export interface ProactiveBudgetSnapshot {
  maxRuns: number
  windowMs: number
  usedRuns: number
  remainingRuns: number
  maxArtifactBytes?: number
}
export interface ProactiveRun {
  id: string
  instanceId: string
  ruleId: string
  ruleRevision: number
  controlRevision?: number
  processingRevision?: number
  eventId: string
  sourceInstanceId: string
  threadId?: string
  objectId?: string
  mode: ProactiveMode
  state: 'running' | 'observed' | 'prepared' | 'silent' | 'suppressed' | 'budget-exhausted' | 'failed' | 'stopped'
  text: string
  authorId: string
  authorKind: ProactiveCandidate['authorKind']
  addressing: ProactiveCandidate['addressing']
  communication: ProactiveRule['communication']
  isolatedDirectory?: string
  summary?: string
  evidence?: string
  modelSteps?: number
  artifacts?: ProactiveArtifact[]
  budgetSnapshot?: ProactiveBudgetSnapshot
  reason?: string
  createdAt: number
}
interface StoredRules { revision: number; rules: ProactiveRule[]; updatedAt: number }
interface PendingCandidate { id: string; candidate: ProactiveCandidate; ruleRevision: number; controlRevision: number }
export interface ProactiveOptions {
  rootDirectory: string
  prepare?: (request: { runId: string; ruleRevision: number; rule: ProactiveRule; candidate: ProactiveCandidate; isolatedDirectory: string; remainingRuns: number }, signal: AbortSignal) => Promise<ProactivePreparation | undefined>
  prepareTimeoutMs?: number
  now?: () => number
  /** Recheck source ownership and durable controls inside the reservation and settlement transactions. */
  guard?: (tx: AsyncTx, candidate: ProactiveCandidate) => Promise<string | undefined>
  pauseSourceInstanceId?: string
  /** Commit a routing intent with the verified preparation, never with an unverified model response. */
  onPrepared?: (tx: AsyncTx, run: ProactiveRun) => Promise<void>
  route?: (runId: string, signal: AbortSignal) => Promise<void>
  sourceAvailable?: (sourceInstanceId: string, sourceActorId: string) => boolean
  authorizeWork?: (tx: AsyncTx, run: ProactiveRun, event: SourceEvent) => Promise<void>
  onSourceChanged?: (sourceInstanceId: string) => void
}
const ruleKey = 'proactive-rules'
const controlKey = 'proactive-control'
const noticeKey = 'recent'
const pendingPrefix = (sourceId: string) => `${JSON.stringify(['proactive-candidate', sourceId])}:`
const runPrefix = (ruleId: string) => `${JSON.stringify(['proactive-run', ruleId])}:`
const historyKey = (revision: number) => `${JSON.stringify(['proactive-rule-history'])}:${String(revision).padStart(10, '0')}`
const metric = (value: string) => createHash('sha256').update(value).digest('hex')

function validateRule(rule: ProactiveRule) {
  if (!rule || Object.keys(rule).some(key => !['id', 'name', 'mode', 'match', 'communication', 'budget', 'scope', 'enabled'].includes(key))) {
    throw new CoreError('INVALID_CONFIG', 'A proactive rule accepts id, name, mode, match, communication, budget, scope and enabled only.')
  }
  identifier(rule.id, 'proactive rule id')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(rule.id)) throw new CoreError('INVALID_CONFIG', 'A proactive rule ID must be a lowercase slug used as a directory name.')
  if (typeof rule.name !== 'string' || !rule.name.trim() || Buffer.byteLength(rule.name) > 128) throw new CoreError('INVALID_CONFIG', 'A proactive rule needs a bounded name.')
  if (rule.mode !== 'observe' && rule.mode !== 'auto') throw new CoreError('INVALID_CONFIG', 'A proactive rule mode is observe or auto.')
  if (!rule.match || Object.keys(rule.match).some(key => !['actorKinds', 'addressing', 'textPattern', 'sourceInstanceIds'].includes(key))) throw new CoreError('INVALID_CONFIG', 'A proactive match accepts actor kinds, addressing, text pattern and source instances only.')
  if (rule.match.sourceInstanceIds !== undefined && (!Array.isArray(rule.match.sourceInstanceIds) || !rule.match.sourceInstanceIds.length
    || rule.match.sourceInstanceIds.length > 20 || new Set(rule.match.sourceInstanceIds).size !== rule.match.sourceInstanceIds.length)) {
    throw new CoreError('INVALID_CONFIG', 'A proactive match needs distinct, bounded source instances.')
  }
  for (const source of rule.match.sourceInstanceIds ?? []) identifier(source, 'proactive source instance')
  if (!Array.isArray(rule.match.actorKinds) || !rule.match.actorKinds.length || rule.match.actorKinds.some(kind => !['human', 'bot', 'ci', 'system'].includes(kind))) throw new CoreError('INVALID_CONFIG', 'A proactive match needs supported actor kinds.')
  if (!Array.isArray(rule.match.addressing) || !rule.match.addressing.length || rule.match.addressing.some(kind => !['direct', 'mention', 'ambient'].includes(kind))) throw new CoreError('INVALID_CONFIG', 'A proactive match needs supported addressing kinds.')
  if (rule.match.textPattern !== undefined) {
    if (typeof rule.match.textPattern !== 'string' || !rule.match.textPattern || Buffer.byteLength(rule.match.textPattern) > 512) throw new CoreError('INVALID_CONFIG', 'A proactive text pattern must be bounded.')
    try { new RegExp(rule.match.textPattern, 'iu') } catch { throw new CoreError('INVALID_CONFIG', 'The proactive text pattern is not a valid regular expression.') }
  }
  if (rule.communication !== 'silent' && rule.communication !== 'notify') throw new CoreError('INVALID_CONFIG', 'A proactive rule communicates silently or with a notify.')
  if (rule.scope !== undefined && (typeof rule.scope !== 'string' || !rule.scope.trim() || Buffer.byteLength(rule.scope) > 4096)) {
    throw new CoreError('INVALID_CONFIG', 'A proactive scope must be bounded text.')
  }
  if (!rule.budget || Object.keys(rule.budget).some(key => !['maxRuns', 'windowMs', 'maxArtifactBytes'].includes(key))
    || !Number.isInteger(rule.budget.maxRuns) || rule.budget.maxRuns < 1 || rule.budget.maxRuns > 100
    || !Number.isInteger(rule.budget.windowMs) || rule.budget.windowMs < 1000 || rule.budget.windowMs > 30 * 86400000) {
    throw new CoreError('INVALID_CONFIG', 'A proactive budget needs 1–100 runs within a 1 s–30 day window.')
  }
  if (rule.budget.maxArtifactBytes !== undefined && (!Number.isInteger(rule.budget.maxArtifactBytes)
    || rule.budget.maxArtifactBytes < 1024 || rule.budget.maxArtifactBytes > 10 * 1024 * 1024)) {
    throw new CoreError('INVALID_CONFIG', 'A proactive artifact budget must be 1 KB–10 MB.')
  }
  if (typeof rule.enabled !== 'boolean') throw new CoreError('INVALID_CONFIG', 'A proactive rule enabled flag must be boolean.')
}

export class Proactive {
  private readonly prepare: ProactiveOptions['prepare']
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly rootDirectory: string
  private readonly guard: ProactiveOptions['guard']
  private readonly onPrepared: ProactiveOptions['onPrepared']
  private readonly authorizeWork: ProactiveOptions['authorizeWork']
  private readonly pauseSourceInstanceId: string | undefined
  private readonly controllers = new Map<string, AbortController>()
  constructor(private readonly storage: Storage, private readonly instanceId: string, options: ProactiveOptions) {
    if (!options?.rootDirectory || !isAbsolute(options.rootDirectory)) throw new CoreError('INVALID_CONFIG', 'A proactive root directory must be explicit and absolute.')
    this.rootDirectory = options.rootDirectory
    this.prepare = options.prepare
    this.guard = options.guard
    this.onPrepared = options.onPrepared
    this.authorizeWork = options.authorizeWork
    this.pauseSourceInstanceId = options.pauseSourceInstanceId
    this.timeoutMs = options.prepareTimeoutMs ?? 10000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60000) throw new CoreError('INVALID_CONFIG', 'The proactive preparation timeout must be 100–60000 ms.')
    this.now = options.now ?? Date.now
  }

  async rules(): Promise<{ revision: number; rules: ProactiveRule[] }> {
    const stored = await this.storage.transaction(this.instanceId, tx => tx.get<StoredRules>('proactive-rule', ruleKey))
    return stored ? { revision: stored.revision, rules: stored.rules } : { revision: 1, rules: [] }
  }

  async control(): Promise<{ paused: boolean; revision: number }> {
    return await this.storage.transaction(this.instanceId, tx => tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey))
      ?? { paused: false, revision: 1 }
  }

  async enqueue(tx: AsyncTx, candidate: ProactiveCandidate) {
    const rules = await tx.get<StoredRules>('proactive-rule', ruleKey)
    const control = await tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey)
    if (!rules || control?.paused || this.pauseSourceInstanceId && (await tx.get<{ paused: boolean }>('processing-state',
      JSON.stringify(['processing-state', this.pauseSourceInstanceId])))?.paused) return
    if (!rules.rules.some(rule => rule.enabled && (!rule.match.sourceInstanceIds || rule.match.sourceInstanceIds.includes(candidate.sourceInstanceId))
      && rule.match.actorKinds.includes(candidate.authorKind) && rule.match.addressing.includes(candidate.addressing))) return
    const id = `${pendingPrefix(candidate.sourceInstanceId)}${metric(candidate.eventId)}`
    if (!await tx.get('proactive-candidate', id)) await tx.insert('proactive-candidate', id, {
      id, candidate, ruleRevision: rules.revision, controlRevision: control?.revision ?? 1 } satisfies PendingCandidate)
  }

  async pending(sourceInstanceId: string, limit = 25): Promise<PendingCandidate[]> {
    const prefix = pendingPrefix(sourceInstanceId)
    return this.storage.transaction(this.instanceId, async tx => {
      const page = await tx.scan<PendingCandidate>('proactive-candidate', { limit, after: prefix })
      return page.items.filter(item => item.id.startsWith(prefix)).map(item => item.value)
    })
  }

  async completePending(id: string) {
    return this.storage.transaction(this.instanceId, tx => tx.remove('proactive-candidate', id))
  }

  async discardPending(sourceInstanceId: string) {
    const prefix = pendingPrefix(sourceInstanceId)
    return this.storage.transaction(this.instanceId, async tx => {
      let cursor = prefix
      for (;;) {
        const page = await tx.scan('proactive-candidate', { limit: 100, after: cursor })
        const items = page.items.filter(item => item.id.startsWith(prefix))
        for (const item of items) await tx.remove('proactive-candidate', item.id)
        if (!page.cursor || !page.cursor.startsWith(prefix)) return
        cursor = page.cursor
      }
    })
  }

  async setPaused(command: { commandId: string; paused: boolean }) {
    identifier(command?.commandId, 'commandId')
    if (typeof command.paused !== 'boolean') throw new CoreError('INVALID_INPUT', 'A proactive pause needs a boolean value.')
    const fingerprint = metric(JSON.stringify(['proactive-pause-v1', command.paused]))
    const control = await this.storage.transaction(this.instanceId, async tx => {
      const key = `proactive-pause:${command.commandId}`
      const prior = await tx.get<{ fingerprint: string; control: { paused: boolean; revision: number } }>('work-command', key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The pause command changed its value.')
        return prior.control
      }
      const current = await tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey)
      const next = { paused: command.paused, revision: (current?.revision ?? 1) + 1 }
      if (!await tx.replace('proactive-control', controlKey, next)) await tx.insert('proactive-control', controlKey, next)
      if (command.paused) for (const run of await this.scanRuns(tx, `${JSON.stringify(['proactive-run']).slice(0, -1)},`)) {
        if (run.state === 'running') await tx.replace('proactive-run', run.id, { ...run, state: 'suppressed', reason: 'PROACTIVE_PAUSED' })
      }
      await tx.insert('work-command', key, { fingerprint, control: next })
      return next
    })
    if (control.paused) for (const controller of this.controllers.values()) controller.abort()
    return control
  }

  async setRules(transaction: AsyncTx, expectedRevision: number, rules: ProactiveRule[]): Promise<{ revision: number; rules: ProactiveRule[] }> {
    if (!Array.isArray(rules) || rules.length > 50) throw new CoreError('INVALID_CONFIG', 'At most fifty proactive rules are supported.')
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new CoreError('INVALID_CONFIG', 'Proactive rule IDs must be unique.')
    for (const rule of rules) validateRule(rule)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new CoreError('INVALID_CONFIG', 'A positive proactive rule revision is required.')
    const current = await transaction.get<StoredRules>('proactive-rule', ruleKey)
    if ((current?.revision ?? 1) !== expectedRevision) throw new CoreError('CONFIG_REVISION_CONFLICT', 'The proactive rules changed after this update was prepared.')
    const next: StoredRules = { revision: (current?.revision ?? 1) + 1, rules: structuredClone(rules), updatedAt: this.now() }
    for (const run of await this.scanRuns(transaction, `${JSON.stringify(['proactive-run']).slice(0, -1)},`)) {
      if (run.state === 'running' || run.state === 'prepared') {
        await transaction.replace('proactive-run', run.id, { ...run, state: 'suppressed', reason: 'RULE_CHANGED' })
      }
    }
    if (!await transaction.replace('proactive-rule', ruleKey, next)) await transaction.insert('proactive-rule', ruleKey, next)
    await transaction.insert('proactive-rule-history', historyKey(next.revision), next)
    return { revision: next.revision, rules: next.rules }
  }

  async evaluate(candidate: ProactiveCandidate, revisionOverride?: number, controlRevision?: number): Promise<ProactiveRun[]> {
    if (typeof candidate.authorId !== 'string' || !candidate.authorId) throw new CoreError('INVALID_INPUT', 'A proactive candidate needs an author ID.')
    const configured = await this.rules()
    if (revisionOverride !== undefined && revisionOverride !== configured.revision) return []
    if (controlRevision !== undefined && controlRevision !== (await this.control()).revision) return []
    const revision = revisionOverride ?? configured.revision
    const runs: ProactiveRun[] = []
    for (const rule of configured.rules) {
      if (!rule.enabled) continue
      if (rule.match.sourceInstanceIds && !rule.match.sourceInstanceIds.includes(candidate.sourceInstanceId)) continue
      if (!rule.match.actorKinds.includes(candidate.authorKind)) continue
      if (!rule.match.addressing.includes(candidate.addressing)) continue
      if (rule.match.textPattern && !new RegExp(rule.match.textPattern, 'iu').test(candidate.text)) continue
      const reserved = await this.storage.transaction(this.instanceId, async tx => {
        const ambient = candidate.addressing === 'ambient'
        const echo = ambient || await this.isEcho(tx, rule, candidate)
        const id = echo ? `${runPrefix(rule.id)}echo:${metric(candidate.text)}` : `${runPrefix(rule.id)}${metric(candidate.eventId)}`
        const replay = await tx.get<ProactiveRun>('proactive-run', id)
        if (replay) return { replay }
        const control = await tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey)
        const processing = this.pauseSourceInstanceId ? await tx.get<{ paused: boolean; revision: number }>('processing-state',
          JSON.stringify(['processing-state', this.pauseSourceInstanceId])) : undefined
        const base = { id, instanceId: this.instanceId, ruleId: rule.id, ruleRevision: revision, eventId: candidate.eventId,
          sourceInstanceId: candidate.sourceInstanceId, threadId: candidate.threadId, objectId: candidate.objectId,
          mode: rule.mode, text: candidate.text.slice(0, 4096), authorId: candidate.authorId,
          authorKind: candidate.authorKind, addressing: candidate.addressing, communication: rule.communication,
          controlRevision: control?.revision ?? 1, processingRevision: processing?.revision ?? 0, createdAt: this.now() }
        const blocked = control?.paused || processing?.paused ? 'PROCESSING_PAUSED'
          : controlRevision !== undefined && controlRevision !== base.controlRevision ? 'PROACTIVE_PAUSED'
          : (await tx.get<StoredRules>('proactive-rule', ruleKey))?.revision !== configured.revision
          ? 'RULE_CHANGED' : await this.guard?.(tx, candidate)
        if (blocked) return { run: await this.insert(tx, { ...base, state: 'suppressed', reason: blocked }) }
        if (rule.mode === 'observe') return { run: await this.insert(tx, { ...base, state: 'observed' }) }
        if (echo) return { run: await this.insertOrReplace(tx, { ...base, state: 'suppressed', reason: ambient ? 'AMBIENT' : 'REPEATED_ECHO' }) }
        const used = await this.countRuns(tx, rule.id, rule.budget.windowMs)
        if (used >= rule.budget.maxRuns) {
          return { run: await this.insert(tx, { ...base, state: 'budget-exhausted',
            budgetSnapshot: { maxRuns: rule.budget.maxRuns, windowMs: rule.budget.windowMs, usedRuns: used, remainingRuns: 0,
              ...(rule.budget.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: rule.budget.maxArtifactBytes }) },
            reason: `${used}/${rule.budget.maxRuns} runs used in the declared window.` }) }
        }
        return { run: await this.insert(tx, { ...base, state: 'running', isolatedDirectory: this.isolatedDirectory(rule, candidate.eventId),
          budgetSnapshot: { maxRuns: rule.budget.maxRuns, windowMs: rule.budget.windowMs, usedRuns: used + 1,
            remainingRuns: rule.budget.maxRuns - used - 1,
            ...(rule.budget.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: rule.budget.maxArtifactBytes }) } }),
          remaining: rule.budget.maxRuns - used }
      })
      if ('replay' in reserved) { runs.push(reserved.replay!); continue }
      if (reserved.run!.state !== 'running') { runs.push(reserved.run!); continue }
      const base = reserved.run!
      let final: ProactiveRun
      const controller = new AbortController()
      this.controllers.set(base.id, controller)
      if (!this.prepare) final = { ...base, state: 'silent', reason: 'NO_PREPARATION_ADAPTER' }
      else {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await mkdir(base.isolatedDirectory!, { recursive: true })
          const prepared = await Promise.race([
            this.prepare({ runId: base.id, ruleRevision: revision, rule, candidate, isolatedDirectory: base.isolatedDirectory!, remainingRuns: reserved.remaining! }, controller.signal),
            new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined) }, this.timeoutMs) }),
          ])
          if (!prepared?.summary?.trim()) final = { ...base, state: 'silent', reason: controller.signal.aborted ? 'PREPARATION_TIMED_OUT' : 'NO_USEFUL_RESULT' }
          else {
            const artifacts = prepared.artifacts ? await this.verifyArtifacts(base.isolatedDirectory!, prepared.artifacts,
              rule.budget.maxArtifactBytes ?? 5 * 1024 * 1024) : undefined
            if (prepared.evidence !== undefined && (typeof prepared.evidence !== 'string' || Buffer.byteLength(prepared.evidence) > 4096)
              || prepared.modelSteps !== undefined && (!Number.isInteger(prepared.modelSteps) || prepared.modelSteps < 0 || prepared.modelSteps > 100)) {
              throw new CoreError('INVALID_INPUT', 'Preparation evidence and model steps must be bounded.')
            }
            final = { ...base, state: 'prepared', summary: prepared.summary.slice(0, 4096),
              ...(prepared.evidence ? { evidence: prepared.evidence } : {}),
              ...(prepared.modelSteps === undefined ? {} : { modelSteps: prepared.modelSteps }), ...(artifacts ? { artifacts } : {}) }
          }
        } catch (error) {
          final = { ...base, state: 'failed', reason: error instanceof CoreError ? error.code : 'PREPARATION_FAILED' }
        } finally { if (timer) clearTimeout(timer) }
      }
      this.controllers.delete(base.id)
      const settled = await this.storage.transaction(this.instanceId, async tx => {
        const current = await tx.get<ProactiveRun>('proactive-run', base.id)
        if (!current || current.state !== 'running') return current ?? final
        const changed = (await tx.get<StoredRules>('proactive-rule', ruleKey))?.revision !== base.ruleRevision
        const control = await tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey)
        const processing = this.pauseSourceInstanceId ? await tx.get<{ paused: boolean; revision: number }>('processing-state',
          JSON.stringify(['processing-state', this.pauseSourceInstanceId])) : undefined
        const blocked = control?.paused || processing?.paused ? 'PROCESSING_PAUSED'
          : (control?.revision ?? 1) !== base.controlRevision || (processing?.revision ?? 0) !== base.processingRevision
            ? 'CONTROL_CHANGED' : changed ? 'RULE_CHANGED' : await this.guard?.(tx, candidate)
        const result = await this.insertOrReplace(tx, blocked ? { ...base, state: 'suppressed', reason: blocked } : final)
        if (result.state === 'prepared') await this.onPrepared?.(tx, result)
        if (result.state === 'prepared' && result.communication === 'notify') {
          const previous = await tx.get<string[]>('proactive-notice', noticeKey) ?? []
          const ids = [result.id, ...previous.filter(id => id !== result.id)].slice(0, 10)
          if (!await tx.replace('proactive-notice', noticeKey, ids)) await tx.insert('proactive-notice', noticeKey, ids)
        }
        return result
      })
      runs.push(settled)
    }
    return runs
  }

  /** Only a repeated bot/CI message is an echo; a new bot candidate may still be prepared by its rule. */
  private async isEcho(tx: AsyncTx, rule: ProactiveRule, candidate: ProactiveCandidate) {
    if (candidate.authorKind !== 'bot' && candidate.authorKind !== 'ci') return false
    const since = this.now() - rule.budget.windowMs
    return (await this.listRunsIn(tx, rule.id, since)).some(run => run.text === candidate.text)
  }

  private isolatedDirectory(rule: ProactiveRule, eventId: string) {
    const directory = join(this.rootDirectory, rule.id, metric(eventId))
    const inside = relative(resolve(this.rootDirectory), resolve(directory))
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
      throw new CoreError('INVALID_CONFIG', 'A proactive rule directory escapes its root.')
    }
    return directory
  }

  async listRuns(ruleId?: string): Promise<ProactiveRun[]> {
    const prefix = ruleId ? runPrefix(ruleId) : `${JSON.stringify(['proactive-run']).slice(0, -1)},`
    return this.storage.transaction(this.instanceId, async tx =>
      (await this.scanRuns(tx, prefix)).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)))
  }

  async getRun(id: string): Promise<ProactiveRun | undefined> {
    identifier(id, 'proactive run ID')
    return this.storage.transaction(this.instanceId, tx => tx.get<ProactiveRun>('proactive-run', id))
  }

  async assertPreparedIn(tx: AsyncTx, runId: string): Promise<{ run: ProactiveRun; rule: ProactiveRule; event: SourceEvent }> {
    const run = await tx.get<ProactiveRun>('proactive-run', runId)
    const rules = await tx.get<StoredRules>('proactive-rule', ruleKey)
    const rule = rules?.rules.find(item => item.id === run?.ruleId)
    if (!run || run.instanceId !== this.instanceId || run.mode !== 'auto' || run.state !== 'prepared'
      || !run.isolatedDirectory || !rule?.enabled || rule.mode !== 'auto' || rules?.revision !== run.ruleRevision
      || !rule.match.sourceInstanceIds?.includes(run.sourceInstanceId)) {
      throw new CoreError('PROACTIVE_REVOKED', 'The preparation no longer has an active exact-source auto rule.')
    }
    const control = await tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey)
    const processing = this.pauseSourceInstanceId ? await tx.get<{ paused: boolean; revision: number }>('processing-state',
      JSON.stringify(['processing-state', this.pauseSourceInstanceId])) : undefined
    if (control?.paused || (control?.revision ?? 1) !== run.controlRevision || processing?.paused
      || (processing?.revision ?? 0) !== run.processingRevision) {
      throw new CoreError('PROACTIVE_PAUSED', 'The preparation control changed or processing is paused.')
    }
    const event = await tx.get<SourceEvent>('source-event', run.eventId)
    if (!event || !await isCurrentSourceEvent(tx, event) || event.versionVerified === false
      || event.source.sourceInstanceId !== run.sourceInstanceId || event.authorId !== run.authorId
      || event.authorKind !== run.authorKind || event.addressing !== run.addressing
      || event.threadId !== run.threadId || event.objectId !== run.objectId
      || event.text?.slice(0, 4096) !== run.text) {
      throw new CoreError('SOURCE_NOT_CURRENT', 'The preparation source event is no longer current and verified.')
    }
    await this.authorizeWork?.(tx, run, event)
    return { run, rule, event }
  }

  async recentNotices(): Promise<ProactiveRun[]> {
    return this.storage.transaction(this.instanceId, async tx => {
      const ids = await tx.get<string[]>('proactive-notice', noticeKey) ?? []
      const runs = await Promise.all(ids.map(id => tx.get<ProactiveRun>('proactive-run', id)))
      return runs.filter((run): run is ProactiveRun => run?.state === 'prepared' && run.communication === 'notify')
    })
  }

  async readArtifact(runId: string, path: string, offset = 0, maxBytes = 8192) {
    const run = await this.getRun(runId)
    const artifact = run?.artifacts?.find(item => item.path === path)
    if (!artifact || !run?.isolatedDirectory || !['prepared', 'suppressed', 'stopped'].includes(run.state)) {
      throw new CoreError('NOT_FOUND', 'This preparation has no verified artifact at that path.')
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.bytes || !Number.isInteger(maxBytes)
      || maxBytes < 1 || maxBytes > 8192) throw new CoreError('INVALID_INPUT', 'Use a bounded artifact page.')
    const base = await realpath(run.isolatedDirectory)
    const target = await realpath(resolve(base, path))
    const inside = relative(base, target)
    if (inside !== path.split('/').join(sep) || !inside || inside.startsWith('..') || isAbsolute(inside)) {
      throw new CoreError('ARTIFACT_UNVERIFIED', 'The artifact is no longer inside its preparation directory.')
    }
    const info = await stat(target)
    if (!info.isFile() || info.size !== artifact.bytes) {
      throw new CoreError('ARTIFACT_UNVERIFIED', 'The artifact changed since it was prepared.')
    }
    const bytes = await readFile(target)
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new CoreError('ARTIFACT_UNVERIFIED', 'The artifact changed since it was prepared.')
    }
    const next = Math.min(offset + maxBytes, bytes.length)
    return { runId, path, text: bytes.subarray(offset, next).toString('utf8'), nextOffset: next,
      hasMore: next < bytes.length, bytes: artifact.bytes, sha256: artifact.sha256 }
  }

  async recoverInterrupted(): Promise<number> {
    return this.storage.transaction(this.instanceId, async tx => {
      let recovered = 0
      for (const run of await this.scanRuns(tx, `${JSON.stringify(['proactive-run']).slice(0, -1)},`)) {
        if (run.state !== 'running') continue
        await tx.replace('proactive-run', run.id, { ...run, state: 'failed', reason: 'HOST_RESTART' })
        recovered++
      }
      return recovered
    })
  }

  abortActive() { for (const controller of this.controllers.values()) controller.abort() }

  async stop(command: { commandId: string; runId: string; reason: string }): Promise<ProactiveRun> {
    identifier(command?.commandId, 'commandId'); identifier(command?.runId, 'proactive run ID')
    if (typeof command.reason !== 'string' || !command.reason.trim() || Buffer.byteLength(command.reason) > 2048) {
      throw new CoreError('INVALID_INPUT', 'Stopping a preparation needs a bounded reason.')
    }
    const key = `proactive-stop:${command.commandId}`
    const fingerprint = metric(JSON.stringify([command.runId, command.reason]))
    const run = await this.storage.transaction(this.instanceId, async tx => {
      const prior = await tx.get<{ fingerprint: string; runId: string }>('work-command', key)
      if (prior?.fingerprint !== undefined && prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The stop command changed its target.')
      const current = await tx.get<ProactiveRun>('proactive-run', prior?.runId ?? command.runId)
      if (!current) throw new CoreError('NOT_FOUND', 'The preparation does not exist.')
      if (!prior) await tx.insert('work-command', key, { fingerprint, runId: command.runId })
      if (current.state !== 'running' && current.state !== 'prepared') return current
      const stopped: ProactiveRun = { ...current, state: 'stopped', reason: command.reason }
      await tx.replace('proactive-run', current.id, stopped)
      return stopped
    })
    this.controllers.get(run.id)?.abort()
    return run
  }

  async assertCurrent(candidate: ProactiveCandidate, ruleRevision: number, runId: string) {
    const blocked = await this.storage.transaction(this.instanceId, async tx => {
      const run = await tx.get<ProactiveRun>('proactive-run', runId)
      if (run?.state !== 'running') return 'PREPARATION_STOPPED'
      if ((await tx.get<StoredRules>('proactive-rule', ruleKey))?.revision !== ruleRevision) return 'RULE_CHANGED'
      const control = await tx.get<{ paused: boolean; revision: number }>('proactive-control', controlKey)
      if (control?.paused || (control?.revision ?? 1) !== run.controlRevision) return 'PROACTIVE_PAUSED'
      if (this.pauseSourceInstanceId) {
        const processing = await tx.get<{ paused: boolean; revision: number }>('processing-state',
          JSON.stringify(['processing-state', this.pauseSourceInstanceId]))
        if (processing?.paused || (processing?.revision ?? 0) !== run.processingRevision) return 'PROCESSING_PAUSED'
      }
      return this.guard?.(tx, candidate)
    })
    if (blocked) throw new CoreError(blocked, 'This preparation no longer has a current authorization.')
  }

  private async verifyArtifacts(directory: string, artifacts: ProactiveArtifact[], maxBytes: number) {
    if (!Array.isArray(artifacts) || artifacts.length > 20) throw new CoreError('ARTIFACT_UNVERIFIED', 'A preparation reports at most 20 artifacts.')
    // Resolve symlinks before comparing so an artifact cannot point outside the isolated directory.
    const base = await realpath(directory)
    const verified: ProactiveArtifact[] = []
    let total = 0
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || !artifact.path.trim() || Buffer.byteLength(artifact.path) > 1024
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
        || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
        throw new CoreError('ARTIFACT_UNVERIFIED', 'A preparation reported an invalid artifact descriptor.')
      }
      let target: string, info: Awaited<ReturnType<typeof stat>>
      try {
        target = await realpath(resolve(directory, artifact.path))
        info = await stat(target)
      } catch {
        throw new CoreError('ARTIFACT_UNVERIFIED', 'An artifact does not exist inside the isolated directory.')
      }
      const inside = relative(base, target)
      if (!inside || inside.startsWith('..') || isAbsolute(inside) || !info.isFile()) {
        throw new CoreError('ARTIFACT_UNVERIFIED', 'An artifact escapes the isolated directory.')
      }
      if (info.size !== artifact.bytes) throw new CoreError('ARTIFACT_UNVERIFIED', 'An artifact size does not match its descriptor.')
      const digest = createHash('sha256').update(await readFile(target)).digest('hex')
      if (digest !== artifact.sha256) throw new CoreError('ARTIFACT_UNVERIFIED', 'An artifact digest does not match its descriptor.')
      total += artifact.bytes
      if (total > maxBytes) throw new CoreError('ARTIFACT_BUDGET', 'The prepared artifacts exceed the declared byte budget.')
      verified.push({ path: inside.split(sep).join('/'), bytes: artifact.bytes, sha256: artifact.sha256 })
    }
    return verified
  }

  private async countRuns(tx: AsyncTx, ruleId: string, windowMs: number) {
    const since = this.now() - windowMs
    return (await this.listRunsIn(tx, ruleId, since)).filter(run => Boolean(run.isolatedDirectory)
      || ['running', 'prepared', 'silent', 'failed'].includes(run.state)).length
  }

  private async scanRuns(tx: AsyncTx, prefix: string, since?: number) {
    const items: ProactiveRun[] = []
    let cursor = prefix
    for (;;) {
      const page = await tx.scan<ProactiveRun>('proactive-run', { limit: 100, after: cursor })
      for (const item of page.items) {
        if (!item.id.startsWith(prefix)) return items
        if (since === undefined || item.value.createdAt >= since) items.push(item.value)
      }
      if (!page.cursor || !page.cursor.startsWith(prefix)) return items
      cursor = page.cursor
    }
  }

  private async listRunsIn(tx: AsyncTx, ruleId: string, since?: number) {
    return this.scanRuns(tx, runPrefix(ruleId), since)
  }

  private async insert(tx: AsyncTx, run: ProactiveRun) {
    await tx.insert('proactive-run', run.id, run)
    return run
  }

  /** Reserve transitions and final settlement share this identity-preserving write. */
  private async insertOrReplace(tx: AsyncTx, run: ProactiveRun) {
    if (!await tx.replace('proactive-run', run.id, run)) await tx.insert('proactive-run', run.id, run)
    return run
  }
}
