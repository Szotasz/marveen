// Support standby: what the machine looks like for support access, as one
// report. This is the part of the common routine that only LOOKS: it writes
// nothing, sends nothing and needs no code from the owner, so the rescue
// launcher can run it first and show the owner what would stop an enable.
//
// The same functions measure for the dashboard and for the command line: there
// is one sshd probe, one curl check and one way of counting support lines.
import { parseSkEd25519Blob, validateSupportPins, type SupportKeyPin, type SupportPinsProblem } from './support-access-pins.js'
import { countSupportLines } from './support-access-line.js'
import type { SshdAssessment, SshdProblem, SupportKeysFileName } from './support-access-sshd.js'

/**
 * The oldest node this routine runs on. THE ONE PLACE this number lives: the
 * launcher reads it from here. It is 20 because the installer accepts 20 and
 * newer, so machines we installed run 20 and 21, and the rescue path must not
 * stop on exactly those. The number is only true while it is measured: a CI
 * step runs the routine's self-contained file on node 20.
 */
export const SUPPORT_ROUTINE_MIN_NODE_MAJOR = 20

/**
 * Where the bound dispatcher looks for programs. It runs with this fixed PATH
 * (never the login environment's), so "is curl there" has to be asked of
 * exactly these directories, in this order.
 */
export const SUPPORT_DISPATCH_PATH: readonly string[] = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

export type KeysFileState =
  /** The file does not exist: no line in it. */
  | { readonly state: 'absent' }
  | { readonly state: 'read'; readonly supportLines: number }
  /** It exists and cannot be read: how many lines it holds is unknown. */
  | { readonly state: 'unreadable' }

export interface SupportStatusReport {
  readonly node: { readonly version: string; readonly ok: boolean }
  readonly pins: 'ok' | SupportPinsProblem
  /** `not_asked` while the pins are not usable: without a pinned source there is no connection to ask about. */
  readonly sshd: 'ok' | 'not_asked' | SshdProblem
  readonly sshdVersion: string | null
  /** The curl the dispatcher would find, or null. */
  readonly curl: string | null
  readonly keysFiles: Readonly<Record<SupportKeysFileName, KeysFileState>>
}

export interface SupportStatusDeps {
  /** `process.version`. */
  readonly nodeVersion: string
  readonly pins: { readonly keys: readonly SupportKeyPin[]; readonly fromCidrs: readonly string[] }
  readonly probeSshd: (fromCidrs: readonly string[]) => Promise<SshdAssessment>
  /** True when the path is a file this user may execute. */
  readonly isExecutable: (path: string) => boolean
  /**
   * The content of a file under the login user's `.ssh`, one character per
   * byte; null when it does not exist; 'unreadable' when it exists and cannot be read.
   */
  readonly readKeysFile: (name: SupportKeysFileName) => string | null | 'unreadable'
}

/** The major version in a `process.version` text, or null. */
export function nodeMajor(version: string): number | null {
  const m = /^v(\d{1,3})\.\d{1,3}\.\d{1,3}/.exec(version)
  return m === null ? null : Number(m[1])
}

function keysFileState(content: string | null | 'unreadable', pinnedBlobs: ReadonlySet<string>): KeysFileState {
  if (content === null) return { state: 'absent' }
  if (content === 'unreadable') return { state: 'unreadable' }
  return { state: 'read', supportLines: countSupportLines(content, pinnedBlobs) }
}

/** Look at the machine. Writes nothing; the only programs it starts are the ones the sshd probe starts. */
export async function supportStatus(deps: SupportStatusDeps): Promise<SupportStatusReport> {
  const major = nodeMajor(deps.nodeVersion)
  const pinsCheck = validateSupportPins(deps.pins.keys, deps.pins.fromCidrs)
  const pinnedBlobs = new Set(deps.pins.keys.filter((k) => parseSkEd25519Blob(k.pub).ok).map((k) => k.pub))
  let sshd: SupportStatusReport['sshd'] = 'not_asked'
  let sshdVersion: string | null = null
  if (pinsCheck.ok) {
    const assessed = await deps.probeSshd(deps.pins.fromCidrs)
    sshd = assessed.ok ? 'ok' : assessed.problem
    sshdVersion = assessed.version === null ? null : assessed.version.major + '.' + assessed.version.minor
  }
  const curl = SUPPORT_DISPATCH_PATH.map((dir) => dir + '/curl').find((path) => deps.isExecutable(path)) ?? null
  return {
    node: { version: deps.nodeVersion, ok: major !== null && major >= SUPPORT_ROUTINE_MIN_NODE_MAJOR },
    pins: pinsCheck.ok ? 'ok' : pinsCheck.code,
    sshd,
    sshdVersion,
    curl,
    keysFiles: {
      authorized_keys: keysFileState(deps.readKeysFile('authorized_keys'), pinnedBlobs),
      authorized_keys2: keysFileState(deps.readKeysFile('authorized_keys2'), pinnedBlobs),
    },
  }
}

function keysFileText(state: KeysFileState): string {
  return state.state === 'read' ? String(state.supportLines) : state.state
}

/**
 * The report as `key=value` lines, one fact per line, for the launcher and
 * for a person reading a terminal. The keys and the value words are a
 * contract: the launcher matches on them.
 */
export function formatSupportStatus(report: SupportStatusReport): string {
  return (
    [
      'node=' + (report.node.ok ? 'ok' : 'too_old'),
      'node_version=' + report.node.version,
      'node_minimum=' + SUPPORT_ROUTINE_MIN_NODE_MAJOR,
      'pins=' + report.pins,
      'sshd=' + report.sshd,
      'sshd_version=' + (report.sshdVersion ?? 'unknown'),
      'curl=' + (report.curl === null ? 'missing' : 'present'),
      'support_lines=' + keysFileText(report.keysFiles.authorized_keys),
      'support_lines_second_file=' + keysFileText(report.keysFiles.authorized_keys2),
    ].join('\n') + '\n'
  )
}
