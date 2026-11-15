// One writer per plugin home. dsh Web and dsh Desktop share ~/.dsh, and each host keeps
// the team in memory and writes state.json whole, so two hosts at once would undo each
// other's changes. The first host to load takes `state.lock`; a second one only reads.
//
// The lock is a small JSON file (pid, host, a random token) whose mtime the holder bumps
// on a timer. A live holder on the same host needs both: a process that still runs under
// that pid and a heartbeat fresher than `staleMs` — a crashed holder's pid may be reused
// by an unrelated process, and without the heartbeat check that process would hold the
// team read-only for as long as it runs. The token, not the pid, decides ownership: a
// holder that finds another token has lost the lock.
import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

export function homeLock(path, { staleMs = 60_000, beatMs = 15_000, host = hostname(), pid = process.pid, isAlive = pidAlive, now = Date.now } = {}) {
  const token = randomUUID()
  let timer

  // undefined: no lock file; null: a file that does not parse (being written right now).
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return error?.code === 'ENOENT' ? undefined : null
    }
  }
  const age = () => {
    try { return now() - statSync(path).mtimeMs } catch { return Infinity }
  }
  const live = (holder) => {
    if (holder === undefined) return false
    if (holder === null) return age() < staleMs
    if (holder.host === host) return holder.pid !== pid && isAlive(holder.pid) && age() < staleMs
    return age() < staleMs
  }
  const owns = () => read()?.token === token
  const same = (holder, current) => (holder === null
    ? current === null
    : holder?.token !== undefined
      ? current?.token === holder.token
      : JSON.stringify(current) === JSON.stringify(holder))

  // Move the lock aside before deciding what it says. The name is unique to this
  // process, so a lock another process puts in its place is never deleted blind.
  const takeAway = () => {
    const trash = `${path}.${token}.${randomUUID()}.stale`
    try {
      renameSync(path, trash)
    } catch {
      return undefined
    }
    let holder
    try {
      holder = JSON.parse(readFileSync(trash, 'utf8'))
    } catch {
      holder = null
    }
    return { holder, trash }
  }
  const putBack = ({ holder, trash }) => {
    try {
      linkSync(trash, path)
    } catch {
      try { writeFileSync(path, JSON.stringify(holder), { flag: 'wx' }) } catch {}
    }
    try { unlinkSync(trash) } catch {}
  }

  const beat = () => {
    if (!owns()) {
      stop()
      return
    }
    const time = new Date(now())
    try { utimesSync(path, time, time) } catch {}
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  // Take the lock if it is free or its holder is gone. Returns undefined when this
  // process holds it, else what the lock file says about the holder.
  function claim() {
    if (owns()) return undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ pid, host, token, since: now() }), { flag: 'wx' })
        if (!owns()) continue
        stop()
        timer = setInterval(beat, beatMs)
        timer.unref?.()
        return undefined
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const holder = read()
      if (live(holder)) return holder ?? {}
      if (same(holder, read())) {
        const moved = takeAway()
        if (moved === undefined) continue
        if (same(holder, moved.holder)) {
          try { unlinkSync(moved.trash) } catch {}
        } else {
          // A new owner arrived after the check: give its lock back untouched.
          putBack(moved)
          continue
        }
      }
    }
    return read() ?? {}
  }

  function release() {
    stop()
    if (!owns()) return
    const moved = takeAway()
    if (moved === undefined) return
    if (moved.holder?.token === token) {
      try { unlinkSync(moved.trash) } catch {}
    } else {
      putBack(moved)
    }
  }

  return { claim, owns, release, read }
}
