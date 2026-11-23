import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { real, within } from './copy-tree.mjs'

export async function pickDirectory(dialog, owner, { title, defaultPath, create = false } = {}) {
  const properties = ['openDirectory']
  if (create) properties.push('createDirectory', 'promptToCreate')
  const options = { title, defaultPath, properties }
  const result = await (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options))
  const path = result.filePaths[0]
  return result.canceled || typeof path !== 'string' || !isAbsolute(path) ? null : real(path)
}

export async function readImportFile(path, limit, protectedRoots) {
  const source = real(path)
  if (protectedRoots.some(root => within(source, real(root)))) return { error: 'unreadable' }
  const candidate = await lstat(source)
  if (!candidate.isFile()) return { error: 'unreadable' }
  if (candidate.size > limit) return { error: 'too-large' }
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.ino !== candidate.ino || info.dev !== candidate.dev || real(path) !== source) return { error: 'unreadable' }
    if (info.size > limit) return { error: 'too-large' }
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > info.size) return { error: info.size === limit ? 'too-large' : 'unreadable' }
    if (length !== info.size) return { error: 'unreadable' }
    return { bytes: buffer.subarray(0, length) }
  } finally {
    await file.close()
  }
}
