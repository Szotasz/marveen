// Support standby: the command line of the common routine, and the entry of
// its single self-contained file (scripts/support-standby.mjs, made from this
// file by scripts/build-support-standby.mjs).
//
// WHY ONE SELF-CONTAINED FILE: the most common way an install breaks is a
// half-finished update or build. The routine must still run then, so the
// shipped file imports nothing from the compiled tree and needs no
// node_modules: only node's own modules. The dashboard imports the same
// source modules directly; a test proves both give byte-identical lines.
//
// Subcommands: `status` (looks, never writes, needs no code); `verify-kit`
// (is the kit on this machine what its manifest says; looks, never writes;
// the sh launcher asks it before anything else); `install-kit` (writes the
// kit of this release from the install tree; the installer and the updater
// call it, the dashboard never does); `enable --consent <n>` (the one-time
// code on standard input; runs only as the kit's copy, started by the
// loader); `disable` (also from the tree, also without a kit); `consent-text
// --consent <n>` (the approved consent text of that version; reads nothing).
import { randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORT_FROM_CIDRS, SUPPORT_KEYS } from './support-access-pins.js'
import { createSshdProbeDeps, currentLoginUser, probeSshd } from './support-access-sshd-run.js'
import { formatSupportStatus, supportStatus, type SupportStatusDeps } from './support-standby.js'
import { KitError, verifyKit, type KitVerdict, type WriteKitResult } from './support-kit.js'
import { installKit, SUPPORT_DIR_IN_HOME } from './support-kit-install.js'
import { readSupportToken } from './support-access-token.js'
import { readGroupRecord } from './support-group-record.js'
import { createHttpsRedeemTransport } from './support-access-redeem.js'
import { readOwnHostKey, readRootOwnedPub } from './support-access-hostkey.js'
import { disableSupportStandby, enableSupportStandby, type StandbyDeps } from './support-standby-enable.js'
import { supportConsentText } from './support-consent-text.js'

// What the dashboard and the tests use from the same file the command line runs.
export { buildSupportGrantLines, buildSupportLine } from './support-access-line.js'
export { grantSupportLines, reconcileSupportLinesOnDisk, revokeSupportLines } from './support-access-fs.js'
export { SUPPORT_ROUTINE_MIN_NODE_MAJOR, formatSupportStatus, supportStatus } from './support-standby.js'

export const SUPPORT_CLI_USAGE =
  'usage: support-standby.mjs status\n' +
  '       support-standby.mjs verify-kit\n' +
  '       support-standby.mjs install-kit --install-root <path> --node <path> --release <commit>\n' +
  '       support-standby.mjs enable --consent <version>   (the code on standard input)\n' +
  '       support-standby.mjs disable\n' +
  '       support-standby.mjs consent-text --consent <version>\n'

/** No support code is longer than this; standard input is not read past it. */
export const SUPPORT_CODE_MAX_INPUT = 64

/**
 * Is this run the kit's copy, started by the loader? The loader imports the
 * file's bytes from a data: URL, so this module's own URL says so; a direct
 * start of any file says file:. `moduleUrl` is for tests.
 */
export function startedFromKit(moduleUrl: string = import.meta.url): boolean {
  try {
    return new URL(moduleUrl).protocol === 'data:'
  } catch {
    return false
  }
}

export interface InstallKitArgs {
  readonly installRoot: string
  readonly nodePath: string
  readonly release: string
}

const INSTALL_KIT_FLAGS: Record<string, keyof InstallKitArgs> = {
  '--install-root': 'installRoot',
  '--node': 'nodePath',
  '--release': 'release',
}

/** The arguments of `install-kit`: each of the three flags exactly once, each with a value; nothing else. */
export function parseInstallKitArgs(argv: readonly string[]): InstallKitArgs | null {
  if (argv.length !== 6) return null
  const out: Partial<Record<keyof InstallKitArgs, string>> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = Object.prototype.hasOwnProperty.call(INSTALL_KIT_FLAGS, argv[i]) ? INSTALL_KIT_FLAGS[argv[i]] : undefined
    if (key === undefined || out[key] !== undefined || argv[i + 1].length === 0) return null
    out[key] = argv[i + 1]
  }
  return out.installRoot !== undefined && out.nodePath !== undefined && out.release !== undefined
    ? { installRoot: out.installRoot, nodePath: out.nodePath, release: out.release }
    : null
}

/**
 * The real `install-kit`: the support folder is under the home of the login
 * user from the user database; no variable moves it. `account` is for tests.
 */
export function createInstallKit(account = currentLoginUser()): (args: InstallKitArgs) => Promise<WriteKitResult> {
  return (args) => installKit({ ...args, supportDir: join(account.home, SUPPORT_DIR_IN_HOME) })
}

/**
 * The real dependencies of `status` on this machine. The probe and the keys
 * files use ONE account, the login user from the user database, so the report
 * never describes two homes. HOME does not move it, and neither does the test
 * seam of the write paths. `account` is for tests.
 */
export function createStatusDeps(account = currentLoginUser()): SupportStatusDeps {
  const sshDir = join(account.home, '.ssh')
  return {
    nodeVersion: process.version,
    pins: { keys: SUPPORT_KEYS, fromCidrs: SUPPORT_FROM_CIDRS },
    probeSshd: (fromCidrs) => probeSshd({ fromCidrs }, createSshdProbeDeps(account)),
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    readKeysFile: (name) => {
      try {
        return readFileSync(join(sshDir, name), 'latin1')
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
      }
    },
    readStandbyFiles: () => {
      const supportDir = join(account.home, SUPPORT_DIR_IN_HOME)
      const token = readSupportToken(supportDir)
      const record = readGroupRecord(supportDir)
      return {
        token: token.kind === 'ok' ? 'ok' : token.kind,
        record: record.kind === 'ok' ? { kind: 'ok', keys: record.record.keys.map((k) => k.name) } : record,
      }
    },
  }
}

