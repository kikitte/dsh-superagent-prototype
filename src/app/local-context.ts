/** Bounded, read-only admission context. No implicit cwd or Ticket preparation. */
import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_BYTES = 1 << 20
const MAX_ENTRIES = 2000
async function readContext(root: string, path: string, kind: 'file' | 'directory', signal: AbortSignal): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\0')) throw new Error('Context path must stay inside contextDirectory')
  const inside = (base: string, target: string) => { const part = relative(base, target); if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Context path escapes contextDirectory') }
  const base = await realpath(root)
  const target = await realpath(resolve(base, path))
  inside(base, target)
  signal.throwIfAborted()
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (kind === 'directory' ? constants.O_DIRECTORY : 0))
  try {
    const info = await handle.stat()
    // On Linux verify the opened object itself after open, closing parent-symlink races.
    if (process.platform === 'linux') inside(base, await realpath(`/proc/self/fd/${handle.fd}`))
    else { inside(base, await realpath(target)); const current = await stat(target); if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('Context file changed while opening') }
    if (kind === 'directory') {
      if (!info.isDirectory()) throw new Error('Context path is not a directory')
      const entries: { name: string; type: string }[] = []
      const directory = await opendir(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : target)
      for await (const entry of directory) {
        signal.throwIfAborted()
        if (entries.length >= MAX_ENTRIES) throw new Error(`Context directory exceeds ${MAX_ENTRIES} entries; read a narrower directory`)
        entries.push({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' })
      }
      signal.throwIfAborted()
      return JSON.stringify(entries.sort((a, b) => a.name.localeCompare(b.name)))
    }
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error(`Context file must be a regular file of at most ${MAX_BYTES} bytes`)
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('Context file exceeds read limit')
    signal.throwIfAborted()
    return buffer.subarray(0, length).toString('utf8')
  } finally { await handle.close() }
}

/** Return at the read deadline even if a filesystem operation has not returned yet; the read still closes its handles. */
export async function readLocalContext(root: string, path: string, kind: 'file' | 'directory', signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let abort!: () => void
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([readContext(root, path, kind, signal), deadline]) }
  finally { signal.removeEventListener('abort', abort) }
}
