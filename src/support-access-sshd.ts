// Support access: what the machine's sshd would do with a support line, as
// pure functions over text that sshd itself printed.
//
// The caller runs two commands and hands their output here; nothing in this
// file starts a process, reads a file or looks at the environment:
//   - the version text: `sshd -V`, or the usage text sshd prints for an unknown
//     flag. Measured on OpenSSH 7.6 to 10.0: 9.6 and 10.0 answer `-V` with the
//     version line, older ones say "unknown option -- V" and print the same
//     `OpenSSH_<major>.<minor>` line inside the usage text.
//   - the effective configuration FOR THE CONNECTION a support login would be:
//     `sshd -T -C user=..,addr=..,host=..,laddr=..,lport=..`, once for every
//     combination this file plans. Measured: as a non-root user sshd exits with
//     "no hostkeys available" unless it gets a host key of its own through
//     `-h`; with one it prints the same lines.
//
// WHY NOT THE PLAIN `sshd -T` (measured on OpenSSH 8.9, 9.2, 9.6 and 10.0):
// it does not apply `Match` blocks. A setting switched on only inside a Match
// block reads as the global value there, and of the criteria a block can name,
// sshd complains about a missing one for LocalPort ONLY (exit 255, no output);
// a block on User, Group, Address, Host or LocalAddress is skipped in silence
// when the query does not name that criterion. So every criterion is named:
// the login user, each pinned source address, the same address as the host
// (true while UseDNS is off, which is therefore required), each address of
// this machine, each port sshd listens on. "Each address of this machine" is
// the interface addresses AND the addresses of the `listenaddress` lines: an
// address sshd is told to listen on may belong to an interface that is down
// right now and up tomorrow.
// NOT COVERED: a block on RDomain. A routing domain cannot be listed from
// here; a `listenaddress` line that names one is refused as unreadable.
//
// EVERY ANSWER FAILS CLOSED. A setting that is not in the text is unknown, and
// unknown is a refusal: the support line is never written on a guess.
import { isIP } from 'node:net'
import { SUPPORT_MIN_SSHD, sshdAtLeast, type SshdVersion } from './support-access-line.js'

/** Why support access cannot be enabled on this sshd. */
export type SshdProblem =
  | 'sshd_version_unknown'
  | 'sshd_too_old'
  | 'sshd_config_unknown'
  | 'sshd_usedns_enabled'
  | 'root_login_disabled'
  | 'tunnel_permitted'
  | 'authorized_keys_path_unsupported'
  | 'other_key_source'

/**
 * The OpenSSH version in what sshd printed, or null. Only a line that STARTS
 * with `OpenSSH_` counts: the usage text also names the program in other
 * places, and a banner from another implementation must not pass as a version.
 * Two different versions in one text is not an answer either.
 */
export function parseSshdVersion(text: string): SshdVersion | null {
  let found: SshdVersion | null = null
  for (const raw of text.split('\n')) {
    const m = /^OpenSSH_(\d{1,3})\.(\d{1,3})(?:[^0-9]|$)/.exec(raw.trim())
    if (m === null) continue
    const version = { major: Number(m[1]), minor: Number(m[2]) }
    if (found !== null && (found.major !== version.major || found.minor !== version.minor)) return null
    found = version
  }
  return found
}

/** The settings of one `sshd -T` answer that decide whether a support line is safe here. */
export interface SshdEffectiveConfig {
  /** `permitrootlogin`, lower case, as printed (`without-password`, `no`, ...). */
  readonly permitRootLogin: string
  /** `permittunnel`, lower case, as printed (`no`, `yes`, `point-to-point`, `ethernet`). */
  readonly permitTunnel: string
  /** `usedns`, lower case, as printed. */
  readonly useDns: string
  /** `authorizedkeysfile` entries, as printed (relative to the home, or absolute, or with tokens). */
  readonly authorizedKeysFiles: readonly string[]
  /** `authorizedkeyscommand`, the whole value as printed (`none` when there is no command). */
  readonly authorizedKeysCommand: string
  /** `trustedusercakeys`, the whole value as printed (`none` when there is no CA file). */
  readonly trustedUserCaKeys: string
  /** Every port sshd listens on: the `port` lines and the port of every `listenaddress` line, ascending. */
  readonly listenPorts: readonly number[]
  /** The address of every `listenaddress` line, lower case, without brackets, sorted (the wildcards included). */
  readonly listenAddresses: readonly string[]
}

