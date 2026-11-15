// Support access: the non-root daemon check on macOS (macos-nonroot-terv-v2,
// measured on macOS 26.5.2 in meres/EREDMENY.md 5.17 and 5.18; Dani's yes 78522).
//
// On macOS there is no listener process and no pidfile: launchd holds the
// socket of the job com.openssh.sshd and starts, per connection, the Apple
// wrapper, which runs sshd for that one connection (inetd mode; measured: two
// logins, two fresh sshd-session processes, each a child of launchd). So the
// Linux B2/B3 (the listener's title, the pidfile's change time) do not apply.
// What a non-root user CAN read, and what this checks, all four must hold:
//
//   D1  the job's plist is exactly the measured shape: label com.openssh.sshd,
//       program the wrapper, its only argument the wrapper's name, inetd mode
//       without Wait, one socket group "Listeners" on the service name "ssh"
//       and nothing that binds it elsewhere; another argument is
//       sshd_daemon_options, any other shape sshd_daemon_unknown. The plist's
//       own "Disabled" key is NOT read: it says true while the port listens.
//   D2  launchd's override says the job is enabled (Remote Login on);
//   D3  launchd's view of the loaded job matches: that plist, that program and
//       argument, inetd-compatible, the "ssh" listener sockets;
//   D4  netstat shows exactly the pair launchd opens, tcp4 *.22 and tcp6 *.22,
//       listening, and no other listener on port 22 (an sshd of its own, bound
//       to one address, would answer with another configuration).
//
// And for B1 (the Include walk): every file and folder it read must belong to
// root and be writable by nobody else (Dani 78522 (2)); macOS ships a NESTED
// Include (100-macos.conf includes /etc/ssh/crypto.conf, measured), which the
// walk follows with its depth limit and its cycle guard.
//
// Not relied on, stated: whether an edited drop-in applies to the NEXT
// connection without anything else was not measured (writing a drop-in needs
// root). Every connection is a fresh process, so a reload check would have
// nothing to compare against; the configuration is read by the process that
// serves the connection. Remote Login's "only these users" list is not looked
// at: it decides nothing here, and is never reported as an allow (Dani F2).
import type { NonRootProblem } from './support-access-sshd-nonroot.js'

export const DARWIN_SSH_PLIST = '/System/Library/LaunchDaemons/ssh.plist'
export const DARWIN_SSH_LABEL = 'com.openssh.sshd'
export const DARWIN_SSH_PROGRAM = '/usr/libexec/sshd-keygen-wrapper'
export const DARWIN_SSH_ARGUMENTS: readonly string[] = ['sshd-keygen-wrapper']
export const PLUTIL_PROGRAM = '/usr/bin/plutil'
export const LAUNCHCTL_PROGRAM = '/bin/launchctl'
export const NETSTAT_PROGRAM = '/usr/sbin/netstat'

/** The keys of the measured plist. Any other key could change how the job runs: unknown. */
const PLIST_KEYS = new Set([
  'Label',
  'Program',
  'ProgramArguments',
  'inetdCompatibility',
  'Sockets',
  'Disabled',
  'MaterializeDatalessFiles',
  'POSIXSpawnType',
  'StandardErrorPath',
  'SHAuthorizationRight',
])

export type DarwinCheck = { readonly ok: true } | { readonly ok: false; readonly problem: NonRootProblem }
const UNKNOWN: DarwinCheck = { ok: false, problem: 'sshd_daemon_unknown' }
const OK: DarwinCheck = { ok: true }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** D1: the plist as `plutil -convert json -o - <plist>` prints it. */
export function darwinPlistCheck(json: string | null): DarwinCheck {
  if (json === null) return UNKNOWN
  let p: unknown
  try {
    p = JSON.parse(json)
  } catch {
    return UNKNOWN
  }
  if (!isObject(p) || Object.keys(p).some((k) => !PLIST_KEYS.has(k))) return UNKNOWN
  if (p.Label !== DARWIN_SSH_LABEL || p.Program !== DARWIN_SSH_PROGRAM) return UNKNOWN
  const args = p.ProgramArguments
  if (!Array.isArray(args) || args.length === 0 || args[0] !== DARWIN_SSH_ARGUMENTS[0]) return UNKNOWN
  if (args.length !== DARWIN_SSH_ARGUMENTS.length) return { ok: false, problem: 'sshd_daemon_options' }
  const inetd = p.inetdCompatibility
  if (!isObject(inetd) || inetd.Wait !== false || Object.keys(inetd).some((k) => k !== 'Wait' && k !== 'Instances')) return UNKNOWN
  const sockets = p.Sockets
  if (!isObject(sockets) || Object.keys(sockets).join(',') !== 'Listeners') return UNKNOWN
  const listeners = sockets.Listeners
  if (!isObject(listeners) || listeners.SockServiceName !== 'ssh') return UNKNOWN
  if (Object.keys(listeners).some((k) => k !== 'SockServiceName' && k !== 'Bonjour')) return UNKNOWN
  return OK
}

