// Offer a Claude Code CLI update from the Marveen update flow (CLIFRISSAJANLAS923).
//
// WHY THIS EXISTS: the per-session auto-updater is disabled on EVERY host
// (scripts/channels.sh), so a customer stays on the CLI version they installed
// with, and the newer models stay out of reach. The update page is the one
// place where the version can be raised in a controlled way. It is an OFFER:
// nothing here runs without the operator pressing the button.
//
// The rules all come from measurements (2026-09-22/23, AVX-less pilot VPS):
//   1. An AVX-less x86 host NEVER gets "latest" offered: the Bun ELF SIGILLs or
//      spins there. The target on that branch is the AVX-safe pin the shipped
//      install-linux.sh carries (single source, read at runtime), and while
//      there is no pin nothing is offered.
//   2. The AVX test is the existing one (update-agent-capability.ts mirrors the
//      /proc/cpuinfo check of install-linux.sh / channels.sh).
//   3. The post-install verification is a real, auth-free `claude -p` probe
//      under a timeout, NOT `claude --version` (which exits 0 on a Bun ELF
//      that then spins on the first prompt).
//   4. Running sessions keep the OLD binary until their next start; the result
//      carries that note so the UI says it.
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { tryResolveFromPath } from '../platform.js'
import { compareVersions } from '../claude-cli-support.js'
import { claudeAgentRunnable } from '../update-agent-capability.js'
import { measureClaudeCliVersion } from './claude-cli-version.js'

