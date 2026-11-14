// Support access: what a probe run as ANOTHER USER than root has to prove
// before its `sshd -T` answers may count (nonroot-terv-v2, Dani's yes 78260).
//
// A non-root `sshd -T` globs the Include lines with the rights of that user.
// A drop-in directory the user cannot list is skipped in silence and the exit
// code is still 0 (measured on 8.9, 9.2, 9.6 and 10.0: 0700 and 0711, nested,
// and under a Match block). So the answer is only enough when this file has
// shown, on this machine, at this moment:
//
//   B1  every Include of the configuration, followed recursively, names a
//       directory this user can list, and every file it matches is readable;
//   B2  the running daemon is a listener started as `<sshd> [-D] [-e]`, with
//       no option that changes its configuration (its process title, which is
//       what /proc shows, not the raw argv; measured);
//   B3  no configuration file is newer than the daemon's pidfile: a listener
//       hands its children the configuration it read at its start or its last
//       reload (measured: an edit without a reload does not reach a new
//       connection; a SIGHUP keeps the PID and the start time but rewrites the
//       pidfile, so the pidfile is the reference, not the process).
//
// Anything this cannot tell is a refusal with its own reason, never an `ok`.
// Kept narrow on purpose: an Include argument with a quote, an escape, a
// tilde, a percent or a dollar sign, a glob in the directory part, or a
// bracket glob is not interpreted (measured: sshd takes ~, %h and ${HOME}
// literally, so refusing them hides nothing).
//
// Stated residual: the daemon reads its configuration a moment BEFORE it
// writes the pidfile; an edit inside that window looks older than the
// pidfile although the daemon read the previous text.
import { posix } from 'node:path'

export type NonRootProblem =
  | 'sshd_config_include_unlistable'
  | 'sshd_config_include_unparsed'
  | 'sshd_config_unknown'
  | 'sshd_daemon_unknown'
  | 'sshd_daemon_options'
  | 'sshd_reload_pending'

/** The main configuration of OpenSSH on Linux and macOS; the runner checks that sshd really reads this one. */
export const SSHD_MAIN_CONFIG = '/etc/ssh/sshd_config'
/** Relative Include paths are read against this directory (measured). */
export const SSHD_CONFIG_DIR = '/etc/ssh'
export const NONROOT_MAX_DEPTH = 16
export const NONROOT_MAX_FILES = 256
export const NONROOT_MAX_FILE_BYTES = 256 * 1024

const UNPARSED_CHARS = /["'\\~%$#]/
const GLOB_CHARS = /[*?[\]{}]/

/**
 * The arguments of every Include line of one configuration text, in order;
 * null when one of them is in a form this does not interpret. Every Include
 * counts, also one under a Match block (more is looked at than sshd may use).
 */
export function includeArguments(text: string): string[] | null {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // The keyword ends at white space or at one `=` (with white space around it), as sshd reads it.
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+|$)(.*)$/.exec(line)
    if (m === null || m[1].toLowerCase() !== 'include') continue
    const value = m[2].trim()
    if (value.length === 0 || UNPARSED_CHARS.test(value)) return null
    out.push(...value.split(/\s+/))
  }
  return out
}

/** One Include argument as an absolute directory and a file pattern, or null when it is not interpreted. */
export function includeTarget(arg: string): { dir: string; pattern: string } | null {
  if (arg.length === 0 || UNPARSED_CHARS.test(arg)) return null
  const full = arg.startsWith('/') ? arg : SSHD_CONFIG_DIR + '/' + arg
  // `.`, `..`, a doubled or a final slash: only the plain spelling is read.
  if (posix.normalize(full) !== full || full.endsWith('/')) return null
  const dir = posix.dirname(full)
  const pattern = posix.basename(full)
  if (GLOB_CHARS.test(dir) || /[[\]{}]/.test(pattern) || pattern.length === 0) return null
  return { dir, pattern }
}

/** Does a directory entry match an Include file pattern with * and ? (no brackets, no braces)? */
export function patternMatches(pattern: string, name: string): boolean {
  const re = '^' + pattern.replace(/[.+^$()|\\/]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  return new RegExp(re).test(name)
}

export type TextRead =
  | { readonly kind: 'ok'; readonly text: string; readonly mtimeNs: bigint }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }

export type DirList = { readonly kind: 'ok'; readonly names: readonly string[] } | { readonly kind: 'missing' } | { readonly kind: 'unlistable' }

export interface NonRootFs {
  /** Read a file (following a link, as sshd does), at most `max` bytes; larger is `unreadable`. */
  readonly readText: (path: string, max: number) => TextRead
  readonly listDir: (path: string) => DirList
}

export type IncludeWalk =
  | { readonly ok: true; readonly files: readonly { readonly path: string; readonly mtimeNs: bigint }[] }
  | { readonly ok: false; readonly problem: NonRootProblem }

