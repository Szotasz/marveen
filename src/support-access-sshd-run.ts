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
// - AS ANOTHER USER THAN ROOT the answers count only with the proof of
//   support-access-sshd-nonroot.ts. Such a user cannot read the system host
//   keys, and sshd then will not answer ("no hostkeys available", measured on
//   8.9 to 10.0), so a throwaway host key is made in a private directory and
//   passed with `-h`; the directory is removed afterwards, also on failure. The
//   key is never used for a connection. sshd is also asked once with
//   `-f /etc/ssh/sshd_config`: the answer must be the same, or the probe does
//   not know which file the daemon reads. The daemon check is Linux only for
//   now; elsewhere (macOS, not measured yet) it refuses.
// - Every failure is a refusal, never a rejection. A program that is missing,
//   exits with anything but 0, or runs into the time limit gives no text, and
//   no text means "configuration unknown" in the assessment; anything that
//   throws on the way is the same answer.
import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { networkInterfaces, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  checkDaemon,
  pidfileOf,
  SSHD_MAIN_CONFIG,
  walkIncludes,
  type DaemonFs,
  type NonRootProblem,
} from './support-access-sshd-nonroot.js'
import {
  assessSshd,
  formatSshdConnectionSpec,
  isArrivalAddress,
  parseSshdEffectiveConfig,
  planSshdProbes,
  probeLocalAddresses,
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
  /** The login user of this process: the user whose authorized_keys gets the line. The home is the one in the
   * user database (what sshd uses), not the HOME of the environment. */
  readonly user: { readonly name: string; readonly isRoot: boolean; readonly home: string }
  /** Every address of every network interface of this machine. */
  readonly interfaceAddresses: () => readonly LocalInterfaceAddress[]
  /** Make a new private directory (0700) and return its path. May throw: that is a refusal. */
  readonly makePrivateDir: () => string
  /** Remove a directory made by makePrivateDir, with what is in it. Must not throw. */
  readonly removeDir: (path: string) => void
  /** Read the configuration files, the pidfile and /proc, for the non-root proof. */
  readonly fs: DaemonFs
  /** process.platform: the daemon check knows `linux` only. */
  readonly platform: string
}

/**
 * The interface addresses a connection from a pinned source could arrive on:
 * every address of every interface that is not a loopback interface and that
 * isArrivalAddress accepts (no loopback, link-local or zoned address). Sorted
 * and without repeats, so the plan is the same on every run.
 */
export function reachableLocalAddresses(all: readonly LocalInterfaceAddress[]): string[] {
  const out = new Set<string>()
  for (const entry of all) {
    if (entry.internal) continue
    if (isArrivalAddress(entry.address)) out.add(entry.address.toLowerCase())
  }
  return [...out].sort()
}

/**
 * Ask sshd about every connection a support login could be, and assess the
 * answers. Resolves with a refusal for anything that goes wrong, also for
 * something that throws on the way (the interface list, a dependency): it
 * never rejects.
 */
export async function probeSshd(input: { readonly fromCidrs: readonly string[] }, deps: SshdProbeDeps): Promise<SshdAssessment> {
  try {
    return await askSshd(input, deps)
  } catch {
    return { ok: false, problem: 'sshd_config_unknown', version: null }
  }
}

async function askSshd(input: { readonly fromCidrs: readonly string[] }, deps: SshdProbeDeps): Promise<SshdAssessment> {
  const version = await deps.run(SSHD_PROGRAM, ['-V'], SSHD_PROBE_TIMEOUT_MS)
  // Older builds answer `-V` with "unknown option" and the usage text, exit code 1, the version line in it (measured).
  const versionText = version.code === null ? null : version.stdout + '\n' + version.stderr
  const base = {
    versionText,
    loginIsRoot: deps.user.isRoot,
    loginUser: deps.user.name,
    loginHome: deps.user.home,
    fromCidrs: input.fromCidrs,
  }
  // No sshd to ask: nothing else is started, and the assessment says why.
  if (versionText === null) return assessSshd({ ...base, localAddresses: [], answers: [] })
  if (deps.user.isRoot) return askAll(base, [], deps, null)
  let keyDir: string | null = null
  try {
    keyDir = deps.makePrivateDir()
    const keyPath = join(keyDir, 'probe_host_key')
    const made = await deps.run(SSH_KEYGEN_PROGRAM, ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], SSHD_PROBE_TIMEOUT_MS)
    if (made.code !== 0) return assessSshd({ ...base, localAddresses: [], answers: [], nonRootProof: { ok: false, problem: 'sshd_config_unknown' } })
    return await askAll(base, ['-h', keyPath], deps, keyPath)
  } finally {
    if (keyDir !== null) deps.removeDir(keyDir)
  }
}

type ProbeBase = Omit<Parameters<typeof assessSshd>[0], 'localAddresses' | 'answers' | 'nonRootProof'>

