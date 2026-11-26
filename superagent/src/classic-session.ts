import { createHash, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateRequest, SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CoreError } from './model.js'
import type { ProductHost } from './product-host.js'

type ClassicController = Pick<SessionController, 'create' | 'list'>
type WorkspaceId = NonNullable<Parameters<ClassicController['create']>[0]['workspaceId']>
type ClassicLanding = { sessionId: SessionId; workspaceId: WorkspaceId }
type ActiveSession = ClassicLanding & { cwd: string; sessions: Set<string>;
  lifetime: AbortController; expires: NodeJS.Timeout }
export interface ClassicWorkspaces {
  create(path: string): Promise<{ id: WorkspaceId; sessionIds: readonly SessionId[]; attachSession(id: SessionId): Promise<void> }>
}
type DesktopPeer = object & { signal: AbortSignal }

export const classicProofHeader = 'x-ds-superagent-desktop-proof'
export const classicEndpoints = new Set(['classic-open', 'classic-renew', 'classic-close'])
const leaseMs = 90_000

export class ClassicSessionAccess {
  #peer: DesktopPeer | undefined
  #proof: Buffer | undefined
  #active: ActiveSession | undefined
  #request = 0
  #opening: Promise<ClassicLanding & { cwd: string; sessions: Set<string> }> | undefined

  constructor(private readonly host: Pick<ProductHost, 'dispatch'>,
    private readonly controller: ClassicController, private readonly workspaces: ClassicWorkspaces,
    private readonly recordInitialModel: (sessionId: SessionId) => void) {}

