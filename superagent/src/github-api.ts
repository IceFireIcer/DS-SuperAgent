import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CoreError } from './model.js'
import type { GitHubEvent } from './channels.js'
import type { GitHubTransport } from './pollers.js'
import type { GitHubComment, GitHubReplyRequest, GitHubReplyTransport } from './github-delivery.js'

const execFileAsync = promisify(execFile)
const pageSize = 100
const maxPages = 10
const timelinePageSize = 100
const maxTimelinePages = 3
const maxTimelineRequests = 60

export interface GitHubApiRequest { allowMissing?: boolean; method?: 'GET' | 'POST'; body?: { body: string }; host?: string; signal?: AbortSignal }
export type GitHubApiRunner = (path: string, request?: GitHubApiRequest) => Promise<unknown>
export type GitHubCredentialConsumer = <T>(purpose: 'source' | 'outbound', consume: (secret: string) => Promise<T>) => Promise<T>

export interface GitHubCliTransportOptions {
  command?: string
  maxBuffer?: number
  /** Inject the API call for tests; the default runs the authenticated `gh api`. */
  runner?: GitHubApiRunner
  withCredential?: GitHubCredentialConsumer
}

/** Real GitHub transport over the authenticated `gh api` CLI; no token is stored or printed. */
export class GitHubCliTransport implements GitHubTransport {
  private readonly command: string
  private readonly maxBuffer: number
  private readonly runner: GitHubApiRunner | undefined
  private readonly withCredential: GitHubCredentialConsumer | undefined
  constructor(options: GitHubCliTransportOptions = {}) {
    this.command = options.command ?? 'gh'
    this.maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024
    this.runner = options.runner
    this.withCredential = options.withCredential
  }

  async listEvents(request: { owner: string; repo: string; cursor?: string; signal: AbortSignal }) {
    request.signal.throwIfAborted()
    const raw = this.runner ?? this.cliRunner(request.signal)
    const run: GitHubApiRunner = this.withCredential && this.runner
      ? (path, options) => this.withCredential!('source', async () => raw(path, options)) : raw
    const events = await this.mapEvents(run, request.owner, request.repo)
    return { events: request.cursor === undefined ? events : events.filter(event => event.cursor > request.cursor!) }
  }

  private cliRunner(signal: AbortSignal): GitHubApiRunner {
    return async (path, options = {}) => {
      try {
        const run = async (secret?: string) => {
          const env = secret === undefined ? process.env : { ...process.env, GH_TOKEN: secret }
          try {
            const { stdout } = await execFileAsync(this.command, ['api', '--hostname', 'github.com', path],
              { maxBuffer: this.maxBuffer, signal, env })
            return { kind: 'success' as const, value: JSON.parse(stdout) as unknown }
          } catch (error) {
            return { kind: signal.aborted ? 'stopped' as const
              : error instanceof Error && isMissingResource(error.message) ? 'missing' as const : 'failed' as const }
          }
        }
        const result = this.withCredential ? await this.withCredential('source', run) : await run()
        if (result.kind === 'success') return result.value
        if (result.kind === 'missing' && options.allowMissing) return undefined
        throw new CoreError(result.kind === 'stopped' ? 'SOURCE_STOPPED' : 'SOURCE_FAILED', 'The GitHub API request failed.')
      } catch (error) {
        if (signal.aborted) throw new CoreError('SOURCE_STOPPED', 'The GitHub API request was stopped.')
        if (error instanceof CoreError && ['GRANT_DENIED', 'RESOURCE_UNAVAILABLE', 'RESOURCE_STALE'].includes(error.code)) throw error
        throw new CoreError('SOURCE_FAILED', 'The GitHub API request failed.')
      }
    }
  }