const SETTING_VALUE = /^[A-Za-z0-9._%/-]+$/
/** Settings that must appear exactly once. */
const SINGLE_SETTINGS = [
  'permitrootlogin',
  'permittunnel',
  'usedns',
  'authorizedkeysfile',
  'authorizedkeyscommand',
  'trustedusercakeys',
] as const
// `listenaddress 0.0.0.0:22`, `listenaddress [::]:22`: the port is what follows the last colon.
// Measured: sshd prints the address as a number, an IPv6 one in brackets.
const LISTEN_ADDRESS = /^(?:\[([0-9A-Fa-f:.]+)\]|([0-9.]+)):(\d{1,5})$/

function portOf(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * Read the settings out of one `sshd -T` answer. Returns null unless each
 * single setting appears EXACTLY once and at least one port is named: a
 * missing line, a repeated line, a value with unexpected characters, or a
 * `listenaddress` line in a form this does not know (one that names a routing
 * domain, or whose address is not a number) means the text is not something
 * to conclude from.
 */
export function parseSshdEffectiveConfig(text: string): SshdEffectiveConfig | null {
  const seen = new Map<string, string>()
  const ports = new Set<number>()
  const addresses = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
    if (key === 'port') {
      const port = portOf(value)
      if (port === null) return null
      ports.add(port)
    } else if (key === 'listenaddress') {
      const m = LISTEN_ADDRESS.exec(value)
      const port = m === null ? null : portOf(m[3])
      if (m === null || port === null) return null
      // In brackets only an IPv6 address, without them only an IPv4 one.
      const address = (m[1] ?? m[2]).toLowerCase()
      if (isIP(address) !== (m[1] === undefined ? 4 : 6)) return null
      ports.add(port)
      addresses.add(address)
    } else if ((SINGLE_SETTINGS as readonly string[]).includes(key)) {
      if (seen.has(key) || value.length === 0) return null
      seen.set(key, value)
    }
  }
  if (ports.size === 0 || SINGLE_SETTINGS.some((key) => !seen.has(key))) return null
  const one = (key: (typeof SINGLE_SETTINGS)[number]): string | null => {
    const value = seen.get(key) as string
    return SETTING_VALUE.test(value) ? value.toLowerCase() : null
  }
  const permitRootLogin = one('permitrootlogin')
  const permitTunnel = one('permittunnel')
  const useDns = one('usedns')
  const files = (seen.get('authorizedkeysfile') as string).split(/\s+/)
  if (permitRootLogin === null || permitTunnel === null || useDns === null) return null
  if (!files.every((f) => SETTING_VALUE.test(f))) return null
  return {
    permitRootLogin,
    permitTunnel,
    useDns,
    authorizedKeysFiles: files,
    authorizedKeysCommand: seen.get('authorizedkeyscommand') as string,
    trustedUserCaKeys: seen.get('trustedusercakeys') as string,
    listenPorts: [...ports].sort((a, b) => a - b),
    listenAddresses: [...addresses].sort(),
  }
}

/**
 * Can a connection from a pinned source arrive on this address of the machine?
 * A pinned source is a routable address of another machine, so not on a
 * loopback or a link-local address, and "every address" (`0.0.0.0`, `::`) is
 * not an address a connection has. Anything that is not a plain address (a
 * zone id, a name) is left out as well.
 */
export function isArrivalAddress(address: string): boolean {
  const a = address.toLowerCase()
  if (!PLAIN_ADDRESS.test(a)) return false
  const family = isIP(a)
  if (family === 4) return !(a.startsWith('127.') || a.startsWith('169.254.') || a === '0.0.0.0')
  if (family === 6) return !(a === '::1' || /^fe[89ab]/.test(a) || /^[0:]+$/.test(a))
  return false
}

