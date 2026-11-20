import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ConnectorImportAdapter, ConnectorImportCandidate, ConnectorImportConfig } from './service.js'

export interface HostConnectorImportFile {
  id: string
  label: string
  path: string
}

export interface HostConnectorImportOptions {
  files: readonly HostConnectorImportFile[]
  maxBytes?: number
  readFile?: (path: string) => Promise<string>
}

interface ParsedServer {
  id: string
  name: string
  file: HostConnectorImportFile
  config: ConnectorImportConfig
}

const DEFAULT_MAX_BYTES = 1024 * 1024

function serverId(file: HostConnectorImportFile, name: string): string {
  return createHash('sha256').update(JSON.stringify(['connector-import-v1', file.id, name])).digest('hex')
}

function stripJsonComments(text: string): string {
  let output = ''
  let quote = false
  let escape = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    const next = text[index + 1]
    if (quote) {
      output += character
      if (escape) escape = false
      else if (character === '\\') escape = true
      else if (character === '"') quote = false
      continue
    }
    if (character === '"') { quote = true; output += character; continue }
    if (character === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++
      output += '\n'
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++
      index++
      continue
    }
    output += character
  }
  return output
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0')
    ? value.trim() : undefined
}

function resolvedSecret(value: unknown): string | undefined {
  const item = text(value, 16_384)
  return item && !/\$\{/u.test(item) ? item : undefined
}

function safeEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
}

function safeHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value)
}

function parseServer(file: HostConnectorImportFile, name: string, value: unknown): ParsedServer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const url = text(entry.url, 2048)
  const command = text(entry.command, 2048)
  if (url !== undefined && command !== undefined || url === undefined && command === undefined) return undefined
  const args = Array.isArray(entry.args) ? entry.args.filter(item => typeof item === 'string' && item.length <= 2048) as string[]
    : undefined
  if (args !== undefined && args.length > 64) return undefined
  const env: Record<string, string> = {}
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) return undefined
    for (const [key, raw] of Object.entries(entry.env as Record<string, unknown>)) {
      if (!safeEnvName(key)) return undefined
      const secret = resolvedSecret(raw)
      if (secret === undefined) return undefined
      env[key] = secret
    }
  }
  const headers: Record<string, string> = {}
  if (entry.headers !== undefined) {
    if (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)) return undefined
    for (const [key, raw] of Object.entries(entry.headers as Record<string, unknown>)) {
      if (!safeHeaderName(key)) return undefined
      const secret = resolvedSecret(raw)
      if (secret === undefined) return undefined
      headers[key] = secret
    }
  }
  const config: ConnectorImportConfig = { name,
    ...(url === undefined ? {} : { url }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }) }
  return { id: serverId(file, name), name, file, config }
}

/**
 * Controlled import over an explicit Host-fixed file list. The product endpoint
 * chooses a scanned ID only; it cannot submit a path, command, or environment
 * value of its own.
 */
export class HostConnectorImportAdapter implements ConnectorImportAdapter {
  private readonly files: readonly HostConnectorImportFile[]
  private readonly maxBytes: number
  private readonly reader: (path: string) => Promise<string>
  private readonly failures: Array<{ file: string; code: 'IMPORT_READ_FAILED' | 'IMPORT_INVALID' }> = []

  constructor(options: HostConnectorImportOptions) {
    if (!Array.isArray(options.files) || options.files.length > 20) {
      throw new Error('The Host connector import file list is invalid.')
    }
    for (const file of options.files) {
      if (!file.id || !file.label || !isAbsolute(file.path)) {
        throw new Error('Every Host connector import file needs an ID, label, and absolute path.')
      }
    }
    this.files = [...options.files]
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 4 * 1024 * 1024) {
      throw new Error('The Host connector import byte limit must be between 1 byte and 4 MiB.')
    }
    this.reader = options.readFile ?? (path => readFile(path, 'utf8'))
  }

  warnings(): ReadonlyArray<{ file: string; code: string }> {
    return this.failures.map(item => ({ ...item }))
  }

  async scan(): Promise<ConnectorImportCandidate[]> {
    this.failures.length = 0
    const servers = await this.parseAll()
    return servers.map(server => ({ id: server.id, name: server.name, source: server.file.label,
      transport: server.config.url ? 'http' : 'stdio',
      envNames: Object.keys(server.config.env ?? {}),
      headerNames: Object.keys(server.config.headers ?? {}) }))
  }

  async read(sourceId: string): Promise<ConnectorImportConfig> {
    const servers = await this.parseAll()
    const server = servers.find(item => item.id === sourceId)
    if (!server) throw new Error('The selected connector import source is unavailable.')
    return structuredClone(server.config)
  }

  private async parseAll(): Promise<ParsedServer[]> {
    const servers: ParsedServer[] = []
    for (const file of this.files) {
      let source: string
      try {
        source = await this.reader(file.path)
        if (Buffer.byteLength(source) > this.maxBytes) throw new Error('too large')
      } catch {
        this.failures.push({ file: file.id, code: 'IMPORT_READ_FAILED' })
        continue
      }
      let document: unknown
      try {
        document = JSON.parse(stripJsonComments(source))
      } catch {
        this.failures.push({ file: file.id, code: 'IMPORT_INVALID' })
        continue
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        this.failures.push({ file: file.id, code: 'IMPORT_INVALID' })
        continue
      }
      const root = document as Record<string, unknown>
      const group = root.mcpServers ?? root.servers
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue
      for (const [name, value] of Object.entries(group as Record<string, unknown>)) {
        if (!name || name.length > 128) continue
        try {
          const server = parseServer(file, name, value)
          if (server) servers.push(server)
        } catch {
          this.failures.push({ file: file.id, code: 'IMPORT_INVALID' })
        }
      }
    }
    return servers
  }
}

/** Default locations; the Host explicitly chooses whether to pass these. */
export function standardConnectorImportFiles(environment: NodeJS.ProcessEnv = process.env,
  home = homedir()): HostConnectorImportFile[] {
  const platform = process.platform
  const roaming = environment.APPDATA ?? join(home, 'AppData', 'Roaming')
  const config = join(home, '.config')
  const mac = join(home, 'Library', 'Application Support')
  return [
    { id: 'claude-desktop', label: 'Claude Desktop',
      path: platform === 'win32' ? join(roaming, 'Claude', 'claude_desktop_config.json')
        : platform === 'darwin' ? join(mac, 'Claude', 'claude_desktop_config.json')
          : join(config, 'Claude', 'claude_desktop_config.json') },
    { id: 'cursor', label: 'Cursor', path: join(home, '.cursor', 'mcp.json') },
    { id: 'vscode', label: 'VS Code',
      path: platform === 'win32' ? join(roaming, 'Code', 'User', 'mcp.json')
        : platform === 'darwin' ? join(mac, 'Code', 'User', 'mcp.json')
          : join(config, 'Code', 'User', 'mcp.json') },
  ]
}
