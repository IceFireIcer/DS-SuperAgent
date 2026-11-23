// Adapted from DS Bot 0.3.8 ds-bot/src/host/browser/session.js (see NOTICE).
import { randomBytes } from 'node:crypto'
import type { Page } from 'playwright'
import { BrowserStepRejected, webUrl } from './protocol.js'

interface Link { url: string; label: string }
interface Snapshot { scope: string; pageUrl: string; links: Map<string, Link> }
const maxLinks = 20
const humanPath = /(?:^|[./_-])(?:login|logout|sign-?in|sign-?out|checkout|pay|payment|purchase|delete|remove|download|export|approve|confirm|reset|upload|unsubscribe)(?:$|[./_-])/iu

export function boundedBrowserText(value: string, maxBytes: number) {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  return bytes.subarray(0, maxBytes - 3).toString('utf8')
}

function safeLink(value: string, origin: string) {
  try {
    const target = webUrl(value)
    const path = decodeURIComponent(target.pathname)
    return target.origin === origin && !target.search && !humanPath.test(path) ? target.href : undefined
  } catch { return undefined }
}

async function linksIn(page: Page) {
  const links = await page.locator('a[href]:not([download])').evaluateAll(elements => elements.slice(0, 120).flatMap(element => {
    if (!(element instanceof HTMLAnchorElement) || !element.getClientRects().length || element.closest('[inert],[hidden],[aria-hidden=true]')
      || getComputedStyle(element).visibility !== 'visible' || !element.hasAttribute('href')) return []
    const label = (element.getAttribute('aria-label') || element.innerText || element.title || '').trim().replace(/\s+/gu, ' ')
    return label && element.href.length <= 2048 ? [{ label: label.slice(0, 100), url: element.href }] : []
  }))
  const origin = new URL(page.url()).origin
  const unique = new Map<string, Link>()
  for (const link of links) {
    const url = safeLink(link.url, origin)
    if (url && !unique.has(url)) unique.set(url, { url, label: link.label })
    if (unique.size >= maxLinks) break
  }
  return unique
}

export class BrowserLinkReferences {
  private readonly snapshots = new Map<string, Snapshot>()

  clear(profileKey: string) { this.snapshots.delete(profileKey) }

  async snapshot(page: Page, profileKey: string, scope: string) {
    const pageUrl = page.url()
    const links = await linksIn(page)
    const nonce = randomBytes(8).toString('hex')
    const refs = new Map([...links.values()].map((link, index) => [`e${index + 1}-${nonce}`, link]))
    this.clear(profileKey)
    if (page.url() !== pageUrl) return []
    this.snapshots.set(profileKey, { scope, pageUrl, links: refs })
    while (this.snapshots.size > 100) this.snapshots.delete(this.snapshots.keys().next().value!)
    return [...refs].map(([ref, link]) => `[ref=${ref}] ${boundedBrowserText(link.label, 100)}`)
  }

  async target(page: Page, profileKey: string, scope: string, ref: string) {
    const snapshot = this.snapshots.get(profileKey)
    const link = snapshot?.links.get(ref)
    if (!snapshot || snapshot.scope !== scope || snapshot.pageUrl !== page.url() || !link) {
      throw new BrowserStepRejected('BROWSER_REF_STALE', 'Take a fresh snapshot before following a link reference.')
    }
    const current = (await linksIn(page)).get(link.url)
    if (!current || current.label !== link.label || snapshot.pageUrl !== page.url()) {
      throw new BrowserStepRejected('BROWSER_LINK_DENIED', 'The referenced link changed or requires human control.')
    }
    this.clear(profileKey)
    return link.url
  }
}
