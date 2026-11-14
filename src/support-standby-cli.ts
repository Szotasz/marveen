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
// Subcommands so far: `status` (looks, never writes, needs no code).
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORT_FROM_CIDRS, SUPPORT_KEYS } from './support-access-pins.js'
import { createSshdProbeDeps, currentLoginUser, probeSshd } from './support-access-sshd-run.js'
import { formatSupportStatus, supportStatus, type SupportStatusDeps } from './support-standby.js'

// What the dashboard and the tests use from the same file the command line runs.
export { buildSupportGrantLines, buildSupportLine } from './support-access-line.js'
export { grantSupportLines, reconcileSupportLinesOnDisk, revokeSupportLines } from './support-access-fs.js'
export { SUPPORT_ROUTINE_MIN_NODE_MAJOR, formatSupportStatus, supportStatus } from './support-standby.js'

export const SUPPORT_CLI_USAGE = 'usage: support-standby.mjs status\n'

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
  }
}

export interface CliIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

/** Run one subcommand. Resolves with the exit code: 0 done, 2 a call this command line does not know. */
export async function runSupportCli(argv: readonly string[], io: CliIo, deps: { readonly status: () => SupportStatusDeps }): Promise<number> {
  if (argv.length === 1 && argv[0] === 'status') {
    io.out(formatSupportStatus(await supportStatus(deps.status())))
    return 0
  }
  io.err(SUPPORT_CLI_USAGE)
  return 2
}

function startedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (startedDirectly()) {
  runSupportCli(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    { status: createStatusDeps },
  ).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      // Nothing an error holds is printed: a message can quote what was typed in.
      process.stderr.write('support-standby: stopped on an unexpected error\n')
      process.exitCode = 1
    },
  )
}
