// GLOBAL SUITE GATE: no test may spawn the macOS `security` CLI (card 31a6e54d).
//
// The vault keeps its master key in the login Keychain under the LIVE item
// com.marveen.vault / master-key, and keychainStore() writes it with
// `add-generic-password -U` (update in place). A test that reached the real
// keychain.ts on a Mac outside a sandbox could therefore overwrite the live
// master key and orphan every secret in the vault. Other modules shell out to
// `security` too (Claude Code credential reads, the worker's path-hashed entry
// delete), and none of that belongs in a test run either.
//
// src/web/keychain.ts refuses the live item itself in a test process; this file
// is the second, module-independent layer: it wraps node:child_process in every
// worker, before any test module is imported, so ANY spawn of `security` --
// from any module, through any of the six spawning functions -- throws before a
// process starts. Fail closed: there is no opt-out. A test that needs Keychain
// behaviour mocks the calling module (see vault-master-key.test.ts) or
// child_process itself; a vi.mock'd child_process never reaches this wrapper.
//
// Mechanics: the builtin's CJS exports object is patched and then
// syncBuiltinESMExports() pushes the patched functions into the ESM named
// bindings, so `import { execFileSync } from 'node:child_process'` sees them.
// Self-test: keychain-spawn-guard.test.ts.
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const cp = require('node:child_process') as Record<string, unknown>

const STATE = Symbol.for('marveen.31a6e54d.keychainSpawnGuard')

// A `security` sub-command inside a SHELL string, options before it included:
// "security find-generic-password", "security -q find-generic-password",
// "cd / && /usr/bin/security -i delete-generic-password", and the quoted binary
// forms ("/usr/bin/security" find-generic-password, 'security' ...). Only ever applied to
// text a shell will parse (see judgeFileCall/judgeCommandCall): a plain argv
// such as `git commit -m "... security add-generic-password ..."` is data, not
// a command, and must not be refused.
export const SECURITY_IN_SHELL = /(^|[\s;&|(`'"/])security['"]?(\s+-\S+)*\s+[a-z]+(-[a-z]+)+/

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

export const KEYCHAIN_GUARD_CODE = 'EKEYCHAINGUARD'

function refuse(what: string): never {
  const err = new Error(
    `keychain spawn guard: a test tried to run the macOS security CLI (${what}) -- refused before spawning. ` +
    'Mock the module that calls it, or mock node:child_process.',
  ) as Error & { code: string }
  err.code = KEYCHAIN_GUARD_CODE
  throw err
}

function isSecurityFile(file: unknown): boolean {
  return typeof file === 'string' && basename(file.trim()) === 'security'
}

function argvText(args: unknown[]): string {
  return args.filter((a): a is string => typeof a === 'string').join(' ')
}

// `sh -c "..."`, `bash -lc "..."`: a -c anywhere in a short-option cluster.
function hasCommandFlag(argv: unknown[]): boolean {
  return argv.some((a) => typeof a === 'string' && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
}

// file + argv forms: execFile, execFileSync, spawn, spawnSync.
function judgeFileCall(file: unknown, rest: unknown[]): void {
  const argv = Array.isArray(rest[0]) ? (rest[0] as unknown[]) : []
  const opts = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as { shell?: unknown } | undefined
  if (isSecurityFile(file)) refuse(String(file))
  const fileText = typeof file === 'string' ? file : ''
  // spawn(cmd, args, { shell: true }): node hands `cmd args` to /bin/sh.
  if (opts && typeof opts === 'object' && opts.shell) {
    if (SECURITY_IN_SHELL.test([fileText, argvText(argv)].join(' '))) refuse('via shell:true')
    return
  }
  // execFile('/bin/sh', ['-c', 'security ...']): the argv IS a shell script.
  if (SHELLS.has(basename(fileText.trim())) && hasCommandFlag(argv) && SECURITY_IN_SHELL.test(argvText(argv))) {
    refuse('via a shell -c')
  }
}

// command-string forms: exec, execSync (always run by a shell).
function judgeCommandCall(command: unknown): void {
  if (typeof command !== 'string') return
  const first = command.trim().split(/\s+/)[0].replace(/^['"]+|['"]+$/g, '')
  if (isSecurityFile(first) || SECURITY_IN_SHELL.test(command)) refuse('via a shell command')
}

type Fn = ((...a: unknown[]) => unknown) & { [promisify.custom]?: (...a: unknown[]) => unknown }

// exec/execFile carry a util.promisify.custom variant ({ stdout, stderr }).
// Keep it -- otherwise promisify(execFile) silently changes shape -- but guard
// it as well, or the promisified path would bypass the check.
function wrap(orig: Fn, judge: (first: unknown, rest: unknown[]) => void): Fn {
  const guarded: Fn = function guardedSpawn(this: unknown, first: unknown, ...rest: unknown[]) {
    judge(first, rest)
    return orig.call(this, first, ...rest)
  }
  const custom = orig[promisify.custom]
  if (typeof custom === 'function') {
    guarded[promisify.custom] = function guardedPromisified(this: unknown, first: unknown, ...rest: unknown[]) {
      judge(first, rest)
      return custom.call(this, first, ...rest)
    }
  }
  return guarded
}

if (!(cp as Record<symbol, unknown>)[STATE]) {
  for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync'] as const) {
    cp[name] = wrap(cp[name] as Fn, judgeFileCall)
  }
  for (const name of ['exec', 'execSync'] as const) {
    cp[name] = wrap(cp[name] as Fn, (command) => judgeCommandCall(command))
  }
  ;(cp as Record<symbol, unknown>)[STATE] = true
  syncBuiltinESMExports()
}
