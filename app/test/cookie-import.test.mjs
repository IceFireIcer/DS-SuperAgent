// Writing parsed cookies into a partition session: the details mapping, the per-cookie
// apply with read-back verification and flush, the pending-import store, and the
// value-free preview the page confirms.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyCookies, CookieImports, previewOf, ProductCookieImports, toSetDetails } from '../src/cookie-import.mjs'
import { parseCookieFile } from '../src/cookie-parse.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cookies')
const parse = (name) => parseCookieFile(readFileSync(join(fixtures, name)))

test('toSetDetails maps a normalized cookie to the Electron set call', () => {
  const domain = toSetDetails({ name: 'n', value: 'v', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict', expires: 1893456000 })
  assert.equal(domain.url, 'https://example.com/')
  assert.equal(domain.domain, '.example.com')
  assert.equal(domain.sameSite, 'strict')
  assert.equal(domain.expirationDate, 1893456000)

  const hostOnly = toSetDetails({ name: 'n', value: 'v', domain: 'example.com', path: '/app', secure: false, httpOnly: false })
  assert.equal(hostOnly.url, 'http://example.com/app')
  assert.equal(hostOnly.domain, undefined, 'no leading dot means host-only: no domain field')
  assert.equal(hostOnly.sameSite, 'unspecified', 'no SameSite attribute stays unspecified')
  assert.equal(hostOnly.expirationDate, undefined, 'a session cookie carries no expiry')

  assert.equal(toSetDetails({ name: 'n', value: 'v', domain: 'x.io', path: '/', sameSite: 'None' }).sameSite, 'no_restriction')
  assert.equal(toSetDetails({ name: 'n', value: 'v', domain: 'x.io', path: '/', sameSite: 'Lax' }).sameSite, 'lax')
  assert.throws(
    () => toSetDetails({ name: 'n', value: 'v', domain: 'x.io', path: '/', secure: true, partitionKey: { topLevelSite: 'https://top.io' } }),
    /partitioned cookie cannot be stored/u)
})

/** A session.cookies stand-in: store what set accepts, refuse and drop what we are told to. */
function fakeSession({ reject = [], drop = [], existing = [] } = {}) {
  const stored = new Map()
  const key = (c) => [c.name, String(c.domain ?? '').replace(/^\.+/, ''), c.path ?? '/', c.hostOnly === true].join('\u0000')
  for (const cookie of existing) {
    stored.set(key(cookie), {
      ...cookie,
      hostOnly: typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !String(cookie.domain ?? '').startsWith('.'),
    })
  }
  return {
    stored,
    flushed: false,
    cookies: {
      set: async (details) => {
        if (reject.includes(details.name)) throw new Error(`Invalid cookie fields for ${details.value}`)
        if (!drop.includes(details.name)) {
          const host = new URL(details.url).host
          const cookie = {
            name: details.name, domain: details.domain ?? host, path: details.path, value: details.value,
            secure: details.secure, httpOnly: details.httpOnly, sameSite: details.sameSite,
            hostOnly: details.domain === undefined,
            ...(details.expirationDate === undefined ? {} : { expirationDate: details.expirationDate }),
          }
          stored.set(key(cookie), cookie)
        }
      },
      get: async () => [...stored.values()],
      flushStore: async function () { this.flushed = true },
    },
  }
}

test('applyCookies stores, verifies by read-back and flushes the store', async () => {
  const ses = fakeSession()
  const parsed = parse('cookie-editor.json')
  const report = await applyCookies(ses, parsed.cookies)
  assert.equal(report.stored, 8)
  assert.equal(report.dropped.length, 0)
  assert.equal(report.failed.length, 0)
  assert.equal(report.flushed, true)
  assert.equal(ses.stored.size, 8)
})

test('applyCookies reports rejects and silent drops per cookie', async () => {
  const ses = fakeSession({ reject: ['p_none'], drop: ['p_strict'] })
  const parsed = parse('cookie-editor.json')
  const report = await applyCookies(ses, parsed.cookies)
  assert.equal(report.stored, 6)
  assert.equal(report.failed.length, 1)
  assert.equal(report.failed[0].name, 'p_none')
  assert.equal(report.failed[0].reason, 'the browser rejected this cookie')
  assert.equal(JSON.stringify(report).includes(parsed.cookies.find(cookie => cookie.name === 'p_none').value), false)
  assert.equal(report.dropped.length, 1)
  assert.equal(report.dropped[0].name, 'p_strict')
  // Reports never carry values.
  for (const item of [...report.failed, ...report.dropped]) assert.equal(item.value, undefined)
})

test('an older cookie with the same name and domain is not counted as the imported value', async () => {
  const parsed = parse('cookie-editor.json')
  const target = parsed.cookies.find((cookie) => cookie.name === 'p_strict')
  const ses = fakeSession({ drop: ['p_strict'], existing: [{ ...target, value: 'old-value' }] })
  const report = await applyCookies(ses, parsed.cookies)
  assert.equal(report.stored, 7)
  assert.equal(report.dropped.length, 1)
  assert.equal(report.dropped[0].name, 'p_strict')
  assert.match(report.dropped[0].reason, /different cookie/u)
})

test('a host-only cookie is not confused with a domain cookie of the same name', async () => {
  const cookie = { name: 'n', value: 'v', domain: 'example.com', path: '/', secure: false, httpOnly: false }
  const ses = fakeSession({
    drop: ['n'],
    existing: [{ name: 'n', value: 'v', domain: '.example.com', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' }],
  })
  const report = await applyCookies(ses, [cookie])
  assert.equal(report.stored, 0)
  assert.equal(report.dropped.length, 1)
})

test('a pending import is value-bearing, one-shot and capped', () => {
  const imports = new CookieImports()
  const parsed = parse('cookies.txt')
  const { id, preview } = imports.store(parsed, { kind: 'file', label: 'cookies.txt' })
  assert.equal(preview.cookies, 8)
  assert.equal(preview.source.kind, 'file')
  assert.equal(preview.sites.length, 1) // all eight share 127.0.0.1
  assert.ok(preview.notes.includes('session-cookies'))
  assert.match(preview.sourceDigest, /^[a-f0-9]{64}$/u)
  assert.equal(parsed.cookies.some(cookie => JSON.stringify(preview).includes(cookie.value)), false)
  assert.equal(imports.peek(id).cookies.length, 8)
  assert.equal(imports.take(id).cookies.length, 8)
  assert.equal(imports.take(id), null, 'taken once')
  for (let i = 0; i < 20; i += 1) imports.store(parsed, { kind: 'file', label: String(i) })
  assert.equal(imports.peek(id), null, 'older pendings were evicted past the cap')
})

test('preview groups by site and reports skipped and adjusted entries', () => {
  const parsed = parse('malformed.cookies.txt')
  const preview = previewOf(parsed, { kind: 'file', label: 'malformed.cookies.txt' })
  assert.equal(preview.cookies, 5)
  assert.equal(preview.skipped.length, 7)
  assert.ok(preview.warnings.length > 0)
  assert.ok(preview.warnings.every((w) => w.count >= 1 && w.message))
})

test('a product browser import is idempotent per isolated profile and its report carries no values', async () => {
  const imports = new CookieImports()
  const product = new ProductCookieImports()
  const sourcePath = join(fixtures, 'cookie-editor.json')
  const before = readFileSync(sourcePath)
  const parsed = parseCookieFile(before)
  const pending = imports.store(parsed, { kind: 'file', label: 'cookie-editor.json' })
  const ses = fakeSession()
  const importId = '33333333-3333-4333-8333-333333333333'
  const first = await product.apply(ses, pending.id, importId, 'session-11111111-1111-4111-8111-111111111111', imports)
  const retry = await product.apply(ses, pending.id, importId, 'session-11111111-1111-4111-8111-111111111111', imports)
  assert.deepEqual(retry, first)
  assert.equal(first.stored, 8)
  assert.equal(JSON.stringify(first).includes(parsed.cookies[0].value), false)
  assert.deepEqual(readFileSync(sourcePath), before, 'the original export stays untouched')
  await assert.rejects(product.apply(ses, pending.id, importId,
    'session-22222222-2222-4222-8222-222222222222', imports), { code: 'BROWSER_IMPORT_CONFLICT' })
})

test('concurrent product apply calls share one in-flight cookie write', async () => {
  const imports = new CookieImports()
  const product = new ProductCookieImports()
  const parsed = parse('cookie-editor.json')
  const pending = imports.store(parsed, { kind: 'file', label: 'concurrent.json' })
  const ses = fakeSession()
  const originalSet = ses.cookies.set
  let sets = 0
  let release
  const held = new Promise(resolve => { release = resolve })
  ses.cookies.set = async details => {
    sets++
    await held
    return originalSet(details)
  }
  const importId = '44444444-4444-4444-8444-444444444444'
  const profile = 'session-11111111-1111-4111-8111-111111111111'
  const first = product.apply(ses, pending.id, importId, profile, imports)
  const second = product.apply(ses, pending.id, importId, profile, imports)
  for (let index = 0; index < 100 && sets === 0; index++) await new Promise(resolve => setTimeout(resolve, 5))
  release()
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.equal(sets, parsed.cookies.length)
})