  bindDesktop(peer: DesktopPeer, proof: string) {
    this.revoke()
    this.#peer = peer
    this.#proof = Buffer.from(proof)
    peer.signal.addEventListener('abort', () => { if (this.#peer === peer) this.revoke() }, { once: true })
  }

  isDesktopPeer(peer: object | undefined) {
    const desktop = this.#peer
    return desktop !== undefined && peer === desktop && !desktop.signal.aborted
  }

  async visibleSessionId() {
    const current = () => this.#active?.sessionId
    const active = current()
    if (active) return active
    const binding = await this.host.dispatch('open') as { mainSessionId: string; mainSessionMode: string }
    return current() ?? (binding.mainSessionMode === 'native' ? binding.mainSessionId : undefined)
  }

  forPeer(peer: object | undefined): { sessionId: string; sessions: Set<string>; signal: AbortSignal } | undefined {
    if (!this.#active || !this.isDesktopPeer(peer)) return undefined
    return { sessionId: this.#active.sessionId, sessions: this.#active.sessions,
      signal: this.#active.lifetime.signal }
  }

  revoke() {
    this.#request += 1
    if (!this.#active) return
    this.#active.lifetime.abort()
    clearTimeout(this.#active.expires)
    this.#active = undefined
  }

  async dispatch(endpoint: string, payload: Record<string, unknown>, proof: string | null, peer: object | undefined):
    Promise<{ sessionId: string; workspaceId: string } | { closed: true }> {
    const candidate = Buffer.from(proof ?? '')
    if (!this.isDesktopPeer(peer) || !this.#proof
      || candidate.length !== this.#proof.length || !timingSafeEqual(candidate, this.#proof)) {
      throw new CoreError('CLASSIC_DENIED', 'Classic Agent mode is available from the local desktop window only.')
    }
    if (!payload || Object.keys(payload).length !== 1 || typeof payload.instanceId !== 'string') {
      throw new CoreError('INVALID_INPUT', 'Classic Agent mode requires the current Instance.')
    }
    const request = this.#request
    const binding = await this.host.dispatch('open') as { instanceId: string; mainSessionId: string; routerSessionId: string }
    if (payload.instanceId !== binding.instanceId) throw new CoreError('CLASSIC_DENIED', 'This Instance is outside the desktop window.')
    if (request !== this.#request) throw new CoreError('CLASSIC_UNAVAILABLE', 'The Classic Agent request ended. Open it again from Main.')
    if (endpoint === 'classic-close') {
      this.revoke()
      return { closed: true }
    }
    if (endpoint === 'classic-renew' && !this.#active) throw new CoreError('CLASSIC_UNAVAILABLE', 'The Classic Agent session has expired. Open it again from Main.')
    const opened = this.#active ?? await this.#open(binding)
    if (request !== this.#request) throw new CoreError('CLASSIC_UNAVAILABLE', 'The Classic Agent request ended. Open it again from Main.')
    clearTimeout(this.#active?.expires)
    const expires = setTimeout(() => this.revoke(), leaseMs)
    expires.unref()
    this.#active = { sessionId: opened.sessionId, workspaceId: opened.workspaceId, cwd: opened.cwd,
      sessions: opened.sessions, lifetime: this.#active?.lifetime ?? new AbortController(), expires }
    return { sessionId: opened.sessionId, workspaceId: opened.workspaceId }
  }

  async create(peer: object | undefined, request: SessionCreateRequest): Promise<SessionCreateValue> {
    const active = this.#active
    if (!active || !this.isDesktopPeer(peer) || active.lifetime.signal.aborted) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Native Session creation requires Classic Agent mode.')
    }
    if (request.workspaceId !== undefined && request.workspaceId !== active.workspaceId) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the active Classic Agent workspace is available.')
    }
    if (request.cwd !== undefined) {
      const cwd = await realpath(request.cwd).catch(() => undefined)
      if (cwd !== active.cwd) {
        throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the active Classic Agent workspace is available.')
      }
    }
    if (request.sessionId !== undefined && !active.sessions.has(request.sessionId)) {
      throw new CoreError('SOURCE_NOT_AUTHORIZED', 'Only the active Classic Agent Sessions are available.')
    }
    const binding = await this.host.dispatch('open') as { mainSessionId: string; routerSessionId: string }
    if (request.sessionId === binding.mainSessionId || request.sessionId === binding.routerSessionId) {
      throw new CoreError('CLASSIC_DENIED', 'Classic Agent needs an independent Session.')
    }
    active.lifetime.signal.throwIfAborted()
    const created = await this.controller.create({
      workspaceId: active.workspaceId,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    })
    if (created.sessionId === binding.mainSessionId || created.sessionId === binding.routerSessionId) {
      throw new CoreError('CLASSIC_DENIED', 'Classic Agent needs an independent Session.')
    }
    active.lifetime.signal.throwIfAborted()
    const fresh = !active.sessions.has(created.sessionId)
    active.sessions.add(created.sessionId)
    if (fresh) this.recordInitialModel(created.sessionId)
    clearTimeout(active.expires)
    active.expires = setTimeout(() => this.revoke(), leaseMs)
    active.expires.unref()
    return created
  }

  async #open(binding: { instanceId: string; mainSessionId: string; routerSessionId: string }): Promise<ClassicLanding & {
    cwd: string; sessions: Set<string> }> {
    this.#opening ??= this.#locate(binding).finally(() => { this.#opening = undefined })
    return this.#opening
  }

  async #locate({ instanceId, mainSessionId, routerSessionId }: { instanceId: string; mainSessionId: string; routerSessionId: string }) {
    const options = await this.host.dispatch('directory-options', { instanceId }) as { default: { root: string | null } | null }
    const root = options.default?.root
    const cwd = root ? await realpath(root).catch(() => undefined) : undefined
    if (!cwd || !await stat(cwd).then(entry => entry.isDirectory(), () => false)) {
      throw new CoreError('CLASSIC_UNAVAILABLE', 'Set an available default work directory before opening Classic Agent mode.')
    }
    const sessionId = SessionId(`classic-${createHash('sha256').update(JSON.stringify([instanceId, cwd])).digest('hex')}`)
    if (sessionId === mainSessionId || sessionId === routerSessionId) throw new CoreError('CLASSIC_DENIED', 'Classic Agent needs an independent session.')
    const catalog = await this.controller.list({}, AbortSignal.timeout(15_000))
    const existing = catalog.items.find(session => session.sessionId === sessionId)
    if (existing && (existing.cwd !== cwd || existing.parentSessionId !== undefined)) {
      throw new CoreError('CLASSIC_UNAVAILABLE', 'The Classic Agent session is outside the authorized work directory.')
    }
    try {
      const workspace = await this.workspaces.create(cwd)
      if (existing) {
        if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
      } else {
        const created = await this.controller.create({ sessionId, workspaceId: workspace.id })
        if (created.sessionId !== sessionId) throw new Error('The native session identity changed.')
        this.recordInitialModel(sessionId)
      }
      return { sessionId, workspaceId: workspace.id, cwd, sessions: new Set([sessionId]) }
    } catch {
      throw new CoreError('CLASSIC_UNAVAILABLE', 'The Host could not open an independent Classic Agent session in the authorized work directory.')
    }
  }
}