/**
 * The local addresses the questions have to name: the interface addresses the
 * caller found, and every address sshd is told to listen on that a connection
 * could arrive on. Lower case, sorted, without repeats, so the plan is the
 * same on every run. The runner and the assessment both call this, so the
 * assessment recomputes on its own what had to be asked.
 */
export function probeLocalAddresses(interfaceAddresses: readonly string[], listenAddresses: readonly string[]): string[] {
  const out = new Set<string>(interfaceAddresses.map((a) => a.toLowerCase()))
  for (const address of listenAddresses) if (isArrivalAddress(address)) out.add(address.toLowerCase())
  return [...out].sort()
}

/** One connection a support login could be, as sshd's `-C` test mode describes it. */
export interface SshdConnectionSpec {
  /** The login user: the install user, whose authorized_keys gets the line. */
  readonly user: string
  /** A pinned source address, without the prefix length. */
  readonly addr: string
  /** An address of this machine the connection could arrive on. */
  readonly laddr: string
  /** A port sshd listens on. */
  readonly lport: number
}

const LOGIN_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
const PLAIN_ADDRESS = /^[0-9A-Fa-f:.]+$/

/**
 * The `-C` argument for one connection, or null when a part cannot be carried
 * in it (the argument is a comma-separated list, and nothing is quoted). The
 * host is the source address itself: that is what sshd matches `Match Host`
 * against while UseDNS is off.
 */
export function formatSshdConnectionSpec(spec: SshdConnectionSpec): string | null {
  if (!LOGIN_USER.test(spec.user)) return null
  // isIP() accepts a zone id (`fe80::1%eth0`); the plain alphabet check keeps it, and a comma, out.
  if (!PLAIN_ADDRESS.test(spec.addr) || !PLAIN_ADDRESS.test(spec.laddr)) return null
  if (isIP(spec.addr) === 0 || isIP(spec.laddr) === 0) return null
  if (!Number.isInteger(spec.lport) || spec.lport < 1 || spec.lport > 65535) return null
  return 'user=' + spec.user + ',addr=' + spec.addr + ',host=' + spec.addr + ',laddr=' + spec.laddr + ',lport=' + spec.lport
}

/** The port the first query names, before the answer has told which ports sshd listens on. */
export const SSHD_DISCOVERY_PORT = 22

export interface SshdProbePlanInput {
  readonly loginUser: string
  /** The pinned sources, each an exact host (`a.b.c.d/32` or `x::y/128`). */
  readonly fromCidrs: readonly string[]
  /** Every address of this machine a connection could arrive on. */
  readonly localAddresses: readonly string[]
  /** The ports from a first answer, or null before there is one. */
  readonly listenPorts: readonly number[] | null
}

/**
 * Which connections have to be asked about. Before the ports are known: one
 * query, whose answer names them (the port settings are global, no Match block
 * changes them). After that: EVERY pinned source, on EVERY local address, on
 * EVERY port. Returns null when a list is empty or a value cannot be carried;
 * the caller must then refuse, not ask about less.
 */
export function planSshdProbes(input: SshdProbePlanInput): SshdConnectionSpec[] | null {
  const sources = input.fromCidrs.map((cidr) => cidr.replace(/\/(32|128)$/, ''))
  const ports = input.listenPorts === null ? [SSHD_DISCOVERY_PORT] : input.listenPorts
  if (sources.length === 0 || input.localAddresses.length === 0 || ports.length === 0) return null
  const specs: SshdConnectionSpec[] = []
  for (const addr of sources) {
    for (const laddr of input.localAddresses) {
      for (const lport of ports) {
        const spec = { user: input.loginUser, addr, laddr, lport }
        if (formatSshdConnectionSpec(spec) === null) return null
        specs.push(spec)
      }
    }
  }
  return input.listenPorts === null ? specs.slice(0, 1) : specs
}

// A key login as root is possible with these; `no` and anything unknown is a refusal.
// `forced-commands-only` is enough because the support line always has a command.
const ROOT_LOGIN_BY_KEY = new Set(['yes', 'without-password', 'prohibit-password', 'forced-commands-only'])

