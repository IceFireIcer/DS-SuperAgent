import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const maxEntries = 200
const areas = new Set(['host', 'update', 'backup', 'profile'])
const safeCode = /^[A-Z][A-Z0-9_]{0,79}$/u
const safeVersion = version => version === undefined
  || typeof version === 'string' && version.length <= 64 && /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu.test(version)

export function createOperationsLog(path, { now = Date.now } = {}) {
  let entries = []
  let loaded = false
  let writing = Promise.resolve()

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > 64 * 1024) return
      const content = await readFile(path, 'utf8')
      entries = content.split(/\r?\n/u).filter(Boolean).slice(-maxEntries).flatMap(line => {
        try {
          const item = JSON.parse(line)
          return Number.isSafeInteger(item.at) && item.at >= 0 && item.at <= 8.64e15 && areas.has(item.area)
            && typeof item.code === 'string' && safeCode.test(item.code) && safeVersion(item.version)
            ? [{ at: item.at, area: item.area, code: item.code, ...(item.version ? { version: item.version } : {}) }] : []
        } catch { return [] }
      })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  const record = (area, code, version) => {
    if (!areas.has(area) || typeof code !== 'string' || !safeCode.test(code) || !safeVersion(version)) return Promise.resolve(false)
    writing = writing.catch(() => {}).then(async () => {
      await load()
      entries.push({ at: now(), area, code, ...(version ? { version } : {}) })
      entries = entries.slice(-maxEntries)
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${entries.map(item => JSON.stringify(item)).join('\n')}\n`, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
    })
    return writing.then(() => true)
  }

  return { record, async read() { await writing.catch(() => {}); await load(); return structuredClone(entries) } }
}
