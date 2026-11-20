// Adapted from the project's prior DS-Bot connector catalog under
// temp/DS-Bot/ds-bot/src/host/connectors/catalog.js. Names and public service
// addresses are facts; the product projection and auth contract are new.
import type { CredentialPurpose } from '../resource-credentials.js'

export type ConnectorAuthKind = 'none' | 'token' | 'oauth' | 'link'

export interface ConnectorCatalogEntry {
  id: string
  name: string
  category: string
  about: string
  remoteUrl?: string
  purpose?: CredentialPurpose
  auth: {
    kind: ConnectorAuthKind
    token?: boolean
    scopes?: string[]
    keyUrl?: string
  }
}

const oauth = (id: string, name: string, category: string, about: string, remoteUrl: string,
  scopes?: string[]): ConnectorCatalogEntry => ({
  id, name, category, about, remoteUrl, auth: { kind: 'oauth', ...(scopes ? { scopes } : {}) },
})

const noAuth = (id: string, name: string, category: string, about: string,
  remoteUrl: string): ConnectorCatalogEntry => ({ id, name, category, about, remoteUrl, auth: { kind: 'none' } })

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = Object.freeze([
  {
    id: 'github', name: 'GitHub', category: 'dev',
    about: 'Repositories, issues, and pull requests',
    remoteUrl: 'https://api.githubcopilot.com/mcp/',
    auth: { kind: 'oauth', token: true, scopes: ['repo', 'read:org'] },
  },
  {
    id: 'feishu', name: 'Feishu', category: 'work',
    about: 'Authorize Feishu through the product credential service',
    purpose: 'source', auth: { kind: 'oauth', token: false },
  },
  oauth('notion', 'Notion', 'docs', 'Pages, databases, and wiki content', 'https://mcp.notion.com/mcp'),
  oauth('linear', 'Linear', 'work', 'Issues, projects, and cycles', 'https://mcp.linear.app/mcp'),
  oauth('atlassian', 'Atlassian', 'work', 'Jira issues and Confluence pages', 'https://mcp.atlassian.com/v1/mcp'),
  oauth('sentry', 'Sentry', 'dev', 'Errors, traces, and releases', 'https://mcp.sentry.dev/mcp'),
  oauth('stripe', 'Stripe', 'commerce', 'Payments, invoices, and customers', 'https://mcp.stripe.com'),
  oauth('paypal', 'PayPal', 'commerce', 'Orders, payments, and invoices', 'https://mcp.paypal.com/mcp'),
  oauth('square', 'Square', 'commerce', 'Payments, orders, and catalog', 'https://mcp.squareup.com/mcp'),
  oauth('cloudflare', 'Cloudflare', 'dev', 'Workers, DNS, and account resources', 'https://bindings.mcp.cloudflare.com/mcp'),
  oauth('vercel', 'Vercel', 'dev', 'Projects, deployments, and logs', 'https://mcp.vercel.com'),
  oauth('supabase', 'Supabase', 'data', 'Databases, tables, and project settings', 'https://mcp.supabase.com/mcp'),
  oauth('neon', 'Neon', 'data', 'Postgres databases and branches', 'https://mcp.neon.tech/mcp'),
  oauth('figma', 'Figma', 'design', 'Design files, components, and comments', 'https://mcp.figma.com/mcp'),
  oauth('canva', 'Canva', 'design', 'Designs, folders, and exports', 'https://mcp.canva.com/mcp'),
  oauth('intercom', 'Intercom', 'work', 'Conversations, contacts, and articles', 'https://mcp.intercom.com/mcp'),
  oauth('monday', 'monday.com', 'work', 'Boards, items, and workflows', 'https://mcp.monday.com/mcp'),
  oauth('webflow', 'Webflow', 'design', 'Sites, pages, and CMS content', 'https://mcp.webflow.com/mcp'),
  oauth('wix', 'Wix', 'design', 'Sites, pages, and site content', 'https://mcp.wix.com/mcp'),
  oauth('netlify', 'Netlify', 'dev', 'Sites, deploys, and forms', 'https://netlify-mcp.netlify.app/mcp'),
  oauth('airtable', 'Airtable', 'data', 'Bases, tables, and records', 'https://mcp.airtable.com/mcp'),
  oauth('dropbox', 'Dropbox', 'docs', 'Files and folders', 'https://mcp.dropbox.com/mcp'),
  oauth('zapier', 'Zapier', 'work', 'Zaps and app actions', 'https://mcp.zapier.com/api/mcp/mcp'),
  oauth('clickup', 'ClickUp', 'work', 'Tasks, lists, and docs', 'https://mcp.clickup.com/mcp'),
  oauth('todoist', 'Todoist', 'work', 'Tasks and projects', 'https://ai.todoist.net/mcp'),
  oauth('miro', 'Miro', 'design', 'Boards and whiteboard items', 'https://mcp.miro.com/'),
  oauth('attio', 'Attio', 'work', 'CRM records, lists, and notes', 'https://mcp.attio.com/mcp'),
  oauth('postman', 'Postman', 'dev', 'Collections, requests, and workspaces', 'https://mcp.postman.com/mcp'),
  oauth('asana', 'Asana', 'work', 'Tasks, projects, and workspaces', 'https://mcp.asana.com/v2/mcp'),
  oauth('box', 'Box', 'docs', 'Files, folders, and metadata', 'https://mcp.box.com'),
  oauth('hubspot', 'HubSpot', 'work', 'Contacts, deals, and tickets', 'https://mcp.hubspot.com/'),
  oauth('slack', 'Slack', 'work', 'Channels and messages', 'https://mcp.slack.com/mcp'),
  noAuth('huggingface', 'Hugging Face', 'data', 'Models, datasets, and Spaces', 'https://huggingface.co/mcp'),
  noAuth('exa', 'Exa', 'search', 'Web search for agents', 'https://mcp.exa.ai/mcp'),
  noAuth('deepwiki', 'DeepWiki', 'docs', 'Documentation for public code repositories', 'https://mcp.deepwiki.com/mcp'),
  noAuth('context7', 'Context7', 'docs', 'Library documentation and code examples', 'https://mcp.context7.com/mcp'),
  noAuth('mslearn', 'Microsoft Learn', 'docs', 'Microsoft product documentation', 'https://learn.microsoft.com/api/mcp'),
  noAuth('cloudflare-docs', 'Cloudflare Docs', 'docs', 'Cloudflare product documentation', 'https://docs.mcp.cloudflare.com/mcp'),
  {
    id: 'amap', name: 'Amap', category: 'search',
    about: 'Maps, places, and routes in China',
    remoteUrl: 'https://mcp.amap.com/mcp',
    auth: { kind: 'token', keyUrl: 'https://lbs.amap.com/api/mcp-server/create' },
  },
  { id: 'mail', name: 'Mailbox', category: 'mail', about: 'Read and reply to email over IMAP and SMTP', auth: { kind: 'link' } },
])

export const CONNECTOR_CATEGORIES = ['dev', 'docs', 'work', 'design', 'data', 'commerce', 'search', 'mail'] as const

export function connectorEntry(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find(entry => entry.id === id)
}

export function customConnectorId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
    .replace(/^(\d)/u, 'c-$1').slice(0, 28) || 'custom'
  let id = base
  if (connectorEntry(id) || id === 'mail') id = `${base}-x`
  let sequence = 2
  while (taken.has(id) || connectorEntry(id) || id === 'mail') {
    const suffix = `-${sequence++}`
    id = `${base.slice(0, 28 - suffix.length)}${suffix}`
  }
  return id
}