/** D2: `launchctl print-disabled system`: the job's line says enabled. */
export function darwinEnabledCheck(text: string | null): DarwinCheck {
  if (text === null) return UNKNOWN
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"' + DARWIN_SSH_LABEL + '" '))
  return lines.length === 1 && lines[0] === '"' + DARWIN_SSH_LABEL + '" => enabled' ? OK : UNKNOWN
}

/** D3: `launchctl print system/com.openssh.sshd`: the loaded job is the plist's, with its program, argument and sockets. */
export function darwinJobCheck(text: string | null): DarwinCheck {
  if (text === null) return UNKNOWN
  const lines = text.split('\n').map((l) => l.trim())
  const has = (line: string): boolean => lines.includes(line)
  if (!has('path = ' + DARWIN_SSH_PLIST) || !has('program = ' + DARWIN_SSH_PROGRAM)) return UNKNOWN
  const at = lines.indexOf('arguments = {')
  if (at < 0) return UNKNOWN
  const end = lines.indexOf('}', at)
  if (end < 0) return UNKNOWN
  const args = lines.slice(at + 1, end)
  if (args[0] !== DARWIN_SSH_ARGUMENTS[0]) return UNKNOWN
  if (args.length !== DARWIN_SSH_ARGUMENTS.length) return { ok: false, problem: 'sshd_daemon_options' }
  const sockets = lines.indexOf('sockets = {')
  if (sockets < 0 || lines[sockets + 1] !== '"Listeners" = {' || !lines.slice(sockets + 2, sockets + 6).includes('service name = ssh')) return UNKNOWN
  const properties = lines.find((l) => l.startsWith('properties = '))
  if (properties === undefined || !properties.slice('properties = '.length).split(' | ').includes('inetd-compatible')) return UNKNOWN
  return OK
}

/** D4: `netstat -an`: the listeners on port 22 are exactly launchd's pair, tcp4 *.22 and tcp6 *.22. */
export function darwinListenersCheck(text: string | null): DarwinCheck {
  if (text === null) return UNKNOWN
  const on22: string[] = []
  for (const raw of text.split('\n')) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 6 || cols[5] !== 'LISTEN' || !/^tcp[46]*$/.test(cols[0])) continue
    // macOS netstat writes the port after a dot, for IPv6 too (`*.22`, `::1.22`; Dani's review of #2784). A port
    // after a colon is counted as well: a listener in a form this did not expect must count, not slip past.
    if (/[.:]22$/.test(cols[3])) on22.push(cols[0] + ' ' + cols[3])
  }
  return on22.sort().join(',') === 'tcp4 *.22,tcp6 *.22' ? OK : UNKNOWN
}

/** B1 on macOS, Dani 78522 (2): what the walk read belongs to root and is writable by nobody else. */
export function darwinWalkOwnerCheck(owners: readonly ({ readonly uid: number; readonly mode: number } | null)[]): DarwinCheck {
  return owners.every((o) => o !== null && o.uid === 0 && (o.mode & 0o022) === 0) ? OK : UNKNOWN
}

/** The four, in order; the first that fails is the answer. */
export function checkDarwinDaemon(evidence: {
  readonly plistJson: string | null
  readonly printDisabled: string | null
  readonly printJob: string | null
  readonly netstat: string | null
  readonly walkOwners: readonly ({ readonly uid: number; readonly mode: number } | null)[]
}): DarwinCheck {
  for (const check of [
    darwinWalkOwnerCheck(evidence.walkOwners),
    darwinPlistCheck(evidence.plistJson),
    darwinEnabledCheck(evidence.printDisabled),
    darwinJobCheck(evidence.printJob),
    darwinListenersCheck(evidence.netstat),
  ]) {
    if (!check.ok) return check
  }
  return OK
}