  async mapEvents(run: GitHubApiRunner, owner: string, repo: string): Promise<GitHubEvent[]> {
    const repository = `${owner}/${repo}`
    const base = `repos/${repository}`
    const issues = await listPages(run, `${base}/issues?state=all&sort=updated&direction=asc&per_page=${pageSize}`)
    const events: GitHubEvent[] = []
    const changedActors = new ChangedActorEnricher(run, base)
    for (const issue of issues) {
      if (!issue?.pull_request) {
        events.push(await changedActors.enrich(issueEvent(issue, repository), issue))
        const comments = await listPages(run, `${base}/issues/${issue.number}/comments?per_page=${pageSize}`, 'comment')
        for (const comment of comments) if (comment?.id) events.push(commentEvent(comment, issue.number, repository))
        continue
      }
      const pull = await run(`${base}/pulls/${issue.number}`, { allowMissing: true }) as Record<string, any> | undefined
      if (!pull) {
        events.push(await changedActors.enrich(deletedPullEvent(issue, repository), issue))
        continue
      }
      events.push(await changedActors.enrich(pullEvent(pull, repository), pull))
      const reviews = await listPages(run, `${base}/pulls/${pull.number}/reviews?per_page=${pageSize}`, 'review')
      for (const review of reviews) if (review?.submitted_at) events.push(reviewEvent(review, pull.number, repository))
      if (pull.head?.sha) {
        const checks = await listCheckPages(run, `${base}/commits/${pull.head.sha}/check-runs?per_page=${pageSize}`)
        for (const checkRun of checks) if (checkRun?.id) events.push(checkRunEvent(checkRun, pull.number, repository, pull.updated_at))
      }
      const comments = await listPages(run, `${base}/issues/${issue.number}/comments?per_page=${pageSize}`, 'comment')
      for (const comment of comments) if (comment?.id) events.push(commentEvent(comment, issue.number, repository))
    }
    return events.sort((left, right) => left.cursor.localeCompare(right.cursor))
  }
}

/** `gh api` reports the status explicitly; a bare 404 in the resource path is not a missing resource. */
export function isMissingResource(detail: string) {
  return /\bHTTP 404\b/u.test(detail)
}

/** Exact-target lookup and comment POST over GitHub's documented REST API. The runner is a transport test seam. */
export class GitHubCliReplyTransport implements GitHubReplyTransport {
  constructor(private readonly options: GitHubCliTransportOptions = {}) {}

  async getActor(request: GitHubReplyRequest) {
    const user = await this.api('user', { host: request.host, signal: request.signal }) as Record<string, unknown>
    if (!user || typeof user.login !== 'string' || !user.login) throw new CoreError('GITHUB_TRANSPORT_UNKNOWN', 'The authenticated GitHub actor could not be verified.')
    return user.login
  }