/**
 * B1: walk the configuration from the main file through every Include. Every
 * file that is reached must be readable; every directory an Include names
 * must be listable (a missing one hides nothing and is fine, measured).
 */
export function walkIncludes(fs: NonRootFs, main: string = SSHD_MAIN_CONFIG): IncludeWalk {
  const files: { path: string; mtimeNs: bigint }[] = []
  const seen = new Set<string>()
  const visit = (path: string, depth: number): NonRootProblem | null => {
    if (depth > NONROOT_MAX_DEPTH || files.length >= NONROOT_MAX_FILES) return 'sshd_config_include_unparsed'
    if (seen.has(path)) return null
    seen.add(path)
    const read = fs.readText(path, NONROOT_MAX_FILE_BYTES)
    if (read.kind === 'missing') return depth === 0 ? 'sshd_config_unknown' : null
    if (read.kind === 'unreadable') return 'sshd_config_unknown'
    files.push({ path, mtimeNs: read.mtimeNs })
    const args = includeArguments(read.text)
    if (args === null) return 'sshd_config_include_unparsed'
    for (const arg of args) {
      const target = includeTarget(arg)
      if (target === null) return 'sshd_config_include_unparsed'
      const listed = fs.listDir(target.dir)
      if (listed.kind === 'unlistable') return 'sshd_config_include_unlistable'
      if (listed.kind === 'missing') continue
      for (const name of [...listed.names].sort()) {
        if (!patternMatches(target.pattern, name)) continue
        const problem = visit(target.dir + '/' + name, depth + 1)
        if (problem !== null) return problem
      }
    }
    return null
  }
  const problem = visit(main, 0)
  return problem === null ? { ok: true, files } : { ok: false, problem }
}

// `sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups`: what sshd writes as its title (measured 8.9 to 10.0).
// Only the bare program, `-D` and `-e` are accepted before the marker; any other option could change the config.
const LISTENER_TITLE = /^sshd: (\/[A-Za-z0-9._/-]+)((?: -[De])*) \[listener\] /

/** B2: the listener's title, as /proc shows it (NUL bytes count as spaces). */
export function listenerTitleProblem(cmdline: string): NonRootProblem | null {
  const title = cmdline.replace(/\0/g, ' ').trim() + ' '
  if (LISTENER_TITLE.test(title)) return null
  return /^sshd: \/\S+ .*\[listener\] /.test(title) ? 'sshd_daemon_options' : 'sshd_daemon_unknown'
}

/** The `pidfile` line of a `sshd -T` answer: an absolute path, or null for `none`, a missing or an odd line. */
export function pidfileOf(sshdT: string): string | null {
  let found: string | null = null
  for (const raw of sshdT.split('\n')) {
    const m = /^pidfile (.*)$/i.exec(raw.trim())
    if (m === null) continue
    if (found !== null) return null
    found = m[1]
  }
  return found !== null && /^\/[A-Za-z0-9._/-]+$/.test(found) ? found : null
}

export interface DaemonFs extends NonRootFs {
  /** The mtime of the pidfile in nanoseconds, or null when it cannot be read. */
  readonly mtimeNs: (path: string) => bigint | null
}

export type DaemonCheck = { readonly ok: true } | { readonly ok: false; readonly problem: NonRootProblem }

/**
 * B2 and B3 on Linux: the pidfile sshd names exists and holds a live PID whose
 * comm is `sshd` and whose title is a plain listener; no walked configuration
 * file is newer than the pidfile.
 */
export function checkDaemon(fs: DaemonFs, pidfile: string | null, walked: readonly { readonly mtimeNs: bigint }[]): DaemonCheck {
  if (pidfile === null) return { ok: false, problem: 'sshd_daemon_unknown' }
  const pidText = fs.readText(pidfile, 64)
  const pidMtime = fs.mtimeNs(pidfile)
  if (pidText.kind !== 'ok' || pidMtime === null || !/^[1-9][0-9]{0,9}\n?$/.test(pidText.text)) return { ok: false, problem: 'sshd_daemon_unknown' }
  const pid = pidText.text.trim()
  const comm = fs.readText('/proc/' + pid + '/comm', 64)
  if (comm.kind !== 'ok' || comm.text !== 'sshd\n') return { ok: false, problem: 'sshd_daemon_unknown' }
  const cmdline = fs.readText('/proc/' + pid + '/cmdline', 4096)
  if (cmdline.kind !== 'ok') return { ok: false, problem: 'sshd_daemon_unknown' }
  const title = listenerTitleProblem(cmdline.text)
  if (title !== null) return { ok: false, problem: title }
  if (walked.some((f) => f.mtimeNs > pidMtime)) return { ok: false, problem: 'sshd_reload_pending' }
  return { ok: true }
}