export type SupportKeysFileName = 'authorized_keys' | 'authorized_keys2'

/** The login account as sshd sees it: the name and the home directory from the user database. */
export interface SshdLoginAccount {
  readonly user: string
  readonly home: string
}

// A home this can build paths from: absolute, plain segments, no `.` or `..`, no slash at the end.
const ACCOUNT_HOME = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/

/**
 * One `authorizedkeysfile` entry as the path sshd opens for this account, or
 * null when it cannot be told. sshd replaces `%h` with the home, `%u` with the
 * user name and `%%` with a percent sign, and reads a path that is not
 * absolute relative to the home. Any other token (`%U` too) is unknown here,
 * and unknown is null. Nothing is tidied up: a path with a `.`, a `..` or a
 * doubled slash in it comes back as written, and then does not equal the one
 * spelling the caller compares with.
 */
export function expandKeysFileEntry(entry: string, account: SshdLoginAccount): string | null {
  if (!LOGIN_USER.test(account.user)) return null
  if (account.home !== '/' && !ACCOUNT_HOME.test(account.home)) return null
  let out = ''
  for (let i = 0; i < entry.length; i++) {
    if (entry[i] !== '%') {
      out += entry[i]
      continue
    }
    const token = entry[++i]
    if (token === '%') out += '%'
    else if (token === 'h') out += account.home
    else if (token === 'u') out += account.user
    else return null
  }
  if (out.length === 0) return null
  return out.startsWith('/') ? out : (account.home === '/' ? '' : account.home) + '/' + out
}

/**
 * Which files under the login user's `.ssh` sshd reads keys from, or null when
 * the setting names anything else. The comparison is on the EXPANDED path, so
 * the relative, the `%h` and the absolute spelling of the same file are the
 * same file, and a shared directory keyed by `%u` is a refusal (it expands to
 * a path outside the home). `authorized_keys` must be among them (the line
 * goes there); `authorized_keys2` may be (no line is ever written into it,
 * but sshd reads it, so a removal has to clean it too). A third file is not
 * accepted: a copy of a pinned key in a file the removal does not clean would
 * survive the removal.
 */
export function supportKeysFiles(entries: readonly string[], account: SshdLoginAccount): SupportKeysFileName[] | null {
  const dir = (account.home === '/' ? '' : account.home) + '/.ssh/'
  let first = false
  let second = false
  for (const entry of entries) {
    const path = expandKeysFileEntry(entry, account)
    if (path === dir + 'authorized_keys') first = true
    else if (path === dir + 'authorized_keys2') second = true
    else return null
  }
  if (!first) return null
  return second ? ['authorized_keys', 'authorized_keys2'] : ['authorized_keys']
}

/** What sshd answered for one planned connection. */
export interface SshdProbeAnswer {
  readonly spec: SshdConnectionSpec
  /** The standard output of `sshd -T -C <spec>`, or null when it could not be run or did not exit with 0. */
  readonly text: string | null
}

export interface SshdAssessmentInput {
  /** Output of the version command, or null when it could not be run. */
  readonly versionText: string | null
  /** True when the install user, whose authorized_keys gets the line, is root. */
  readonly loginIsRoot: boolean
  readonly loginUser: string
  /** The login user's home directory from the user database: what sshd reads `%h` and a relative keys file against. */
  readonly loginHome: string
  readonly fromCidrs: readonly string[]
  /** The interface addresses a connection could arrive on. The addresses sshd listens on are added here, from the answers. */
  readonly localAddresses: readonly string[]
  /** One answer per planned connection. More than planned is fine; fewer is a refusal. */
  readonly answers: readonly SshdProbeAnswer[]
}

export type SshdAssessment =
  | { readonly ok: true; readonly version: SshdVersion; readonly keysFiles: readonly SupportKeysFileName[] }
  | { readonly ok: false; readonly problem: SshdProblem; readonly version: SshdVersion | null }