  private async api(path: string, request: GitHubApiRequest & { signal: AbortSignal }) {
    request.signal.throwIfAborted()
    if (this.options.runner) return this.options.runner(path, request)
    const args = ['api', '--hostname', request.host ?? 'github.com', '--method', request.method ?? 'GET', path]
    if (request.body) args.push('--input', '-')
    return new Promise<unknown>((resolve, reject) => {
      const child = execFile(this.options.command ?? 'gh', args, { maxBuffer: this.options.maxBuffer ?? 4 * 1024 * 1024,
        signal: request.signal, timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const status = stderr.match(/\bHTTP (\d{3})\b/u)?.[1]
          reject(new CoreError(status ? `GITHUB_HTTP_${status}` : 'GITHUB_TRANSPORT_UNKNOWN', 'The GitHub API did not return a confirmed response.'))
        } else {
          try { resolve(JSON.parse(stdout)) } catch { reject(new CoreError('GITHUB_TRANSPORT_UNKNOWN', 'The GitHub API returned an unreadable response.')) }
        }
      })
      child.stdin?.on('error', () => { /* The callback classifies an early CLI exit; never print request content. */ })
      child.stdin?.end(request.body ? JSON.stringify(request.body) : undefined)
    })
  }

  async getTarget(request: GitHubReplyRequest & { objectId: string }) {
    const match = /^(pr|issue):([1-9]\d*)(?::(comment|review):([1-9]\d*))?$/u.exec(request.objectId)
    if (!match) throw new CoreError('INVALID_INPUT', 'A GitHub reply needs an exact native issue, PR, comment or review reference.')
    const number = Number(match[2])
    if (!Number.isSafeInteger(number)) throw new CoreError('INVALID_INPUT', 'The GitHub discussion number is out of range.')
    const base = `repos/${request.owner}/${request.repo}`
    const path = match[3] === 'comment' ? `${base}/issues/comments/${match[4]}`
      : match[3] === 'review' ? `${base}/pulls/${number}/reviews/${match[4]}` : `${base}/${match[1] === 'pr' ? 'pulls' : 'issues'}/${number}`
    const value = await this.api(path, { host: request.host, signal: request.signal }) as Record<string, any>
    const url = new URL(String(value?.html_url))
    if (url.protocol !== 'https:' || url.hostname !== request.host
      || ![`/${request.owner}/${request.repo}/issues/${number}`, `/${request.owner}/${request.repo}/pull/${number}`].includes(url.pathname)
      || match[3] && String(value.id) !== match[4] || !match[3] && value.number !== number) {
      throw new CoreError('INVALID_INPUT', 'Native GitHub target evidence belongs to a different resource.')
    }
    if (match[3] === 'comment') {
      const issue = new URL(String(value.issue_url))
      const apiHost = request.host === 'github.com' ? 'api.github.com' : request.host
      if (issue.protocol !== 'https:' || issue.hostname !== apiHost || !issue.pathname.endsWith(`/${base}/issues/${number}`)) {
        throw new CoreError('INVALID_INPUT', 'The GitHub comment does not belong to the requested discussion.')
      }
    }
    return { number, url: value.html_url as string }
  }

  async listComments(request: GitHubReplyRequest & { number: number; page: number }) {
    const value = await this.api(`repos/${request.owner}/${request.repo}/issues/${request.number}/comments?per_page=100&page=${request.page}`,
      { host: request.host, signal: request.signal })
    if (!Array.isArray(value) || value.length > 100) throw new CoreError('GITHUB_TRANSPORT_UNKNOWN', 'GitHub returned an invalid comment page.')
    return { items: value.map(comment => this.comment(comment)), hasMore: value.length === 100 }
  }

  async createComment(request: GitHubReplyRequest & { number: number; body: string }) {
    return this.comment(await this.api(`repos/${request.owner}/${request.repo}/issues/${request.number}/comments`,
      { host: request.host, signal: request.signal, method: 'POST', body: { body: request.body } }))
  }

  private comment(value: any): GitHubComment {
    if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.html_url !== 'string'
      || typeof value.body !== 'string' || typeof value.user?.login !== 'string') throw new CoreError('GITHUB_TRANSPORT_UNKNOWN', 'GitHub did not return a complete native comment receipt.')
    return { id: String(value.id), url: value.html_url, body: value.body, authorId: value.user.login }
  }
}

async function listPages(run: GitHubApiRunner, path: string, label = 'issue'): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = await run(`${path}&page=${page}`)
    if (!Array.isArray(batch)) throw new CoreError('SOURCE_FAILED', `GitHub returned an invalid ${label} list.`)
    items.push(...batch)
    if (batch.length < pageSize) return items
  }
  throw new CoreError('SOURCE_BUDGET', `GitHub ${label} pagination exceeded ${maxPages} pages.`)
}

async function listCheckPages(run: GitHubApiRunner, path: string): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = await run(`${path}&page=${page}`, { allowMissing: true }) as Record<string, any> | undefined
    if (batch === undefined) {
      if (page === 1) return items
      throw new CoreError('SOURCE_FAILED', 'GitHub returned an incomplete check-run page.')
    }
    if (!Array.isArray(batch.check_runs)) throw new CoreError('SOURCE_FAILED', 'GitHub returned an invalid check-run list.')
    items.push(...batch.check_runs)
    const total = Number(batch.total_count)
    if (batch.check_runs.length < pageSize || Number.isSafeInteger(total) && items.length >= total) return items
  }
  throw new CoreError('SOURCE_BUDGET', `GitHub check-run pagination exceeded ${maxPages} pages.`)
}

function cursorFor(updatedAt: string, kind: string, id: unknown) {
  return `${updatedAt}#${kind}#${String(id).padStart(12, '0')}`
}

