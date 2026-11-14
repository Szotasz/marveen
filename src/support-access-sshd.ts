// Support access: what the machine's sshd would do with a support line, as
// pure functions over text that sshd itself printed.
//
// The caller runs two commands and hands their output here; nothing in this
// file starts a process, reads a file or looks at the environment:
//   - the version text: `sshd -V`, or the usage text sshd prints for an unknown
//     flag. Measured on OpenSSH 7.6 to 10.0: 9.6 and 10.0 answer `-V` with the
//     version line, older ones say "unknown option -- V" and print the same
//     `OpenSSH_<major>.<minor>` line inside the usage text.
//   - the effective configuration: `sshd -T`. Measured: as a non-root user it
//     exits with "no hostkeys available" unless it gets a host key of its own
//     through `-h`; with one it prints the same lines.
//
// EVERY ANSWER FAILS CLOSED. A setting that is not in the text is unknown, and
// unknown is a refusal: the support line is never written on a guess.
import { SUPPORT_MIN_SSHD, sshdAtLeast, type SshdVersion } from './support-access-line.js'

/** Why support access cannot be enabled on this sshd. */
export type SshdProblem =
  | 'sshd_version_unknown'
  | 'sshd_too_old'
  | 'sshd_config_unknown'
  | 'root_login_disabled'
  | 'tunnel_permitted'
  | 'authorized_keys_path_unsupported'

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

/** The settings of `sshd -T` that decide whether a support line is safe here. */
export interface SshdEffectiveConfig {
  /** `permitrootlogin`, lower case, as printed (`without-password`, `no`, ...). */
  readonly permitRootLogin: string
  /** `permittunnel`, lower case, as printed (`no`, `yes`, `point-to-point`, `ethernet`). */
  readonly permitTunnel: string
  /** `authorizedkeysfile` entries, as printed (relative to the home, or absolute, or with tokens). */
  readonly authorizedKeysFiles: readonly string[]
}

const SETTING_VALUE = /^[A-Za-z0-9._%/-]+$/

/**
 * Read the three settings out of `sshd -T` output. Returns null unless each of
 * them appears EXACTLY once with a plain value: a missing line, a repeated line
 * with another value, or a value with unexpected characters means the text is
 * not what sshd prints, and nothing is concluded from it.
 */
export function parseSshdEffectiveConfig(text: string): SshdEffectiveConfig | null {
  const seen = new Map<string, string[]>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    if (key !== 'permitrootlogin' && key !== 'permittunnel' && key !== 'authorizedkeysfile') continue
    if (seen.has(key)) return null
    const values = line
      .slice(space + 1)
      .split(/\s+/)
      .filter((v) => v.length > 0)
    if (values.length === 0 || !values.every((v) => SETTING_VALUE.test(v))) return null
    seen.set(key, values)
  }
  const root = seen.get('permitrootlogin')
  const tunnel = seen.get('permittunnel')
  const files = seen.get('authorizedkeysfile')
  if (root === undefined || tunnel === undefined || files === undefined) return null
  if (root.length !== 1 || tunnel.length !== 1) return null
  return { permitRootLogin: root[0].toLowerCase(), permitTunnel: tunnel[0].toLowerCase(), authorizedKeysFiles: files }
}

// A key login as root is possible with these; `no` and anything unknown is a refusal.
// `forced-commands-only` is enough because the support line always has a command.
const ROOT_LOGIN_BY_KEY = new Set(['yes', 'without-password', 'prohibit-password', 'forced-commands-only'])

/**
 * The spellings under which sshd names the one file the line goes into:
 * relative to the login user's home, or with the home token. An absolute path
 * or a per-user directory elsewhere is not accepted, even if it happens to
 * point at the same file.
 */
export const SUPPORT_AUTHORIZED_KEYS_ENTRIES: readonly string[] = ['.ssh/authorized_keys', '%h/.ssh/authorized_keys']

export interface SshdAssessmentInput {
  /** Output of the version command, or null when it could not be run. */
  readonly versionText: string | null
  /** Output of `sshd -T`, or null when it could not be run. */
  readonly configText: string | null
  /** True when the install user, whose authorized_keys gets the line, is root. */
  readonly loginIsRoot: boolean
}

export type SshdAssessment =
  | { readonly ok: true; readonly version: SshdVersion }
  | { readonly ok: false; readonly problem: SshdProblem; readonly version: SshdVersion | null }

/**
 * May a support line be written for this sshd? The checks run in this order
 * and the first failing one is the answer:
 *
 *   version unknown            no line: its options cannot be trusted to mean anything
 *   older than 8.4             no line: verify-required is unknown there and sshd
 *                              drops the whole line (measured)
 *   configuration unknown      no line
 *   root login by key is off   no line when the login user is root: it would be dead
 *   tunnels are permitted      NO LINE. `restrict` does not refuse a tunnel
 *                              device on every sshd build (measured), no key
 *                              option forbids one, and on a tunnel-only
 *                              connection the bound command never runs. Only
 *                              `permittunnel no` is accepted.
 *   another keys file          no line unless sshd reads `.ssh/authorized_keys`
 *                              of the login user: a line sshd never reads is dead,
 *                              and we do not write into paths we did not plan for
 */
export function assessSshd(input: SshdAssessmentInput): SshdAssessment {
  const version = input.versionText === null ? null : parseSshdVersion(input.versionText)
  if (version === null) return { ok: false, problem: 'sshd_version_unknown', version }
  if (!sshdAtLeast(version, SUPPORT_MIN_SSHD)) return { ok: false, problem: 'sshd_too_old', version }
  const config = input.configText === null ? null : parseSshdEffectiveConfig(input.configText)
  if (config === null) return { ok: false, problem: 'sshd_config_unknown', version }
  if (input.loginIsRoot && !ROOT_LOGIN_BY_KEY.has(config.permitRootLogin)) {
    return { ok: false, problem: 'root_login_disabled', version }
  }
  if (config.permitTunnel !== 'no') return { ok: false, problem: 'tunnel_permitted', version }
  if (!config.authorizedKeysFiles.some((f) => SUPPORT_AUTHORIZED_KEYS_ENTRIES.includes(f))) {
    return { ok: false, problem: 'authorized_keys_path_unsupported', version }
  }
  return { ok: true, version }
}