/**
 * May a support line be written for this sshd? The checks run in this order,
 * each over EVERY answer, and the first failing one is the result:
 *
 *   version unknown            no line: its options cannot be trusted to mean anything
 *   older than 8.4             no line: verify-required is unknown there and sshd
 *                              drops the whole line (measured)
 *   configuration unknown      no line. An answer that is missing, empty or
 *                              unreadable; answers that disagree about the
 *                              ports or the listen addresses; a planned
 *                              connection nobody asked about (the plan is
 *                              recomputed here, with the listen addresses)
 *   UseDNS is on               no line: `Match Host` would then be matched
 *                              against a name this machine cannot know here
 *   root login by key is off   no line when the login user is root: it would be dead
 *   tunnels are permitted      NO LINE. `restrict` does not refuse a tunnel
 *                              device on every sshd build (measured), no key
 *                              option forbids one, and on a tunnel-only
 *                              connection the bound command never runs. Only
 *                              the exact `permittunnel no` is accepted, for
 *                              every planned connection.
 *   another keys file          no line unless, for EVERY connection, sshd
 *                              reads keys from the login user's
 *                              `.ssh/authorized_keys` and from nowhere else
 *                              but `.ssh/authorized_keys2`, and the answers
 *                              agree on which of the two
 *   another key source         no line when a keys command or a user CA file
 *                              is set: a key granted through those is out of
 *                              reach of a removal
 */
export function assessSshd(input: SshdAssessmentInput): SshdAssessment {
  const version = input.versionText === null ? null : parseSshdVersion(input.versionText)
  if (version === null) return { ok: false, problem: 'sshd_version_unknown', version }
  if (!sshdAtLeast(version, SUPPORT_MIN_SSHD)) return { ok: false, problem: 'sshd_too_old', version }
  const refuse = (problem: SshdProblem): SshdAssessment => ({ ok: false, problem, version })

  const configs: SshdEffectiveConfig[] = []
  for (const answer of input.answers) {
    const config = answer.text === null ? null : parseSshdEffectiveConfig(answer.text)
    if (config === null) return refuse('sshd_config_unknown')
    configs.push(config)
  }
  if (configs.length === 0) return refuse('sshd_config_unknown')
  const ports = configs[0].listenPorts
  if (!configs.every((c) => c.listenPorts.join(',') === ports.join(','))) return refuse('sshd_config_unknown')
  const listening = configs[0].listenAddresses
  if (!configs.every((c) => c.listenAddresses.join(',') === listening.join(','))) return refuse('sshd_config_unknown')
  const planned = planSshdProbes({
    loginUser: input.loginUser,
    fromCidrs: input.fromCidrs,
    localAddresses: probeLocalAddresses(input.localAddresses, listening),
    listenPorts: ports,
  })
  if (planned === null) return refuse('sshd_config_unknown')
  const asked = new Set(input.answers.map((a) => formatSshdConnectionSpec(a.spec)))
  if (!planned.every((spec) => asked.has(formatSshdConnectionSpec(spec)))) return refuse('sshd_config_unknown')

  if (!configs.every((c) => c.useDns === 'no')) return refuse('sshd_usedns_enabled')
  if (input.loginIsRoot && !configs.every((c) => ROOT_LOGIN_BY_KEY.has(c.permitRootLogin))) return refuse('root_login_disabled')
  if (!configs.every((c) => c.permitTunnel === 'no')) return refuse('tunnel_permitted')
  const account = { user: input.loginUser, home: input.loginHome }
  const keysFiles = supportKeysFiles(configs[0].authorizedKeysFiles, account)
  if (keysFiles === null) return refuse('authorized_keys_path_unsupported')
  for (const c of configs) {
    // Another spelling of the same files under a Match block is the same answer; another set of files is not.
    if (supportKeysFiles(c.authorizedKeysFiles, account)?.join(' ') !== keysFiles.join(' ')) {
      return refuse('authorized_keys_path_unsupported')
    }
  }
  if (!configs.every((c) => c.authorizedKeysCommand === 'none' && c.trustedUserCaKeys === 'none')) {
    return refuse('other_key_source')
  }
  return { ok: true, version, keysFiles }
}