function issueEvent(issue: Record<string, any>, repository: string): GitHubEvent {
  const edited = typeof issue.created_at === 'string' && String(issue.updated_at) > issue.created_at
  const action = issue.state === 'closed' ? 'closed' : issue.state_reason === 'reopened' ? 'reopened' : edited ? 'edited' : 'created'
  const actor = eventActor(issue, action, issue.user)
  return { deliveryId: `issue-${issue.id}-${issue.updated_at}`, cursor: cursorFor(issue.updated_at, 'issue', issue.number), repo: repository,
    kind: 'issue', action, number: issue.number, id: String(issue.id), ...actor,
    title: issue.title, body: issue.body ?? '', updatedAt: issue.updated_at, state: issue.state }
}

function pullEvent(pull: Record<string, any>, repository: string): GitHubEvent {
  const state = pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open'
  const edited = typeof pull.created_at === 'string' && String(pull.updated_at) > pull.created_at
  const action = pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : edited ? 'edited' : 'created'
  const actor = eventActor(pull, action, pull.user)
  return { deliveryId: `pr-${pull.id}-${pull.updated_at}`, cursor: cursorFor(pull.updated_at, 'pr', pull.number), repo: repository,
    kind: 'pull_request', action, number: pull.number, id: String(pull.id),
    ...actor, title: pull.title, body: pull.body ?? '', updatedAt: pull.updated_at,
    draft: Boolean(pull.draft), state }
}

function reviewEvent(review: Record<string, any>, number: number, repository: string): GitHubEvent {
  const actor = nativeActor(review.user)
  return { deliveryId: `review-${review.id}-${review.submitted_at}`, cursor: cursorFor(review.submitted_at, 'review', review.id),
    repo: repository, kind: 'review', action: 'reviewed', number, id: String(review.id), authorId: actor?.login ?? 'github',
    authorKind: actor ? actorKind(actor) : 'system',
    body: review.body ?? `Review state ${review.state}`, updatedAt: review.submitted_at }
}

function commentEvent(comment: Record<string, any>, number: number, repository: string): GitHubEvent {
  const updatedAt = typeof comment.updated_at === 'string' ? comment.updated_at : String(comment.created_at)
  const edited = typeof comment.created_at === 'string' && String(comment.updated_at) > comment.created_at
  const actor = eventActor(comment, edited ? 'edited' : 'created', comment.user)
  return { deliveryId: `comment-${comment.id}-${updatedAt}`, cursor: cursorFor(updatedAt, 'comment', comment.id),
    repo: repository, kind: 'comment', action: edited ? 'edited' : 'created', number, id: String(comment.id),
    ...actor,
    body: comment.body ?? '', updatedAt }
}

function checkRunEvent(checkRun: Record<string, any>, number: number, repository: string, fallback: string): GitHubEvent {
  const updatedAt = checkRun.completed_at ?? checkRun.started_at ?? fallback
  return { deliveryId: `ci-${checkRun.id}-${updatedAt}`, cursor: cursorFor(updatedAt, 'ci', checkRun.id), repo: repository, kind: 'ci',
    action: checkRun.status === 'completed' ? 'completed' : 'created', number, id: String(checkRun.id),
    authorId: checkRun.app?.slug ?? 'github-actions', authorKind: 'ci',
    body: `Check run ${checkRun.name ?? 'unnamed'} ${checkRun.conclusion ?? checkRun.status}.${checkRun.details_url ? `\n\n${checkRun.details_url}` : ''}`,
    updatedAt }
}

function deletedPullEvent(issue: Record<string, any>, repository: string): GitHubEvent {
  const actor = eventActor(issue, 'deleted', issue.user)
  return { deliveryId: `pr-deleted-${issue.id}-${issue.updated_at}`, cursor: cursorFor(issue.updated_at, 'deleted', issue.number),
    repo: repository, kind: 'pull_request', action: 'deleted', number: issue.number, id: String(issue.id),
    ...actor, title: issue.title, updatedAt: issue.updated_at,
    deletionEvidence: `GitHub returned 404 for pull request #${issue.number} while the repository listing still contained it.` }
}

