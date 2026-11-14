import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KIT_LOADER_EXIT, KIT_LOADER_SOURCE, KIT_RUN_ENV, KIT_RUN_MAX_OUTPUT, kitRunArgs, runKitRoutine } from '../support-kit-loader.js'
import { installKit, KIT_SOURCE_MAX_BYTES } from '../support-kit-install.js'
import { writeKit } from '../support-kit.js'
import { KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const NODE = realpathSync(process.execPath)
const RELEASE = '8cb46ad83c88f73cfaff252fae3e78bb595af1ab'
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const noSleep = async (): Promise<void> => {}
const FIXED_LINE = (code: number): string => 'support-kit-loader: stopped (' + code + ')\n'

describe('the loader text', () => {
  it('is one literal the sh launcher can put between single quotes, and carries nothing that varies', () => {
    expect(KIT_LOADER_SOURCE).not.toContain("'")
    expect(KIT_LOADER_SOURCE).not.toContain('`')
    expect(KIT_LOADER_SOURCE).not.toContain('${')
    expect(KIT_LOADER_SOURCE).toContain('const MAX = ' + KIT_SOURCE_MAX_BYTES + ';')
  })

  it('has no eval, no new Function, no vm, and imports nothing but node:fs and node:crypto', () => {
    expect(KIT_LOADER_SOURCE).not.toMatch(/\beval\s*\(|new\s+Function|node:vm|require\(/)
    expect(KIT_LOADER_SOURCE.match(/from "[^"]+"/g)).toEqual(['from "node:fs"', 'from "node:crypto"'])
    // The only dynamic import is the data: URL of the bytes it measured.
    expect(KIT_LOADER_SOURCE.match(/import\(/g)).toHaveLength(1)
    expect(KIT_LOADER_SOURCE).toContain('await import("data:text/javascript;base64," + bytes.toString("base64"))')
  })

  it('goes to node as the -e text, with everything that varies after --', () => {
    expect(kitRunArgs('a'.repeat(64), '/k/support-standby.mjs', ['status'])).toEqual([
      '--input-type=module',
      '-e',
      KIT_LOADER_SOURCE,
      '--',
      'a'.repeat(64),
      '/k/support-standby.mjs',
      'status',
    ])
    expect(KIT_RUN_ENV).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C' })
  })
})

describe('running the kit copy of the routine', () => {
  let root: string
  let supportDir: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-kit-loader-')))
    supportDir = join(root, 'home', '.marveen', 'support')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A kit whose routine is this text (and a placeholder dispatcher). */
  async function kitWithRoutine(text: string): Promise<string> {
    const routine = Buffer.from(text, 'utf8')
    const dispatcher = Buffer.from('#!/bin/sh\nexit 1\n')
    await writeKit({
      supportDir,
      files: [
        { name: KIT_DISPATCHER_NAME, content: dispatcher, sha256: sha(dispatcher), executable: false },
        { name: KIT_ROUTINE_NAME, content: routine, sha256: sha(routine), executable: false },
      ],
      installRoot: '/opt/marveen',
      nodePath: NODE,
      nodeMin: 20,
      release: RELEASE,
      sleep: noSleep,
    })
    return join(supportDir, 'kit', KIT_ROUTINE_NAME)
  }

  // Samu 32050: the status run through the loader gives the same lines as the file run directly.
  it('runs THIS repository\'s routine from the kit, and status prints exactly what the file prints when run directly', async () => {
    await installKit({ installRoot: REPO, nodePath: NODE, release: RELEASE, supportDir, sleep: noSleep })
    const viaKit = await runKitRoutine({ supportDir, args: ['status'], timeoutMs: 30_000 })
    const direct = spawnSync(NODE, [join(REPO, 'scripts', 'support-standby.mjs'), 'status'], {
      encoding: 'utf8',
      env: { ...KIT_RUN_ENV },
      timeout: 30_000,
    })
    expect(direct.status).toBe(0)
    expect(viaKit).toEqual({ ok: true, code: 0, stdout: direct.stdout })
    expect(direct.stdout.trimEnd().split('\n')).toHaveLength(9)
    // A call the routine does not know: its own exit code comes back.
    expect(await runKitRoutine({ supportDir, args: ['bogus'], timeoutMs: 30_000 })).toEqual({ ok: true, code: 2, stdout: '' })
  })

  // Samu 78224: the node path may hold an at sign (a versioned Homebrew node). A run through such a path, also on
  // Linux CI where the real node has none; and no manifest value comes back in what the run prints.
  it('runs through a node reached at a path with an at sign, and prints no manifest value', async () => {
    const atDir = join(root, 'opt', 'node@22', 'bin')
    mkdirSync(atDir, { recursive: true })
    symlinkSync(NODE, join(atDir, 'node'))
    await installKit({ installRoot: REPO, nodePath: join(atDir, 'node'), release: RELEASE, supportDir, sleep: noSleep })
    const out = await runKitRoutine({ supportDir, args: ['status'], timeoutMs: 30_000 })
    expect(out).toMatchObject({ ok: true, code: 0 })
    const text = out.ok ? out.stdout : ''
    for (const value of [join(atDir, 'node'), REPO, RELEASE, supportDir, '@']) expect(text).not.toContain(value)
  })

  it('runs the bytes from a data: URL, hands over the arguments and the standard input, and keeps the exit code', async () => {
    await kitWithRoutine(
      'export async function main(args) {\n' +
        '  const chunks = []\n' +
        '  for await (const c of process.stdin) chunks.push(c)\n' +
        '  process.stdout.write(new URL(import.meta.url).protocol + " " + JSON.stringify(args) + " " + Buffer.concat(chunks).toString() + "\\n")\n' +
        '  return 7\n' +
        '}\n',
    )
    expect(await runKitRoutine({ supportDir, args: ['enable', '--x', '-e'], stdin: 'CODE-123', timeoutMs: 10_000 })).toEqual({
      ok: true,
      code: 7,
      stdout: 'data: ["enable","--x","-e"] CODE-123\n',
    })
  })

  it('starts the routine with the fixed environment only: a NODE_OPTIONS preload of the caller never runs', async () => {
    const preload = join(root, 'preload.cjs')
    writeFileSync(preload, 'process.stdout.write("PRELOAD RAN\\n")\n')
    await kitWithRoutine(
      'export async function main() {\n' +
        // macOS puts __CF_USER_TEXT_ENCODING into every process it starts; it does not come from the caller.
        '  const keys = Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()\n' +
        '  process.stdout.write(JSON.stringify(keys) + " " + JSON.stringify(process.execArgv.filter((a) => a.startsWith("--") && a !== "--input-type=module")) + "\\n")\n' +
        '  return 0\n' +
        '}\n',
    )
    const saved = { options: process.env['NODE_OPTIONS'], path: process.env['NODE_PATH'] }
    process.env['NODE_OPTIONS'] = '--require ' + preload
    process.env['NODE_PATH'] = root
    try {
      const out = await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })
      expect(out).toEqual({ ok: true, code: 0, stdout: '["LC_ALL","PATH"] []\n' })
    } finally {
      if (saved.options === undefined) delete process.env['NODE_OPTIONS']
      else process.env['NODE_OPTIONS'] = saved.options
      if (saved.path === undefined) delete process.env['NODE_PATH']
      else process.env['NODE_PATH'] = saved.path
    }
  })

  it('treats exit 0 with no output as a failure, and so a routine without a main or with a throwing one', async () => {
    await kitWithRoutine('export async function main() { return 0 }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: false, problem: 'kit_no_output' })
    rmSync(supportDir, { recursive: true })
    await kitWithRoutine('export const notMain = 1\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: true, code: KIT_LOADER_EXIT.failed, stdout: '' })
    rmSync(supportDir, { recursive: true })
    await kitWithRoutine('export async function main() { throw new Error("boom") }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: true, code: KIT_LOADER_EXIT.failed, stdout: '' })
    rmSync(supportDir, { recursive: true })
    await kitWithRoutine('export async function main() { return "0" }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: true, code: KIT_LOADER_EXIT.failed, stdout: '' })
    rmSync(supportDir, { recursive: true })
    await kitWithRoutine('export async function main() { process.stdout.write("x\\n"); return 300 }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: true, code: KIT_LOADER_EXIT.failed, stdout: 'x\n' })
  })

  it('stops a routine that prints too much, or that does not finish in time', async () => {
    await kitWithRoutine('export async function main() { process.stdout.write("x".repeat(' + (KIT_RUN_MAX_OUTPUT + 10) + ')); return 0 }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: false, problem: 'kit_run_failed' })
    rmSync(supportDir, { recursive: true })
    await kitWithRoutine('export async function main() { await new Promise(() => setInterval(() => {}, 1000)); return 0 }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 500 })).toEqual({ ok: false, problem: 'kit_run_failed' })
  })

  it('starts nothing when the kit does not verify', async () => {
    expect(await runKitRoutine({ supportDir, args: ['status'], timeoutMs: 10_000 })).toEqual({ ok: false, problem: 'kit_missing' })
    const routine = await kitWithRoutine('export async function main() { process.stdout.write("RAN\\n"); return 0 }\n')
    writeFileSync(routine, 'export async function main() { process.stdout.write("CHANGED\\n"); return 0 }\n')
    expect(await runKitRoutine({ supportDir, args: [], timeoutMs: 10_000 })).toEqual({ ok: false, problem: 'kit_mismatch' })
  })

  describe('the loader on its own', () => {
    const runLoader = (args: string[], extraNodeArgs: string[] = []) =>
      spawnSync(NODE, [...extraNodeArgs, ...kitRunArgs(args[0], args[1], args.slice(2))], { encoding: 'utf8', env: { ...KIT_RUN_ENV }, timeout: 20_000 })

    it('turns an error that escapes the routine into the fixed line, not a trace with the data: URL', async () => {
      const routine = await kitWithRoutine(
        'export async function main() {\n' +
          '  setTimeout(() => { throw new Error("y".repeat(3000)) }, 0)\n' +
          '  await new Promise((r) => setTimeout(r, 200))\n' +
          '  return 0\n' +
          '}\n',
      )
      const run = runLoader([sha(readFileSync(routine)), routine])
      expect(run.status).toBe(KIT_LOADER_EXIT.failed)
      expect(run.stderr).toBe(FIXED_LINE(KIT_LOADER_EXIT.failed))
      const rejecting = await kitWithRoutine(
        'export async function main() {\n' +
          '  void Promise.reject(new Error("z".repeat(3000)))\n' +
          '  await new Promise((r) => setTimeout(r, 200))\n' +
          '  return 0\n' +
          '}\n',
      )
      const again = runLoader([sha(readFileSync(rejecting)), rejecting])
      expect(again.status).toBe(KIT_LOADER_EXIT.failed)
      expect(again.stderr).toBe(FIXED_LINE(KIT_LOADER_EXIT.failed))
    })

    it('stops with its own code and ONE fixed line for every refusal, never a trace with the data: URL', async () => {
      const routine = await kitWithRoutine('export async function main() { throw new Error("x".repeat(3000)) }\n')
      const good = sha(readFileSync(routine))
      const big = join(root, 'big.mjs')
      writeFileSync(big, 'x'.repeat(KIT_SOURCE_MAX_BYTES + 1))
      const link = join(root, 'link.mjs')
      symlinkSync(routine, link)
      mkdirSync(join(root, 'dir.mjs'))
      for (const [args, code] of [
        [[good, routine], KIT_LOADER_EXIT.failed],
        [['f'.repeat(64), routine], KIT_LOADER_EXIT.mismatch],
        [[good.toUpperCase(), routine], KIT_LOADER_EXIT.usage],
        [[good, 'relative/path.mjs'], KIT_LOADER_EXIT.usage],
        [[good, routine.replace('/kit/', '/kit dir/')], KIT_LOADER_EXIT.usage],
        [[good, join(root, 'missing.mjs')], KIT_LOADER_EXIT.unreadable],
        [[good, link], KIT_LOADER_EXIT.unreadable],
        [[good, join(root, 'dir.mjs')], KIT_LOADER_EXIT.unreadable],
        [[sha(readFileSync(big)), big], KIT_LOADER_EXIT.unreadable],
      ] as [string[], number][]) {
        const run = runLoader(args)
        expect([args[1].slice(-12), run.status]).toEqual([args[1].slice(-12), code])
        expect(run.stderr).toBe(FIXED_LINE(code))
        expect(run.stdout).toBe('')
      }
    })

    // Samu 32050: a swap between the measurement and the run. A preload (test only, never in a real run) replaces
    // the file right after the loader's first open of it; the loader must run the bytes it read.
    it('runs the bytes it measured when the file is swapped right after it was opened', async () => {
      const routine = await kitWithRoutine('export async function main() { process.stdout.write("OLD\\n"); return 0 }\n')
      const replacement = join(root, 'replacement.mjs')
      writeFileSync(replacement, 'export async function main() { process.stdout.write("NEW\\n"); return 0 }\n')
      const hook = join(root, 'swap-hook.mjs')
      writeFileSync(
        hook,
        'import fs from "node:fs"\n' +
          'import { syncBuiltinESMExports } from "node:module"\n' +
          'const realOpen = fs.openSync\n' +
          'let swapped = false\n' +
          'fs.openSync = (...a) => {\n' +
          '  const fd = realOpen(...a)\n' +
          '  if (!swapped && String(a[0]) === ' + JSON.stringify(routine) + ') { swapped = true; fs.renameSync(' + JSON.stringify(replacement) + ', String(a[0])) }\n' +
          '  return fd\n' +
          '}\n' +
          'syncBuiltinESMExports()\n',
      )
      const run = runLoader([sha(readFileSync(routine)), routine], ['--import', hook])
      expect(run.stderr).toBe('')
      expect(run.stdout).toBe('OLD\n')
      expect(run.status).toBe(0)
      // Control: the swap did happen, so a second read would have seen the new file.
      expect(readFileSync(routine, 'utf8')).toContain('NEW')
    })
  })
})
