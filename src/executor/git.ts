/** Read-only, whole-working-tree Git inspection. Unknown is never clean. */
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalDirectory } from '../app/directory-settings.ts'
import { GIT_LOCATION } from '../infra/environment.ts'
export interface GitProbe { state: 'non-git' | 'missing' | 'clean' | 'dirty' | 'unfinished' | 'unknown'; root?: string; gitDirectory?: string; detail?: string }
function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION.includes(name) && name !== 'GIT_CONFIG_PARAMETERS' && name !== 'GIT_CONFIG_COUNT' && !/^GIT_CONFIG_(KEY|VALUE)_/.test(name)))
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }).trimEnd()
}
export function inspectGit(path: string, cleanliness = false): GitProbe {
  try {
    try { if (!statSync(path).isDirectory()) return { state: 'unknown', detail: 'Execution path is not a directory' } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(path)
      if (parent === path) return { state: 'missing' }
      const ancestor = inspectGit(parent, cleanliness)
      return ancestor.root ? { ...ancestor, state: ancestor.state === 'clean' ? 'missing' : ancestor.state }
        : ancestor.state === 'unknown' ? ancestor : { state: 'missing' }
    }
    const canonical = canonicalDirectory(path)
    let marker = canonical, found = false
    for (;;) {
      try { lstatSync(join(marker, '.git')); found = true; break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      // Bare repositories have no .git marker and are never usable checkouts.
      try { if (statSync(join(marker, 'HEAD')).isFile() && statSync(join(marker, 'objects')).isDirectory() && statSync(join(marker, 'refs')).isDirectory()) return { state: 'unknown', detail: 'Bare repository is not an execution working tree' } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const parent = dirname(marker); if (parent === marker) break; marker = parent
    }
    if (!found) return { state: 'non-git' }
    if (git(canonical, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { state: 'unknown', detail: 'Git directory is not a working tree' }
    const root = realpathSync(git(canonical, ['rev-parse', '--show-toplevel']))
    const gitDirectory = realpathSync(git(canonical, ['rev-parse', '--absolute-git-dir']))
    const identity = { root, gitDirectory }
    if (!cleanliness) return { state: 'clean', ...identity }
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
      try { lstatSync(join(gitDirectory, name)); return { state: 'unfinished', ...identity, detail: `Unfinished Git operation: ${name}` } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const flags = git(root, ['ls-files', '-v', '-z'])
    if (flags.split('\0').some(entry => /^[a-zS] /.test(entry))) return { state: 'unknown', ...identity, detail: 'Index assume-unchanged/skip-worktree flags can hide changes; read-only verification cannot establish cleanliness' }
    const status = git(root, ['-c', 'status.showUntrackedFiles=all', '-c', 'diff.ignoreSubmodules=none', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])
    return { state: status ? 'dirty' : 'clean', ...identity, ...(status ? { detail: status.replace(/\0/g, '\n').slice(0, 1500) } : {}) }
  } catch (error) { return { state: 'unknown', detail: `Git status unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1800) } }
}