export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code'
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${CLAUDE_CODE_PACKAGE}/latest`
export const VERSION_RE = /^\d+\.\d+\.\d+$/
/** The note every successful apply carries (rule 4). The UI localises it. */
export const RUNNING_SESSIONS_NOTE = 'running-sessions-keep-old-binary'
const LATEST_CACHE_TTL_MS = 60 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 25_000
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const RESULT_FILE = join(STORE_DIR, 'cli-update.last-result')

export type InstallMethod = 'npm' | 'official' | 'unknown'
export type TargetKind = 'latest' | 'avx-safe-pin'

export interface CliOfferInput {
  installed: string | null
  latest: string | null
  avxLess: boolean
  avxSafePin: string | null
}
export interface CliOfferDecision {
  target: string | null
  targetKind: TargetKind | null
  offer: boolean
  reason: string
}

/** The AVX-less fallback pin of the shipped installer (`CLAUDE_PIN="x.y.z"`). */
export function readAvxSafePin(scriptText: string): string | null {
  const m = scriptText.match(/^CLAUDE_PIN="(\d+\.\d+\.\d+)"/m)
  return m ? m[1] : null
}
export function readAvxSafePinFromDisk(root: string = PROJECT_ROOT): string | null {
  try { return readAvxSafePin(readFileSync(join(root, 'install-linux.sh'), 'utf-8')) } catch { return null }
}

/** Pure decision (rule 1): what to offer, if anything. Fails CLOSED on anything unmeasured. */
export function decideCliOffer(i: CliOfferInput): CliOfferDecision {
  if (i.avxLess) {
    if (!i.avxSafePin) return { target: null, targetKind: null, offer: false, reason: 'avx-less host and no measured AVX-safe pin: nothing is offered' }
    if (!i.installed) return { target: i.avxSafePin, targetKind: 'avx-safe-pin', offer: false, reason: 'installed version unmeasured' }
    const offer = compareVersions(i.avxSafePin, i.installed) > 0
    return { target: i.avxSafePin, targetKind: 'avx-safe-pin', offer, reason: offer ? 'the AVX-safe pin is newer than the installed version' : 'installed version is at or above the AVX-safe pin' }
  }
  if (!i.latest) return { target: null, targetKind: null, offer: false, reason: 'latest version unknown' }
  if (!i.installed) return { target: i.latest, targetKind: 'latest', offer: false, reason: 'installed version unmeasured' }
  const offer = compareVersions(i.latest, i.installed) > 0
  return { target: i.latest, targetKind: 'latest', offer, reason: offer ? 'a newer version is published' : 'installed version is the latest' }
}

/** How the resolved binary was installed decides how it is upgraded. */
export function detectInstallMethod(binPath: string | null, resolveReal: (p: string) => string = (p) => realpathSync(p)): InstallMethod {
  if (!binPath) return 'unknown'
  let real = binPath
  try { real = resolveReal(binPath) } catch { /* keep the symlink path */ }
  if (real.includes('/node_modules/')) return 'npm'
  // The official installer (claude.ai/install.sh) links ~/.local/bin/claude to
  // a versioned binary under ~/.local/share/claude.
  if (real.includes('/.local/share/claude') || real.includes('/.local/bin/claude')) return 'official'
  return 'unknown'
}

let latestCache: { version: string | null; error: string | null; at: number } | null = null
/** Latest published version from the npm registry, cached for an hour; an error is a value, never a throw. */
export async function fetchLatestVersion(opts: { fresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<{ version: string | null; error: string | null }> {
  if (!opts.fresh && latestCache && Date.now() - latestCache.at < LATEST_CACHE_TTL_MS) return latestCache
  const f = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  try {
    const res = await f(REGISTRY_LATEST_URL, { signal: controller.signal })
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
    const body = await res.json() as { version?: unknown }
    const version = typeof body.version === 'string' && VERSION_RE.test(body.version) ? body.version : null
    latestCache = { version, error: version ? null : 'registry answer carries no version', at: Date.now() }
  } catch (err) {
    latestCache = { version: null, error: `registry lookup failed: ${(err as Error).message.slice(0, 120)}`, at: Date.now() }
  } finally {
    clearTimeout(timer)
  }
  return latestCache
}
/** Test hook. */
export function resetLatestVersionCache(): void { latestCache = null }

export interface LaunchProbeResult { ok: boolean; exitCode: number | null; signal: string | null; durationMs: number }
/**
 * Rule 3: does the installed claude actually LAUNCH? A real `-p` prompt, made
 * auth-free on purpose (isolated empty config dir, auth env removed): a healthy
 * CLI exits 1 within ~2 s with a "Not logged in" JSON and makes no API call; a
 * Bun binary without AVX SIGILLs (132) or hangs until the timeout. "Runs" means
 * it exited on its own with a code below 124 (the shell scripts use the same rule).
 */
export function probeClaudeLaunches(bin: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<LaunchProbeResult> {
  return new Promise((resolve) => {
    const cfg = mkdtempSync(join(tmpdir(), 'claude-probe-'))
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: cfg, DISABLE_AUTOUPDATER: '1' }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    const started = Date.now()
    const child = spawn(bin, ['-p', 'ping', '--max-turns', '1', '--output-format', 'json'], { env, stdio: 'ignore' })
    let settled = false
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rmSync(cfg, { recursive: true, force: true }) } catch { /* best effort */ }
      resolve({ ok: exitCode !== null && exitCode < 124, exitCode, signal, durationMs: Date.now() - started })
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish(null, 'TIMEOUT') }, timeoutMs)
    child.on('error', () => finish(null, 'SPAWN_ERROR'))
    child.on('exit', (code, signal) => finish(code, signal))
  })
}

export interface CliUpdateJobResult {
  status: 'running' | 'done' | 'failed'
  target: string
  method: InstallMethod
  startedAt: number
  finishedAt?: number
  installExit?: number | null
  installedAfter?: string | null
  probe?: LaunchProbeResult
  message?: string
  /** Present on success (rule 4). */
  note?: typeof RUNNING_SESSIONS_NOTE
}

export function readCliUpdateResult(): CliUpdateJobResult | null {
  try { return JSON.parse(readFileSync(RESULT_FILE, 'utf-8')) as CliUpdateJobResult } catch { return null }
}
function writeResult(r: CliUpdateJobResult): void {
  try { mkdirSync(STORE_DIR, { recursive: true }); writeFileSync(RESULT_FILE, JSON.stringify(r), { mode: 0o600 }) } catch (err) { logger.warn({ err }, 'cli-update result not persisted') }
}
let running: CliUpdateJobResult | null = null
export function cliUpdateRunning(): boolean { return running !== null }

/** The shell command an operator can run by hand when the automatic path cannot (EACCES, unknown method). */
export function manualInstallCommand(target: string, method: InstallMethod): string {
  if (method === 'official') return `curl -fsSL https://claude.ai/install.sh | bash -s ${target}`
  return `npm install -g ${CLAUDE_CODE_PACKAGE}@${target}`
}

/**
 * Starts the install in the background (one at a time). The result file is
 * the source of truth for the UI; the running flag guards double clicks.
 * Verification after the install is the real launch probe, then a fresh
 * `--version` only for DISPLAY of what is now installed.
 */