function eventActor(record: Record<string, any>, action: string, creator: Record<string, any> | undefined): Pick<GitHubEvent, 'authorId' | 'authorKind'> {
  if (action === 'created') {
    const owner = nativeActor(creator)
    return owner ? { authorId: owner.login, authorKind: actorKind(owner) } : { authorId: 'github', authorKind: 'system' }
  }
  const actor = explicitChangeActor(record)
  return actor
    ? { authorId: actor.login, authorKind: actorKind(actor) }
    : { authorId: 'github', authorKind: 'system' }
}

type NativeActor = Record<string, any> & { login: string }

function nativeActor(value: Record<string, any> | undefined): NativeActor | undefined {
  return typeof value?.login === 'string' && value.login ? value as NativeActor : undefined
}

function explicitChangeActor(record: Record<string, any>): NativeActor | undefined {
  return nativeActor(record.sender) ?? nativeActor(record.actor) ?? nativeActor(record.closed_by) ?? nativeActor(record.merged_by)
}

interface TimelineChange {
  action: 'edited' | 'closed' | 'merged' | 'reopened'
  actor: NativeActor
  createdAt: string
}

class ChangedActorEnricher {
  private readonly cache = new Map<number, Promise<Record<string, any>[]>>()
  private requests = 0

  constructor(private readonly run: GitHubApiRunner, private readonly base: string) {}

  async enrich(event: GitHubEvent, record: Record<string, any>) {
    if (event.action === 'created' || explicitChangeActor(record)) return event
    const timeline = await this.timeline(record.number)
    const change = timelineChangeFor(timeline, event)
    return change ? { ...event, action: change.action, authorId: change.actor.login, authorKind: actorKind(change.actor) }
      : event
  }

  private timeline(number: number) {
    const prior = this.cache.get(number)
    if (prior) return prior
    const request = (async () => {
      const items: Record<string, any>[] = []
      for (let page = 1; page <= maxTimelinePages; page++) {
        if (this.requests >= maxTimelineRequests) {
          return items
        }
        this.requests++
        const batch = await this.run(`${this.base}/issues/${number}/timeline?per_page=${timelinePageSize}&page=${page}`, { allowMissing: true })
        if (batch === undefined) return items
        if (!Array.isArray(batch)) throw new CoreError('SOURCE_FAILED', 'GitHub returned an invalid issue timeline.')
        items.push(...batch)
        if (batch.length < timelinePageSize) break
      }
      return items
    })()
    this.cache.set(number, request)
    return request
  }
}

function timelineChangeFor(timeline: Record<string, any>[], event: GitHubEvent): TimelineChange | undefined {
  const changes = timeline.flatMap(item => {
    const action = item?.event === 'edited' || item?.event === 'closed' || item?.event === 'merged' || item?.event === 'reopened'
      ? item.event as TimelineChange['action'] : undefined
    const actor = nativeActor(item?.actor)
    return action && actor && typeof item.created_at === 'string' ? [{ action, actor, createdAt: item.created_at }] : []
  })
  const preferred = event.action === 'merged' ? ['merged', 'closed']
    : event.action === 'closed' ? ['closed', 'merged']
      : event.action === 'reopened' ? ['reopened', 'edited']
        : event.action === 'edited' ? ['edited', 'reopened'] : []
  const exact = changes.filter(change => change.createdAt === event.updatedAt)
  for (const action of preferred) {
    const match = exact.find(change => change.action === action)
    if (match) return match
  }
  if (event.action !== 'edited') for (const action of preferred) {
    const match = changes.filter(change => change.action === action && change.createdAt <= event.updatedAt).at(-1)
    if (match) return match
  }
  return undefined
}

function actorKind(user: Record<string, any> | undefined): NonNullable<GitHubEvent['authorKind']> {
  const login = typeof user?.login === 'string' ? user.login : ''
  if (/^(?:github-actions)(?:\[bot\])?$/iu.test(login) || user?.type === 'Bot' && /(?:actions|ci)/iu.test(login)) return 'ci'
  return user?.type === 'Bot' || login.endsWith('[bot]') ? 'bot' : 'human'
}
