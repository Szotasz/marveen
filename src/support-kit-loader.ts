// Support access: running the KIT's copy of the routine (N17, Samu and Dani on
// SUPPORTMENTOUT1114).
//
// Opening support access runs only the copy of the routine that sits in the
// kit, as a separate process. A copy that is measured and then started by its
// path can be swapped between the two (two opens). So the loader reads the
// file ONCE, measures THOSE bytes against the hash the manifest gave, and runs
// THOSE bytes, imported from a data: URL (measured on node 20 and 22,
// meres/EREDMENY.md 5.14: the same output and exit codes as a run from the
// file; a swap between measuring and running does not change what runs).
//
// The loader is a fixed text, KIT_LOADER_SOURCE. The sh launcher carries the
// same text word for word between single quotes, so it holds no single quote;
// everything that varies (the expected hash, the path, the subcommand) is an
// argument after `--`, never part of the text. It is started with an explicit
// environment: no NODE_OPTIONS (a preload would run before the hash is
// checked, measured by Dani), no NODE_PATH, no NODE_ key at all.
//
// What the loader guarantees: no eval, new Function or vm; the bundle's one
// exported `main` is the only entry; every error, also one that escapes, ends
// in one fixed line on stderr and an exit code, never in a trace that would
// print the data: URL (measured: 3 kB of code gave 12.7 kB of stderr).
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { verifyKit, type KitProblem } from './support-kit.js'
import { KIT_ROUTINE_NAME } from './support-kit-sources.js'
import { KIT_SOURCE_MAX_BYTES } from './support-kit-install.js'

/**
 * Exit codes of the loader itself. The routine's own codes stay below 64 (a
 * routine that returns more is a failure), so a code of the loader can never
 * pass for an answer of the routine (Dani's review of #2768, S3).
 */
export const KIT_LOADER_EXIT = { usage: 64, mismatch: 65, unreadable: 66, failed: 70 } as const
const LOADER_CODES = new Set<number>(Object.values(KIT_LOADER_EXIT))

export const KIT_LOADER_SOURCE = String.raw`import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
const stop = (code) => {
  try { process.stderr.write("support-kit-loader: stopped (" + code + ")\n"); } catch {}
  process.exit(code);
};
process.on("uncaughtException", () => stop(70));
process.on("unhandledRejection", () => stop(70));
const [expected, path, ...args] = process.argv.slice(1);
if (!/^[0-9a-f]{64}$/.test(expected ?? "") || !/^\/[A-Za-z0-9._\/-]+$/.test(path ?? "")) stop(64);
const MAX = ${KIT_SOURCE_MAX_BYTES};
let bytes = null;
try {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fstatSync(fd).isFile()) {
      const buf = Buffer.alloc(MAX + 1);
      let n = 0;
      for (;;) {
        const got = readSync(fd, buf, n, buf.length - n, n);
        if (got === 0) break;
        n += got;
        if (n > MAX) break;
      }
      if (n <= MAX) bytes = buf.subarray(0, n);
    }
  } finally {
    closeSync(fd);
  }
} catch {}
if (bytes === null) stop(66);
if (createHash("sha256").update(bytes).digest("hex") !== expected) stop(65);
let main = null;
try {
  main = (await import("data:text/javascript;base64," + bytes.toString("base64"))).main;
} catch {}
if (typeof main !== "function") stop(70);
let code = null;
try {
  code = await main(args);
} catch {}
if (!Number.isInteger(code) || code < 0 || code > 63) stop(70);
process.exitCode = code;
`

/** The fixed environment of the routine's process: nothing of the caller's, no NODE_ key. */
export const KIT_RUN_ENV: Readonly<Record<string, string>> = { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
/** No more of the routine's output than this is kept; a longer output is a failure. */
export const KIT_RUN_MAX_OUTPUT = 64 * 1024

export type KitRunResult =
  | { readonly ok: true; readonly code: number; readonly stdout: string }
  | { readonly ok: false; readonly problem: KitProblem | 'kit_run_failed' | 'kit_no_output' }

export interface KitRunInput {
  readonly supportDir: string
  /** The subcommand and its arguments. Never part of the loader text. */
  readonly args: readonly string[]
  /** Written to the routine's standard input, then closed (the owner's one-time code goes here, never into an argument). */
  readonly stdin?: string
  readonly timeoutMs: number
}

/**
 * What one finished run means. A killed run, one that printed too much, or an
 * exit code of the loader itself is a failure (65, the hash did not match, is
 * a kit mismatch); a routine code is 0 to 63; exit 0 with no output is a
 * failure too (the routine always answers).
 */
export function kitRunOutcome(run: { code: number | null; signal: NodeJS.Signals | null; tooLong: boolean; stdout: string }): KitRunResult {
  const { code, signal, tooLong, stdout } = run
  if (tooLong || signal !== null || code === null) return { ok: false, problem: 'kit_run_failed' }
  if (code === KIT_LOADER_EXIT.mismatch) return { ok: false, problem: 'kit_mismatch' }
  if (LOADER_CODES.has(code) || code < 0 || code > 63) return { ok: false, problem: 'kit_run_failed' }
  if (code === 0 && stdout.length === 0) return { ok: false, problem: 'kit_no_output' }
  return { ok: true, code, stdout }
}

/** The node arguments of one run: the loader text, then everything that varies after `--`. */
export function kitRunArgs(expectedSha256: string, routinePath: string, args: readonly string[]): string[] {
  return ['--input-type=module', '-e', KIT_LOADER_SOURCE, '--', expectedSha256, routinePath, ...args]
}

/**
 * Run the kit's copy of the routine with `args`. The kit is verified first
 * (both folders, every file against the manifest, read once); the hash the
 * manifest gives for the routine goes to the loader, which measures the bytes
 * it runs against it. A kit that does not verify is refused with its problem;
 * nothing is started. Exit 0 with no output at all is a failure (the routine
 * always answers), and so is a killed run or one that prints too much.
 */
export function runKitRoutine(input: KitRunInput): Promise<KitRunResult> {
  const verdict = verifyKit({ supportDir: input.supportDir })
  if (!verdict.ok) return Promise.resolve({ ok: false, problem: verdict.problem })
  const expected = verdict.manifest.files[KIT_ROUTINE_NAME]
  if (expected === undefined) return Promise.resolve({ ok: false, problem: 'kit_mismatch' })
  const routinePath = join(verdict.kitDir, KIT_ROUTINE_NAME)
  return new Promise<KitRunResult>((resolve) => {
    let child
    try {
      child = spawn(verdict.manifest.nodePath, kitRunArgs(expected, routinePath, input.args), {
        env: { ...KIT_RUN_ENV },
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: input.timeoutMs,
      })
    } catch {
      resolve({ ok: false, problem: 'kit_run_failed' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLong = false
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > KIT_RUN_MAX_OUTPUT) {
        tooLong = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => resolve({ ok: false, problem: 'kit_run_failed' }))
    child.on('close', (code, signal) => {
      resolve(kitRunOutcome({ code, signal, tooLong, stdout: Buffer.concat(chunks).toString('utf8') }))
    })
    child.stdin?.on('error', () => {
      /* the routine may exit before it reads; the exit code says what happened */
    })
    child.stdin?.end(input.stdin ?? '')
  })
}
