// Support access: asking the machine's own sshd, for real.
//
// support-access-sshd.ts decides from text; this file fetches the text. It
// runs `sshd -V` once and `sshd -T -C <connection>` once for every connection
// the plan names, and hands the answers to assessSshd. It changes nothing on
// the machine: `sshd -T` only reads the configuration and prints it.
//
// - Programs are started WITHOUT a shell, by absolute path, with a fixed
//   argument list. Nothing a request says reaches an argument: the user comes
//   from the process, the addresses from the pins and from the interfaces.
// - A non-root user cannot read the system host keys, and sshd then refuses to
//   answer ("no hostkeys available", measured). So a throwaway host key is made
//   in a private directory and passed with `-h`; the directory is removed
//   afterwards, also when something fails. The key is never used for a
//   connection: sshd only needs one to be present.
// - Every failure is a refusal. A program that is missing, exits with anything
//   but 0, or runs into the time limit gives no text, and no text means
//   "configuration unknown" in the assessment.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { isIP } from 'node:net'
import { networkInterfaces, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  assessSshd,
  formatSshdConnectionSpec,
  parseSshdEffectiveConfig,
  planSshdProbes,
  type SshdAssessment,
  type SshdConnectionSpec,
  type SshdProbeAnswer,
} from './support-access-sshd.js'

export const SSHD_PROGRAM = '/usr/sbin/sshd'
export const SSH_KEYGEN_PROGRAM = '/usr/bin/ssh-keygen'
/** Each program gets this long. `sshd -T` answers in milliseconds; a hang is a refusal. */
export const SSHD_PROBE_TIMEOUT_MS = 5_000
/** More connections than this are not asked about: the answer is a refusal. */
export const SSHD_PROBE_MAX_QUERIES = 64

export interface ProgramResult {
  /** The exit code, or null when the program could not be started, was killed, or ran out of time. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface LocalInterfaceAddress {
  readonly address: string
  /** True for a loopback interface. */
  readonly internal: boolean
}

export interface SshdProbeDeps {
  /** Start a program without a shell. Never rejects: a failure is a result with code null. */
  readonly run: (file: string, args: readonly string[], timeoutMs: number) => Promise<ProgramResult>
  /** The login user of this process: the user whose authorized_keys gets the line. */
  readonly user: { readonly name: string; readonly isRoot: boolean }
  /** Every address of every network interface of this machine. */
  readonly interfaceAddresses: () => readonly LocalInterfaceAddress[]
  /** Make a new private directory (0700) and return its path. */
  readonly makePrivateDir: () => string
  /** Remove a directory made by makePrivateDir, with what is in it. Must not throw. */
  readonly removeDir: (path: string) => void
}

/**
 * The addresses a connection from a pinned source could arrive on: every
 * interface address except loopback and link-local ones. A pinned source is a
 * routable address of another machine; a packet from it cannot have a loopback
 * or a link-local destination. Sorted and without repeats, so the plan is the
 * same on every run.
 */
export function reachableLocalAddresses(all: readonly LocalInterfaceAddress[]): string[] {
  const out = new Set<string>()
  for (const entry of all) {
    if (entry.internal) continue
    const address = entry.address.toLowerCase()
    const family = isIP(address)
    if (family === 0 || address.includes('%')) continue
    if (family === 4 && (address.startsWith('169.254.') || address.startsWith('127.'))) continue
    if (family === 6 && (/^fe[89ab]/.test(address) || address === '::1')) continue
    out.add(address)
  }
  return [...out].sort()
}

/**
 * Ask sshd about every connection a support login could be, and assess the
 * answers. Resolves with a refusal for anything that goes wrong; it does not
 * throw for what a program or the machine does.
 */
export async function probeSshd(input: { readonly fromCidrs: readonly string[] }, deps: SshdProbeDeps): Promise<SshdAssessment> {
  const version = await deps.run(SSHD_PROGRAM, ['-V'], SSHD_PROBE_TIMEOUT_MS)
  // Older builds answer `-V` with "unknown option" and the usage text, exit code 1, the version line in it (measured).
  const versionText = version.code === null ? null : version.stdout + '\n' + version.stderr
  const localAddresses = reachableLocalAddresses(deps.interfaceAddresses())
  const base = {
    versionText,
    loginIsRoot: deps.user.isRoot,
    loginUser: deps.user.name,
    fromCidrs: input.fromCidrs,
    localAddresses,
  }
  const refused = (answers: readonly SshdProbeAnswer[]): SshdAssessment => assessSshd({ ...base, answers })
  // No sshd to ask: nothing else is started.
  if (versionText === null) return refused([])

  let keyDir: string | null = null
  try {
    const hostKeyArgs: string[] = []
    if (!deps.user.isRoot) {
      keyDir = deps.makePrivateDir()
      const keyPath = keyDir + '/probe_host_key'
      const made = await deps.run(SSH_KEYGEN_PROGRAM, ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], SSHD_PROBE_TIMEOUT_MS)
      if (made.code !== 0) return refused([])
      hostKeyArgs.push('-h', keyPath)
    }
    const ask = async (spec: SshdConnectionSpec): Promise<SshdProbeAnswer> => {
      const connection = formatSshdConnectionSpec(spec)
      if (connection === null) return { spec, text: null }
      const out = await deps.run(SSHD_PROGRAM, ['-T', ...hostKeyArgs, '-C', connection], SSHD_PROBE_TIMEOUT_MS)
      return { spec, text: out.code === 0 ? out.stdout : null }
    }

    const discovery = planSshdProbes({ ...base, listenPorts: null })
    if (discovery === null) return refused([])
    const first = await ask(discovery[0])
    const firstConfig = first.text === null ? null : parseSshdEffectiveConfig(first.text)
    if (firstConfig === null) return refused([first])

    const plan = planSshdProbes({ ...base, listenPorts: firstConfig.listenPorts })
    if (plan === null || plan.length > SSHD_PROBE_MAX_QUERIES) return refused([])
    const answers: SshdProbeAnswer[] = []
    for (const spec of plan) {
      answers.push(formatSshdConnectionSpec(spec) === formatSshdConnectionSpec(first.spec) ? first : await ask(spec))
    }
    return assessSshd({ ...base, answers })
  } finally {
    if (keyDir !== null) deps.removeDir(keyDir)
  }
}

/**
 * The real thing behind SshdProbeDeps. Programs run without a shell, with a
 * fixed PATH and the C locale (so what they print is what the parsers were
 * written against), and are killed at the time limit.
 */
export function createSshdProbeDeps(): SshdProbeDeps {
  return {
    run: (file, args, timeoutMs) =>
      new Promise<ProgramResult>((resolve) => {
        execFile(
          file,
          [...args],
          {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
          },
          (err, stdout, stderr) => {
            if (err === null) resolve({ code: 0, stdout, stderr })
            else resolve({ code: typeof err.code === 'number' && err.killed !== true ? err.code : null, stdout, stderr })
          },
        )
      }),
    user: { name: userInfo().username, isRoot: process.getuid?.() === 0 },
    interfaceAddresses: () =>
      Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => ({ address: a.address, internal: a.internal }))),
    makePrivateDir: () => mkdtempSync(join(tmpdir(), 'marveen-sshd-probe-')),
    removeDir: (path) => {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        /* a leftover empty directory in the temp folder is not worth failing for */
      }
    },
  }
}
