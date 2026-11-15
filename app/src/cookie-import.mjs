// Import cookies into a Bot's browser partition. A file or a harvested browser profile is
// parsed first and held in memory under a pending id (cookie values never leave the main
// process); the page sees a value-free preview, and applying writes the cookies into the
// partition's session and verifies what the store actually kept.
import { randomUUID } from 'node:crypto'
import { describeCookie, summarizeBySite } from './cookie-parse.mjs'

const PENDING_TTL_MS = 10 * 60_000
const PENDING_MAX = 16

const SAME_SITE = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }

/** A normalized cookie → Electron's CookiesSetDetails. */
export function toSetDetails(cookie) {
  // Electron 44 has no partitionKey in CookiesSetDetails: writing this cookie anyway would
  // widen it from its top-level site into the default context.
  if (cookie.partitionKey !== undefined) throw new Error('a partitioned cookie cannot be stored without its top-level site')
  const host = String(cookie.domain ?? '').replace(/^\.+/, '')
  const details = {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    // Electron defaults to 'lax'; 'unspecified' keeps a cookie with no SameSite attribute honest.
    sameSite: cookie.sameSite ? SAME_SITE[cookie.sameSite] : 'unspecified',
  }
  // A leading dot makes it a domain cookie (also sent to subdomains); host-only cookies
  // carry no domain field and stay on the URL's host.
  if (String(cookie.domain ?? '').startsWith('.')) details.domain = cookie.domain
  if (typeof cookie.expires === 'number') details.expirationDate = cookie.expires
  return details
}

const identityOf = (c) => {
  const partition = c.partitionKey
  return [
    c.name,
    String(c.domain ?? '').replace(/^\.+/, '').toLowerCase(),
    c.path ?? '/',
    typeof c.hostOnly === 'boolean' ? c.hostOnly : !String(c.domain ?? '').startsWith('.'),
    partition ? `${partition.topLevelSite}\u0000${partition.hasCrossSiteAncestor === true}` : '',
  ].join('\u0000')
}

const sameSiteOf = (c) => (c.sameSite ? SAME_SITE[c.sameSite] : 'unspecified')

function sameStored(stored, cookie) {
  if (stored.value !== cookie.value) return false
  if (Boolean(stored.secure) !== Boolean(cookie.secure)) return false
  if (Boolean(stored.httpOnly) !== Boolean(cookie.httpOnly)) return false
  if ((stored.sameSite ?? 'unspecified') !== sameSiteOf(cookie)) return false
  if (typeof cookie.expires === 'number') {
    if (typeof stored.expirationDate !== 'number' || Math.abs(stored.expirationDate - cookie.expires) > 1) return false
  } else if (stored.expirationDate !== undefined) return false
  return true
}

/**
 * Write cookies into an Electron session: one `cookies.set` each so a rejected cookie cannot
 * take the batch down; then a read-back, because a settled promise does not mean the cookie
 * was stored; then flush, so a crash soon after cannot lose the import.
 * → { stored, dropped, failed, flushed } with value-free per-item detail.
 */
export async function applyCookies(storage, cookies) {
  const failed = []
  const failedIds = new Set()
  for (const cookie of cookies) {
    try {
      await storage.cookies.set(toSetDetails(cookie))
    } catch (error) {
      failed.push({ ...describeCookie(cookie), reason: error?.message ?? String(error) })
      failedIds.add(identityOf(cookie))
    }
  }
  const kept = new Map()
  for (const stored of await storage.cookies.get({})) {
    const id = identityOf(stored)
    const rows = kept.get(id)
    if (rows) rows.push(stored)
    else kept.set(id, [stored])
  }
  const dropped = []
  let storedCount = 0
  for (const cookie of cookies) {
    const id = identityOf(cookie)
    if (failedIds.has(id)) continue
    const rows = kept.get(id) ?? []
    if (rows.some((stored) => sameStored(stored, cookie))) storedCount += 1
    else {
      dropped.push({
        ...describeCookie(cookie),
        reason: rows.length === 0 ? 'the browser did not store it' : 'the browser kept a different cookie with the same name and domain',
      })
    }
  }
  let flushed = false
  try { await storage.cookies.flushStore(); flushed = true } catch { /* the store flushes itself within 30 s */ }
  return { stored: storedCount, dropped, failed, flushed }
}

/** What the page shows before and after an import — names, domains, paths and flags, never values. */
export function previewOf(result, source) {
  return {
    source,
    format: result.format ?? null,
    flavor: result.flavor ?? null,
    entries: result.entries ?? 0,
    cookies: result.cookies.length,
    sites: summarizeBySite(result),
    warnings: groupBy(result.warnings ?? []),
    skipped: (result.skipped ?? []).map((item) => ({ where: item.where, name: item.name, domain: item.domain, code: item.code, reason: item.reason })),
    notes: notesOf(result),
  }
}

function notesOf(result) {
  const notes = []
  if ((result.cookies ?? []).some((c) => c.expires === undefined)) notes.push('session-cookies')
  if ((result.info?.localStorageOrigins ?? []).length > 0) notes.push('local-storage-left')
  return notes
}

function groupBy(items) {
  const counts = new Map()
  for (const item of items) {
    const k = `${item.code}${item.message}`
    const entry = counts.get(k)
    if (entry) entry.count += 1
    else counts.set(k, { code: item.code, message: item.message, count: 1 })
  }
  return [...counts.values()]
}

/** Parsed imports waiting for the user's confirm: value-bearing, expiring, capped, one-shot. */
export class CookieImports {
  #pending = new Map()

  store(result, source) {
    this.sweep()
    while (this.#pending.size >= PENDING_MAX) this.#pending.delete(this.#pending.keys().next().value)
    const id = randomUUID()
    this.#pending.set(id, { cookies: result.cookies, expiresAt: Date.now() + PENDING_TTL_MS })
    return { id, preview: previewOf(result, source) }
  }

  /** The pending import, or null when it is gone or expired. Taking it leaves it for apply/drop. */
  peek(id) {
    const entry = this.#pending.get(id)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) { this.#pending.delete(id); return null }
    return entry
  }

  /** Apply consumes the pending import. */
  take(id) {
    const entry = this.peek(id)
    if (entry) this.#pending.delete(id)
    return entry
  }

  drop(id) { this.#pending.delete(id) }

  sweep() {
    const now = Date.now()
    for (const [id, entry] of this.#pending) if (entry.expiresAt < now) this.#pending.delete(id)
  }
}