/** The real dependencies of `enable` and `disable`: one account, from the user database. `account` is for tests. */
export function createStandbyDeps(account = currentLoginUser(), moduleUrl: string = import.meta.url): StandbyDeps {
  return {
    supportDir: join(account.home, SUPPORT_DIR_IN_HOME),
    sshDir: join(account.home, '.ssh'),
    pins: { keys: SUPPORT_KEYS, fromCidrs: SUPPORT_FROM_CIDRS },
    probeSshd: (fromCidrs) => probeSshd({ fromCidrs }, createSshdProbeDeps(account)),
    readHostKey: (sshd) => readOwnHostKey(sshd, { run: createSshdProbeDeps(account).run, readRootPub: readRootOwnedPub }),
    redeemTransport: createHttpsRedeemTransport(),
    now: () => new Date(),
    newGrantId: () => randomUUID(),
    startedFromKit: startedFromKit(moduleUrl),
  }
}

/** Standard input, at most `max` bytes; more is an error, nothing is read past it. */
export async function readStdinCapped(max: number, stdin: AsyncIterable<Buffer | string> = process.stdin): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stdin) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > max) return null
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface CliIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export interface CliDeps {
  readonly status: () => SupportStatusDeps
  readonly installKit: (args: InstallKitArgs) => Promise<WriteKitResult>
  /** The verdict on the kit of the login user (SUPPORTMENTOUT1114: the launcher's first question). Absent: `verify-kit` is not offered. */
  readonly verifyKit?: () => KitVerdict
  readonly standby: () => StandbyDeps
  /** The one-time code from standard input, or null when there was more than a code can be. */
  readonly readCode: () => Promise<string | null>
}

/**
 * The real `verify-kit`: the support folder of the login user from the user
 * database, as install-kit writes it; no variable moves it. `account` is for tests.
 */
export function createVerifyKit(account = currentLoginUser()): () => KitVerdict {
  return () => verifyKit({ supportDir: join(account.home, SUPPORT_DIR_IN_HOME) })
}

/**
 * Run one subcommand. Resolves with the exit code: 0 done, 1 refused (the
 * reason as a code, never a path or a value), 2 a call this command line does
 * not know.
 */
export async function runSupportCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (argv.length === 1 && argv[0] === 'status') {
    io.out(formatSupportStatus(await supportStatus(deps.status())))
    return 0
  }
  if (argv.length === 1 && argv[0] === 'verify-kit' && deps.verifyKit !== undefined) {
    // One line, the verdict as a code: never a path, so nothing of the machine is quoted back.
    const verdict = deps.verifyKit()
    io.out('kit=' + (verdict.ok ? 'ok' : verdict.problem) + '\n')
    return 0
  }
  const installArgs = argv[0] === 'install-kit' ? parseInstallKitArgs(argv.slice(1)) : null
  if (installArgs !== null) {
    try {
      const done = await deps.installKit(installArgs)
      io.out('kit=written\nreplaced=' + (done.replaced ? 'yes' : 'no') + '\ncleaned=' + done.cleaned.length + '\n')
      return 0
    } catch (err) {
      if (!(err instanceof KitError)) throw err
      io.err('install-kit: refused: ' + err.code + '\n')
      return 1
    }
  }
  if (argv.length === 3 && argv[0] === 'enable' && argv[1] === '--consent' && /^[1-9][0-9]{0,3}$/.test(argv[2])) {
    const code = await deps.readCode()
    const done = await enableSupportStandby({ code: code ?? '', consentVersion: Number(argv[2]) }, deps.standby())
    if (!done.ok) {
      io.err('enable: refused: ' + done.problem + '\n')
      return 1
    }
    // Until the real dispatcher (PR1c), the kit's dispatcher refuses every start: say so (Dani 78357, Q3).
    io.out('standby=on\nstandby_keys=' + done.keys.join(',') + '\nsupport_lines=' + done.lines + '\nhost_key=' + done.hostKey + '\nlogins=refused_by_this_release\n')
    return 0
  }
  if (argv.length === 3 && argv[0] === 'consent-text' && argv[1] === '--consent' && /^[1-9][0-9]{0,3}$/.test(argv[2])) {
    const consent = supportConsentText(Number(argv[2]))
    if (!consent.ok) {
      io.err('consent-text: refused: ' + consent.problem + '\n')
      return 1
    }
    io.out(consent.text)
    return 0
  }
  if (argv.length === 1 && argv[0] === 'disable') {
    const done = await disableSupportStandby(deps.standby())
    if (!done.ok) {
      io.err('disable: incomplete: ' + done.problem + '\n')
      return 1
    }
    io.out('standby=off\nremoved_lines=' + done.removedLines + '\n')
    return 0
  }
  io.err(SUPPORT_CLI_USAGE)
  return 2
}

/**
 * The ONE entry of the routine. The kit's loader imports the file from a
 * data: URL and calls this (its own path check below cannot fire there,
 * measured); a direct start calls it too. Never rejects: an unexpected error is
 * one fixed line and exit code 1, because a message can quote what was typed in.
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runSupportCli(
      argv,
      { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
      {
        status: createStatusDeps,
        installKit: createInstallKit(),
        verifyKit: createVerifyKit(),
        standby: () => createStandbyDeps(),
        readCode: () => readStdinCapped(SUPPORT_CODE_MAX_INPUT),
      },
    )
  } catch {
    process.stderr.write('support-standby: stopped on an unexpected error\n')
    return 1
  }
}

function startedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (startedDirectly()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