export function startCliUpdate(target: string, method: InstallMethod, deps: {
  spawnImpl?: typeof spawn
  probe?: (bin: string) => Promise<LaunchProbeResult>
  measure?: () => Promise<{ version: string | null }>
  resolveBin?: () => string | null
} = {}): { ok: true } | { ok: false; error: string } {
  if (!VERSION_RE.test(target)) return { ok: false, error: 'target is not a dotted version' }
  if (method === 'unknown') return { ok: false, error: 'install method unknown' }
  if (running) return { ok: false, error: 'a CLI update is already running' }
  const sp = deps.spawnImpl ?? spawn
  const probe = deps.probe ?? ((bin: string) => probeClaudeLaunches(bin))
  const measure = deps.measure ?? (() => measureClaudeCliVersion({ fresh: true }))
  const resolveBin = deps.resolveBin ?? (() => tryResolveFromPath('claude'))
  const job: CliUpdateJobResult = { status: 'running', target, method, startedAt: Date.now() }
  running = job
  writeResult(job)
  const cmd = method === 'npm'
    ? ['npm', ['install', '-g', `${CLAUDE_CODE_PACKAGE}@${target}`]] as const
    : ['bash', ['-c', `curl -fsSL https://claude.ai/install.sh | bash -s '${target}'`]] as const
  let stderrTail = ''
  let child: ReturnType<typeof spawn>
  try {
    child = sp(cmd[0], [...cmd[1]], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISABLE_AUTOUPDATER: '1' } })
  } catch (err) {
    running = null
    const failed: CliUpdateJobResult = { ...job, status: 'failed', finishedAt: Date.now(), message: `could not start ${cmd[0]}: ${(err as Error).message}` }
    writeResult(failed)
    return { ok: false, error: failed.message! }
  }
  child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-600) })
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, INSTALL_TIMEOUT_MS)
  const settle = async (installExit: number | null) => {
    clearTimeout(timer)
    let result: CliUpdateJobResult
    if (installExit !== 0) {
      const eacces = /EACCES|permission denied/i.test(stderrTail)
      result = {
        ...job, status: 'failed', finishedAt: Date.now(), installExit,
        message: eacces
          ? `the global install dir is not writable; run by hand: sudo ${manualInstallCommand(target, method)}`
          : `install exited ${installExit ?? 'by signal'}: ${stderrTail.trim().slice(-300) || 'no stderr'}`,
      }
    } else {
      const bin = resolveBin()
      const pr = bin ? await probe(bin) : { ok: false, exitCode: null, signal: 'NO_BINARY', durationMs: 0 }
      const installedAfter = (await measure()).version
      result = pr.ok
        ? { ...job, status: 'done', finishedAt: Date.now(), installExit, installedAfter, probe: pr, note: RUNNING_SESSIONS_NOTE }
        : { ...job, status: 'failed', finishedAt: Date.now(), installExit, installedAfter, probe: pr,
            message: `installed, but the new claude does not launch (probe exit ${pr.exitCode ?? pr.signal}); a running session is unaffected until its next start` }
    }
    running = null
    writeResult(result)
    logger.info({ result }, 'cli-update finished')
  }
  child.on('error', (err) => { stderrTail += String(err.message); void settle(null) })
  child.on('exit', (code) => { void settle(code) })
  return { ok: true }
}

export interface CliUpdateStatus {
  installed: string | null
  installedError: string | null
  bin: string | null
  installMethod: InstallMethod
  latest: string | null
  latestError: string | null
  avxLess: boolean
  avxSafePin: string | null
  target: string | null
  targetKind: TargetKind | null
  offer: boolean
  reason: string
  manualCommand: string | null
  job: { running: boolean; result: CliUpdateJobResult | null }
}

/** Test hook: dependency overrides the ROUTE picks up, so a route test never touches the network or the real binary. */
let testDeps: Parameters<typeof buildCliUpdateStatus>[0] | null = null
export function setCliUpdateDepsForTests(d: Parameters<typeof buildCliUpdateStatus>[0] | null): void { testDeps = d }
export function cliUpdateDepsForRoute(extra: { fresh?: boolean }): Parameters<typeof buildCliUpdateStatus>[0] { return { ...(testDeps ?? {}), ...extra } }

export async function buildCliUpdateStatus(deps: {
  measure?: () => Promise<{ version: string | null; error: string | null }>
  latest?: () => Promise<{ version: string | null; error: string | null }>
  avxLess?: () => boolean
  pin?: () => string | null
  resolveBin?: () => string | null
  fresh?: boolean
} = {}): Promise<CliUpdateStatus> {
  const measure = deps.measure ?? (() => measureClaudeCliVersion({ fresh: deps.fresh }))
  const latestFn = deps.latest ?? (() => fetchLatestVersion({ fresh: deps.fresh }))
  const avxLess = (deps.avxLess ?? (() => !claudeAgentRunnable()))()
  const avxSafePin = (deps.pin ?? readAvxSafePinFromDisk)()
  const bin = (deps.resolveBin ?? (() => tryResolveFromPath('claude')))()
  const [m, l] = await Promise.all([measure(), avxLess ? Promise.resolve({ version: null, error: null }) : latestFn()])
  const decision = decideCliOffer({ installed: m.version, latest: l.version, avxLess, avxSafePin })
  const installMethod = detectInstallMethod(bin)
  return {
    installed: m.version, installedError: m.error, bin, installMethod,
    latest: l.version, latestError: l.error, avxLess, avxSafePin,
    ...decision,
    manualCommand: decision.target ? manualInstallCommand(decision.target, installMethod) : null,
    job: { running: cliUpdateRunning(), result: readCliUpdateResult() },
  }
}