async function askAll(base: ProbeBase, hostKeyArgs: readonly string[], deps: SshdProbeDeps, keyPath: string | null): Promise<SshdAssessment> {
  const localAddresses = reachableLocalAddresses(deps.interfaceAddresses())
  let nonRootProof: { ok: true } | { ok: false; problem: NonRootProblem } | undefined
  const refused = (answers: readonly SshdProbeAnswer[]): SshdAssessment => assessSshd({ ...base, localAddresses, answers, nonRootProof })
  const ask = async (spec: SshdConnectionSpec, extra: readonly string[] = []): Promise<SshdProbeAnswer> => {
    const connection = formatSshdConnectionSpec(spec)
    if (connection === null) return { spec, text: null }
    const out = await deps.run(SSHD_PROGRAM, ['-T', ...hostKeyArgs, ...extra, '-C', connection], SSHD_PROBE_TIMEOUT_MS)
    return { spec, text: out.code === 0 ? out.stdout : null }
  }

  const discovery = planSshdProbes({ ...base, localAddresses, listenPorts: null })
  if (discovery === null) return refused([])
  const first = await ask(discovery[0])
  const firstConfig = first.text === null ? null : parseSshdEffectiveConfig(first.text)
  if (firstConfig === null) return refused([first])

  if (keyPath !== null) {
    // The non-root proof: sshd reads the main file this walks from, every Include is visible, the daemon is a
    // plain listener and nothing is newer than its last reload. A failed proof asks nothing more.
    const named = await ask(discovery[0], ['-f', SSHD_MAIN_CONFIG])
    if (named.text !== first.text) {
      nonRootProof = { ok: false, problem: 'sshd_config_unknown' }
      return refused([])
    }
    const walk = walkIncludes(deps.fs)
    const daemon = !walk.ok
      ? walk
      : deps.platform === 'linux'
        ? checkDaemon(deps.fs, pidfileOf(first.text as string), walk.files)
        : { ok: false as const, problem: 'sshd_daemon_unknown' as const }
    nonRootProof = daemon.ok ? { ok: true } : { ok: false, problem: daemon.problem }
    if (!nonRootProof.ok) return refused([])
  }

  // The addresses sshd is told to listen on are asked about too; the assessment adds them the same way.
  const plan = planSshdProbes({
    ...base,
    localAddresses: probeLocalAddresses(localAddresses, firstConfig.listenAddresses),
    listenPorts: firstConfig.listenPorts,
  })
  if (plan === null || plan.length > SSHD_PROBE_MAX_QUERIES) return refused([])
  const answers: SshdProbeAnswer[] = []
  for (const spec of plan) {
    answers.push(formatSshdConnectionSpec(spec) === formatSshdConnectionSpec(first.spec) ? first : await ask(spec))
  }
  return refused(answers)
}

/**
 * The login user of this process as sshd sees it: the name and the home from
 * the user database. NOT the HOME of the environment (os.homedir follows HOME,
 * userInfo does not): a HOME kept under sudo or left stale in a service must not
 * point the status at another directory than the one sshd reads (Dani's review
 * of #2765, S1). Every support path that needs the home takes it from here.
 */
export function currentLoginUser(): SshdProbeDeps['user'] {
  const info = userInfo()
  return { name: info.username, isRoot: process.getuid?.() === 0, home: info.homedir }
}

/**
 * The real thing behind SshdProbeDeps. Programs run without a shell, with a
 * fixed PATH and the C locale (so what they print is what the parsers were
 * written against), and are killed at the time limit.
 */
/** Read a file following a link (as sshd does), with the cap, its mtime in nanoseconds; never throws. */
function readCapped(path: string, max: number): ReturnType<DaemonFs['readText']> {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  try {
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile()) return { kind: 'unreadable' }
    const buf = Buffer.alloc(max + 1)
    let n = 0
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, n)
      if (got === 0) break
      n += got
      if (n > max) return { kind: 'unreadable' }
    }
    return { kind: 'ok', text: buf.subarray(0, n).toString('latin1'), ctimeNs: st.ctimeNs }
  } catch {
    return { kind: 'unreadable' }
  } finally {
    closeSync(fd)
  }
}

/** The real file access of the non-root proof. */
export const realNonRootFs: DaemonFs = {
  readText: readCapped,
  listDir: (path) => {
    try {
      const names = readdirSync(path)
      return { kind: 'ok', names, ctimeNs: statSync(path, { bigint: true }).ctimeNs }
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unlistable' }
    }
  },
  ctimeNs: (path) => {
    try {
      return statSync(path, { bigint: true }).ctimeNs
    } catch {
      return null
    }
  },
}

export function createSshdProbeDeps(user: SshdProbeDeps['user'] = currentLoginUser()): SshdProbeDeps {
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
    user,
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
    fs: realNonRootFs,
    platform: process.platform,
  }
}
