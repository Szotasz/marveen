// marveen-channel-coordinator: standalone Telegram inbound BACKFILL poller.
//
// WHY THIS EXISTS (hybrid model -- Szabi 2026-06-02)
// The native Telegram channel plugin runs getUpdates INSIDE the Marveen TUI and
// stays the PRIMARY inbound path (it gives the "typing..." indicator, low
// latency, and native reply-semantics for free). But the plugin's ~hourly
// disconnects / TUI freezes leave inbound messages stranded server-side.
//
// This coordinator is a SILENT BACKFILL safety-net: while the native channel is
// UP it does NOTHING (no getUpdates, so no 409, native owns inbound). Only when
// the native is observed DOWN (process gone, or alive-but-wedged per a stale
// keepalive) does it poll getUpdates, write to store/claudeclaw.db
// (incoming_events), and hand off to Marveen via the existing agent_messages
// queue + message-router (which delivers it as channel-inbound -- reply-
// expected, body untrusted).
//
// NO DOUBLE-DELIVERY: on entering a backfill window it seeds poll_offset to the
// current server high-water (probeHighWater), so it only delivers messages that
// arrive DURING the outage and confirms them; the detection-window backlog
// (<= high-water) is left for the native to deliver when it recovers (it polls
// from its own older offset). It yields the instant the native returns -- on a
// 409 OR a liveness flip -- and re-checks liveness BEFORE handing off a batch,
// discarding it if the native just recovered. Bias: under-deliver, since the
// native + typing is the better UX and Telegram holds unconfirmed updates 24h.
//
// Lifecycle: launchd (com.<SERVICE_ID>.channel-coordinator, #1873) with KeepAlive. SIGTERM
// drains, persists offset, exits cleanly.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, linkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { logger } from './logger.js'
import { isSettingOn } from './setting-flag.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME } from './config.js'
import { getUpdates, probeHighWater, mapUpdate, TelegramApiError } from './channel-coordinator/telegram-client.js'
import { probeNativeChannelDown } from './channel-coordinator/liveness.js'
import {
  initIngestDb,
  insertIncomingEvent,
  createHandoffMessage,
  markEventDelivered,
  getEventsNeedingHandoff,
  getOffset,
  setOffset,
  closeIngestDb,
  type InsertResult,
} from './channel-coordinator/ingest.js'

const SOURCE = 'telegram'
const LONGPOLL_TIMEOUT_SEC = 30
const POLL_LIMIT = 100

// The native main-agent channels session + its provider. The coordinator only
// backfills for THIS session's channel.
const SESSION = `${MAIN_AGENT_ID}-channels`
const PROVIDER = CHANNEL_PROVIDER

// State-machine tick / liveness-probe cadence while IDLE.
const TICK_MS = 5000
// Enter BACKFILLING only after the native reads DOWN this many consecutive
// probes -- a single transient process-tree race or a restart blip must not
// flip us into polling (which could 409 the recovering native).
const DOWN_DEBOUNCE = 2

// Transient-error backoff (5xx / network) while BACKFILLING.
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 60_000

// 409-cooldown: a 409 from getUpdates is AUTHORITATIVE proof the native poller
// is alive (it holds the token's getUpdates slot), even when the liveness probe
// reads DOWN -- which happens when the native bun poller is reparented (not a
// child of the resolved claude pid) and bot.pid is absent, so hasChannelPluginAlive
// false-negatives. Without this, the coordinator flapped ~every 13s (DOWN ->
// backfill -> 409 -> yield -> DOWN ...), 342x in 2.3h, churning the token with
// 409s (2026-06-03 incident). On a 409 we briefly refuse to re-enter BACKFILLING,
// overriding the flaky probe. If the native genuinely goes down, getUpdates
// SUCCEEDS (no 409) so no cooldown is set and normal backfill resumes.
//
// COOLDOWN LENGTH -- the real root-cause fix is the detached-claude reap
// (channel-poller-reap.ts), which removes the orphan that made the probe
// false-negative in the first place. With the probe accurate, this cooldown is
// only belt-and-suspenders against a TRANSIENT blip (e.g. a process-tree race
// while the native itself respawns). So we keep it SHORT: long enough to absorb
// such a transient and break any residual flap (flap period was ~13.5s), but
// short enough that a GENUINE native death is re-covered quickly. A long
// suppression would be a self-inflicted coverage gap -- this coordinator exists
// precisely to cover multi-minute native-down windows, and during the cooldown
// it backfills nothing. (No message LOSS even at the upper bound: native's
// recovery resumes getUpdates from its persisted offset, and Telegram retains
// updates ~24h; the cooldown only delays low-latency coverage.)
const NATIVE_409_COOLDOWN_MS = 90 * 1000

// The coordinator keeps its OWN state dir, separate from the plugin's
// ~/.claude/channels/telegram. Sharing it would let the plugin's orphan-PID
// watchdog SIGTERM our process (it kills "stale" pids in its bot.pid).
const STATE_DIR = process.env['COORDINATOR_STATE_DIR'] ?? join(homedir(), '.claude', 'channels', 'telegram-coordinator')
const PID_FILE = join(STATE_DIR, 'coordinator.pid')

type State = 'idle' | 'backfilling'
let state: State = 'idle'
let downStreak = 0
let stopping = false
// Epoch-ms until which a recent 409 has confirmed the native poller is up; while
// in this window we suppress BACKFILLING regardless of the liveness probe.
let nativeConfirmedUpUntil = 0

// Pure: are we inside the post-409 "native confirmed up" cooldown?
export function inNative409Cooldown(confirmedUpUntilMs: number, nowMs: number): boolean {
  return nowMs < confirmedUpUntilMs
}

// ---- token --------------------------------------------------------------

// Read the bot token from the coordinator's own STATE_DIR/.env (chmod 0600),
// falling back to the process env for local dev. NEVER log the token.
function readToken(): string {
  const fromEnv = process.env['TELEGRAM_BOT_TOKEN']
  if (fromEnv) return fromEnv
  const envPath = join(STATE_DIR, '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() === 'TELEGRAM_BOT_TOKEN') {
        let v = trimmed.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        return v
      }
    }
  } catch { /* no .env -- fall through to error */ }
  throw new Error(`TELEGRAM_BOT_TOKEN not found (checked env + ${envPath})`)
}

// ---- single-instance lock ------------------------------------------------

// Two pollers on one token = guaranteed 409. Refuse to start if another live
// coordinator already holds the pid file. Stale pid (process gone) is reclaimed.
export interface PidLockDeps {
  isAlive(pid: number): boolean // kill(pid, 0): true on success or EPERM, false on ESRCH
  // The process's command line. string = the command line; null = the process
  // does not exist (gone); undefined = could not be determined (ps missing, denied, timed out).
  argvOf(pid: number): string | null | undefined
  // Machine boot id (/proc/sys/kernel/random/boot_id). undefined = cannot read.
  // Optional: when absent (every fake deps in the pre-existing tests) the lock
  // behaves exactly as before -- legacy content, argv-based decisions.
  bootId?(): string | undefined
  // The RAW starttime of a process: /proc/<pid>/stat field 22, in clock ticks
  // since boot, as an integer. undefined on any failure (process gone, /proc
  // unreadable), never throws. Optional, same backward-compat rule as bootId.
  // Under one boot id a pid's raw tick is unique, immutable and EXACT -- it is
  // a single /proc read with no arithmetic on other clocks -- so THIS is the
  // lock's IDENTITY TOKEN (card c3f84534, defect B1): a recorded tick that no
  // longer matches the pid is proof of pid REUSE, decided without ps.
  startTicks?(pid: number): number | undefined
  // The process's command line read straight from /proc/<pid>/cmdline,
  // consulted BEFORE argvOf (card c3f84534 round 4, PR #2881 review). string =
  // the command line; undefined = /proc cannot tell (unreadable, empty for a
  // zombie or kernel thread, no /proc): argvOf (ps) decides then. Never null and
  // never throws: whether the process is gone is left to isAlive and argvOf.
  // Optional, same backward-compat rule as bootId.
  procArgvOf?(pid: number): string | undefined
}
export type PidLockResult =
  | { ok: true; reclaimed: number | null }
  | { ok: false; holder: number | null; reason: 'held' | 'unknown' | 'contention' }

// True when some whitespace-separated token of argv has a last path segment of
// exactly channel-coordinator.js / .ts (so `tail -f channel-coordinator.log` does not match).
export function isCoordinatorArgv(argv: string): boolean {
  return argv.split(/\s+/).some((tok) => {
    const base = tok.slice(tok.lastIndexOf('/') + 1)
    return base === 'channel-coordinator.js' || base === 'channel-coordinator.ts'
  })
}

function parsePid(raw: string): number | null {
  const t = raw.trim()
  if (!/^[1-9][0-9]*$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}

// Lock file formats (#c3f84534). Legacy: a single token, the pid (strict parse,
// exactly as before). New: "pid boot_id tick" -- three whitespace-separated
// tokens, pid matches the strict pid regex, boot_id is a non-empty token, tick
// is the RAW /proc/<pid>/stat field 22 starttime in clock ticks since boot.
// The third token is deliberately the RAW TICK and NOT the derived epoch ms of
// the first revision of this card: epoch ms is computed from three separately
// read clocks and MEASURED to jitter by 9 ms sample-to-sample (card c3f84534,
// defect B1, 2026-11-18: 40 samples, 9-10 distinct values), while the lock
// decision compares for EXACT equality -- so a live holder was misjudged as
// pid reuse, reclaimed, and two coordinators ended up on one token. Anything
// else is garbage (today's stale path).
type ParsedLock =
  | { pid: number; boot: null; tick: null } // legacy naked-pid lock
  | { pid: number; boot: string; tick: number } // new self-validating lock

function parseLockContent(raw: string): ParsedLock | null {
  const toks = raw.trim().split(/\s+/)
  if (toks.length === 1) {
    const pid = parsePid(toks[0] ?? '')
    return pid === null ? null : { pid, boot: null, tick: null }
  }
  if (toks.length !== 3) return null
  const [pidTok, bootTok, tickTok] = toks as [string, string, string]
  const pid = parsePid(pidTok)
  if (pid === null || !/^\S+$/.test(bootTok) || !/^[0-9]+$/.test(tickTok)) return null
  if (!Number.isSafeInteger(Number(tickTok))) return null
  return { pid, boot: bootTok, tick: Number(tickTok) }
}

// What we write for OURSELVES: the new format when both boot id and our own
// raw start tick are available, today's legacy content otherwise. The recorded
// tick must come from startTicks (exact, one /proc read), never from the
// derived epoch ms (jittering, defect B1) -- whatever we write here is
// what we must be able to match EXACTLY on the next start.
function ownLockContent(selfPid: number, deps: PidLockDeps): string {
  const boot = deps.bootId?.()
  if (typeof boot !== 'string') return String(selfPid)
  const tick = deps.startTicks?.(selfPid)
  if (typeof tick !== 'number') return String(selfPid)
  return `${selfPid} ${boot} ${tick}`
}

type LockVerdict =
  | { kind: 'ours' } // our own current lock: keep it, untouched
  | { kind: 'held'; holder: number } // another live coordinator holds it
  | { kind: 'unknown'; holder: number } // alive, cannot tell: refuse (fail closed)
  | { kind: 'stale' } // provably not a live holder: reclaim

const STALE: LockVerdict = { kind: 'stale' }

// Verdict for a holder pid already known to be alive: its command line decides.
// It is read from /proc/<pid>/cmdline first (procArgvOf: one file read, no child
// process, no timeout) and from ps only when /proc cannot tell (card c3f84534
// round 4, PR #2881 review). A live holder whose command line neither can read
// is refused (fail closed). The earlier start-time-vs-mtime reclaim is gone: it
// compared wall-clock values, so a forward clock step (NTP, VM resume) made a
// LIVE coordinator look younger than its own lock and reclaimed it -- two
// coordinators on one token.
function liveHolderVerdict(pid: number, deps: PidLockDeps): LockVerdict {
  const fromProc = deps.procArgvOf?.(pid)
  const argv = fromProc !== undefined ? fromProc : deps.argvOf(pid)
  if (argv === undefined) return { kind: 'unknown', holder: pid }
  return argv !== null && isCoordinatorArgv(argv) ? { kind: 'held', holder: pid } : STALE
}

// The legacy decision tree for a holder pid that is not us: liveness, then the
// command line (/proc first, then ps).
function legacyVerdict(pid: number, deps: PidLockDeps): LockVerdict {
  if (!deps.isAlive(pid)) return STALE
  return liveHolderVerdict(pid, deps)
}

// Decision tree for an existing lock, in order: garbage -> stale; our own pid
// -> keep (legacy, or new with identical tokens) / rewrite (our pid recorded
// before a reboot); new-format other pid -> boot_id and the RAW start tick
// decide without ps, falling back to the legacy tree when they cannot; legacy
// other pid -> the legacy tree above.
//
// B1 (card c3f84534, measured 2026-11-18): every equality below is on the RAW
// /proc tick, never on the derived epoch ms. Epoch ms jitters by ~9 ms between
// reads of the SAME live process (three separately-read clocks), so exact
// equality on it declared a live holder "pid reuse" -> STALE -> reclaimed ->
// two coordinators on one token. The raw tick is one /proc read: exact.
function verdictForExisting(lock: ParsedLock | null, selfPid: number, deps: PidLockDeps): LockVerdict {
  if (lock === null) return STALE // garbage: today's stale path
  if (lock.pid === selfPid) {
    if (lock.boot === null) return { kind: 'ours' } // our legacy lock: untouched
    const myBoot = deps.bootId?.()
    const myTick = deps.startTicks?.(selfPid)
    return myBoot === lock.boot && myTick === lock.tick
      ? { kind: 'ours' } // our current new-format lock: untouched
      : STALE // our pid, tokens from before a reboot: rewrite a fresh own lock
  }
  if (lock.boot === null) return legacyVerdict(lock.pid, deps)
  const myBoot = deps.bootId?.()
  if (myBoot === undefined) return legacyVerdict(lock.pid, deps) // cannot validate: conservative
  if (myBoot !== lock.boot) return STALE // written before the last reboot
  if (!deps.isAlive(lock.pid)) return STALE // holder process is gone
  const cur = deps.startTicks?.(lock.pid)
  if (cur === lock.tick) return { kind: 'held', holder: lock.pid } // same process since the lock was written: held, no ps needed
  if (cur !== undefined) return STALE // same boot, different tick: pid reuse
  return liveHolderVerdict(lock.pid, deps) // tick unreadable: argv-based tree (/proc first, then ps)
}

// A bare kill(pid, 0) is not enough: after a reboot or crash the recorded pid can
// belong to an unrelated process (pid reuse), so the holder must also look like a
// coordinator by its argv. A live pid whose argv cannot be read is treated as held
// (fail closed). Since #c3f84534 the lock records boot_id + the RAW start tick
// (/proc/<pid>/stat field 22), which makes pid reuse decidable WITHOUT ps (the
// thing that failed on the incident host): a different boot_id means the lock
// predates the last reboot; a different tick under the same boot means the pid
// was reused. The tick is used RAW (B1): the derived epoch-ms form of the first
// revision jittered 9 ms between reads of the same live process, so exact
// equality on it reclaimed a LIVE holder's lock. The holder's command line is
// read from /proc/<pid>/cmdline first and from ps only when /proc cannot tell;
// a live holder neither can read is refused, whatever the clocks say (round 4).
// The lock appears WITH its content: it is written to a pid-unique temp file and
// hard-linked into place, and link() fails with EEXIST like O_EXCL. A plain
// O_EXCL create exposed an empty file between the create and the write; a second
// starter read it as garbage, reclaimed it, and both won (CHCOORDRACE1118:
// 3 of 20 simultaneous starts on an earlier develop; a reader process saw the
// O_EXCL-created file empty 307 times in 85004 reads, the linked one never).
// Reclaiming a stale file re-reads it right before unlinking, which narrows but
// cannot fully close the window in which two starters act on the same stale file
// (Node has no flock). Attempts are bounded; if another starter keeps winning we
// refuse (the safe side).
export function tryAcquirePidLock(pidFile: string, selfPid: number, deps: PidLockDeps): PidLockResult {
  let reclaimed: number | null = null
  const tmp = `${pidFile}.${selfPid}.tmp`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // wx on the temp file too: a leftover (or planted symlink) is removed, never written through.
      try { unlinkSync(tmp) } catch { /* absent */ }
      writeFileSync(tmp, ownLockContent(selfPid, deps), { flag: 'wx', mode: 0o600 })
      linkSync(tmp, pidFile)
      return { ok: true, reclaimed }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    } finally {
      try { unlinkSync(tmp) } catch { /* absent */ }
    }
    let content: string
    try { content = readFileSync(pidFile, 'utf-8') } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
    const lock = parseLockContent(content)
    const verdict = verdictForExisting(lock, selfPid, deps)
    if (verdict.kind === 'ours') return { ok: true, reclaimed: null }
    if (verdict.kind === 'held') return { ok: false, holder: verdict.holder, reason: 'held' }
    if (verdict.kind === 'unknown') return { ok: false, holder: verdict.holder, reason: 'unknown' }
    // Stale: unlink only if the file is still exactly what the decision was based on.
    let again: string
    try { again = readFileSync(pidFile, 'utf-8') } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
    if (again !== content) continue
    try { unlinkSync(pidFile) } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }
    // Never report our own pid as reclaimed (the file held our pid from before
    // a reboot; the rewrite below is just a refresh).
    if (lock !== null && lock.pid !== selfPid) reclaimed = lock.pid
  }
  return { ok: false, holder: null, reason: 'contention' }
}

export const realPidLockDeps: PidLockDeps = {
  isAlive: (pid) => {
    try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM' }
  },
  // The command line straight from /proc/<pid>/cmdline (NUL-separated argv),
  // read before ps (card c3f84534 round 4): one file read, no child process and
  // no timeout. MEASURED (2026-11-18, WSL host): /proc/<pid>/cmdline has the same
  // owner and mode (0444) as /proc/<pid>/stat and /proc has no hidepid, so it is
  // readable wherever the start tick is. undefined on ANY failure and for an
  // empty file (a zombie or a kernel thread): argvOf (ps) decides then. Never throws.
  procArgvOf: (pid) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter((s) => s !== '').join(' ')
      return argv || undefined
    } catch { return undefined }
  },
  argvOf: (pid) => {
    // /bin/ps first (as elsewhere in the codebase), then ps from PATH for hosts
    // that have no /bin/ps (e.g. NixOS).
    // Empty output is "gone" only when kill(pid, 0) agrees: a ps that cannot
    // inspect a live process can print nothing too. Anything else is unknown.
    const goneOrUnknown = (): null | undefined => {
      try { process.kill(pid, 0); return undefined } catch (k) {
        return (k as NodeJS.ErrnoException)?.code === 'ESRCH' ? null : undefined
      }
    }
    for (const ps of ['/bin/ps', 'ps']) {
      try {
        return execFileSync(ps, ['-p', String(pid), '-o', 'args='], { timeout: 2000, encoding: 'utf-8' }).trim() || goneOrUnknown()
      } catch (err) {
        const e = err as { status?: number | null; stdout?: string; code?: string }
        if (e.code === 'ENOENT') continue
        // ps exits 1 with no output when the pid does not exist.
        if (e.status === 1 && !String(e.stdout ?? '').trim()) return goneOrUnknown()
        return undefined // denied, timed out, killed: unknown
      }
    }
    return undefined // no ps at all: unknown
  },
  // Machine boot id: changes on every reboot, so a lock whose boot_id differs
  // from the current one was written by a process that no longer exists.
  bootId: () => {
    try {
      const s = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim()
      return s || undefined
    } catch { return undefined }
  },
  // RAW process start tick: /proc/<pid>/stat field 22 (starttime in clock
  // ticks since boot), read straight out of the kernel with no arithmetic on
  // any other clock. This is the lock's IDENTITY TOKEN (card c3f84534, defect
  // B1): measured stable across 40 consecutive reads of a live pid, where the
  // derived epoch ms jitters by 9 ms. Returns undefined on ANY failure --
  // including a dead pid, whose /proc/<pid>/stat is gone -- and never throws.
  startTicks: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const r = stat.lastIndexOf(')')
      if (r < 0) return undefined
      const f = stat.slice(r + 2).split(' ')
      if (f[0] === 'Z' || f[0] === 'X') return undefined // zombie/dead: kill(pid,0) and the tick lie; undefined hands the decision to the ps-based tree (pre-c3f84534)
      const tok = f[19] // field 22 overall (index 19 after the last ')' + space); measured
      if (tok === undefined || !/^[0-9]+$/.test(tok)) return undefined
      const ticks = Number(tok)
      return Number.isSafeInteger(ticks) ? ticks : undefined
    } catch { return undefined }
  },
}

export function acquireSingleInstanceLock(pidFile: string = PID_FILE, deps: PidLockDeps = realPidLockDeps, exit: (code: number) => never = process.exit): void {
  if (!existsSync(dirname(pidFile))) mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 })
  const res = tryAcquirePidLock(pidFile, process.pid, deps)
  if (!res.ok) {
    if (res.reason === 'held') {
      logger.error({ prev: res.holder }, 'channel-coordinator: another live instance holds the pid lock, exiting')
    } else if (res.reason === 'unknown') {
      logger.error({ prev: res.holder }, 'channel-coordinator: the pid lock holder is alive but its command line cannot be read; refusing to start')
    } else {
      logger.error('channel-coordinator: could not acquire the pid lock (another starter kept winning); exiting')
    }
    exit(1)
  }
  if (res.ok && res.reclaimed != null) {
    logger.warn({ stalePid: res.reclaimed }, 'channel-coordinator: reclaiming stale pid file')
  }
}

function releaseLock(): void {
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, 'utf-8').trim() === String(process.pid)) unlinkSync(PID_FILE)
  } catch { /* best effort */ }
}

// ---- alerting ------------------------------------------------------------

// Best-effort Telegram alert to the owner via the existing notify.sh (which
// uses the project's own token+chat). Used for fatal (401) only -- a 409 here
// is the EXPECTED "native is back" signal, not an error worth alerting.
// Resolves when notify.sh has finished (or was killed at its 10 s timeout), so a
// caller that is about to exit can wait for the alert instead of guessing.
function sendAlert(message: string): Promise<void> {
  const script = join(PROJECT_ROOT, 'scripts', 'notify.sh')
  return new Promise((resolve) => {
    execFile('/bin/bash', [script, message], { timeout: 10_000 }, (err) => {
      if (err) logger.warn({ err }, 'channel-coordinator: notify.sh alert failed')
      resolve()
    })
  })
}

// ---- handoff content -----------------------------------------------------

// Neutralize any <channel ...> / </channel> the user typed, so their text can
// never break out of the channel frame we wrap it in below. (The message-router
// also scrubs untrusted/trusted-peer tags, but not <channel>.)
export function neutralizeChannelTags(text: string): string {
  return text.replace(/<\s*\/?\s*channel\b[^>]*>/gi, '[stripped-tag]')
}

// The topic of a message is part of the tag only while TELEGRAM_TOPICS_ENABLED
// is on, as with the native plugin, whose topics patch is applied only then.
function topicsEnabled(): boolean {
  return isSettingOn('TELEGRAM_TOPICS_ENABLED')
}

// Mirror the native plugin's <channel ...> block so the message-router can
// deliver it as channel-inbound and Marveen replies exactly as she would to a
// native message (reply with chat_id), while the body stays untrusted.
export function buildHandoffContent(ev: {
  kind: string
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  content: string
  tg_date: number | null
  meta?: Record<string, unknown>
}, topics: boolean = topicsEnabled()): string {
  const ts = ev.tg_date ? new Date(ev.tg_date * 1000).toISOString() : ''
  const voiceMeta = ev.meta?.voice as { file_id?: string } | undefined
  const voiceFileId = voiceMeta?.file_id ?? ''
  const thread = ev.meta?.message_thread_id
  const threadId = topics && Number.isSafeInteger(thread) && (thread as number) > 0 ? thread as number : null
  const attrs = [
    `source="telegram"`,
    ev.chat_id != null ? `chat_id="${ev.chat_id}"` : '',
    ev.message_id != null ? `message_id="${ev.message_id}"` : '',
    ev.username ? `user="${neutralizeChannelTags(ev.username).replace(/"/g, '')}"` : '',
    ev.user_id != null ? `user_id="${ev.user_id}"` : '',
    ts ? `ts="${ts}"` : '',
    threadId != null ? `message_thread_id="${threadId}"` : '',
    ev.kind !== 'message' ? `kind="${ev.kind}"` : '',
    voiceFileId ? `attachment_kind="voice"` : '',
    voiceFileId ? `attachment_file_id="${voiceFileId}"` : '',
  ].filter(Boolean).join(' ')
  const body = neutralizeChannelTags(ev.content || '(empty message)')
  return `<channel ${attrs}>\n${body}\n</channel>`
}

// KBDBACKFILLEXP1119: the Telegram plugin answers a tap on a reply button (kbd:) of a question older than
// TELEGRAM_REPLY_BUTTONS_MAX_AGE_HOURS with "expired" and delivers nothing (scripts/patch-telegram-plugin.py,
// _kbd_expiry_line). While the plugin is down the backfill must not deliver it either. The same rule: the age is
// counted from the question's send time (the callback's message date), 0 = never expire.
export function isExpiredKbdTap(ev: { kind: string; content: string; tg_date: number | null }, maxAgeHours: number, nowSec: number): boolean {
  if (ev.kind !== 'callback_query' || !ev.content.startsWith('kbd:')) return false
  if (!(maxAgeHours > 0) || ev.tg_date == null || !(ev.tg_date > 0)) return false
  return nowSec - ev.tg_date > maxAgeHours * 3600
}

function kbdMaxAgeHours(): number {
  try {
    const v = Number(getEffectiveSettingValue('TELEGRAM_REPLY_BUTTONS_MAX_AGE_HOURS'))
    return Number.isFinite(v) ? v : 0
  } catch { return 0 }
}

// ---- backoff -------------------------------------------------------------

// Exponential backoff with full jitter, capped. Math.random is fine here --
// this is a long-lived Node process, not a (replayable) workflow script.
export function transientBackoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(Math.random() * ceiling)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---- batch processing ----------------------------------------------------

// Process one getUpdates batch. For each update: normalize, dedup-insert, and
// (if newly inserted) hand off to Marveen. The returned offset only covers
// updates that are stored or deliberately skipped (unhandled kinds). If a store
// fails, the batch stops there: the failed update and everything after it are
// NOT covered by the offset, so Telegram redelivers them on the next
// getUpdates. Dedup on update_id makes that redelivery safe.
export function processBatch(updates: { update_id: number }[]): { offset: number | null; stalled: boolean } {
  let durable: number | null = null
  for (const raw of updates) {
    const ev = mapUpdate(raw as Parameters<typeof mapUpdate>[0])
    if (!ev) {
      // unhandled update kind: offset still advances past it
      durable = durable == null ? raw.update_id : Math.max(durable, raw.update_id)
      continue
    }
    if (isExpiredKbdTap(ev, kbdMaxAgeHours(), Math.floor(Date.now() / 1000))) {
      // dropped like an unhandled kind: the offset advances past it, nothing is stored or handed off
      durable = durable == null ? raw.update_id : Math.max(durable, raw.update_id)
      logger.info({ update_id: ev.update_id, chat_id: ev.chat_id }, 'channel-coordinator: expired reply-button tap dropped (TELEGRAM_REPLY_BUTTONS_MAX_AGE_HOURS)')
      continue
    }

    let ins: InsertResult
    try {
      ins = insertIncomingEvent(SOURCE, ev)
    } catch (err) {
      logger.error({ err, update_id: raw.update_id }, 'channel-coordinator: insertIncomingEvent failed; stopping the batch so Telegram redelivers it')
      return { offset: durable == null ? null : Math.min(durable, raw.update_id - 1), stalled: true }
    }
    durable = durable == null ? raw.update_id : Math.max(durable, raw.update_id)
    if (!ins.inserted || ins.eventId == null) continue // dedup: already handed off

    try {
      const agentMessageId = createHandoffMessage(buildHandoffContent(ev))
      markEventDelivered(ins.eventId, agentMessageId)
      logger.info({ update_id: ev.update_id, chat_id: ev.chat_id, kind: ev.kind, agentMessageId }, 'channel-coordinator: backfilled to main agent')
    } catch (err) {
      logger.error({ err, eventId: ins.eventId }, 'channel-coordinator: handoff failed; event left pending for replay')
    }
  }
  return { offset: durable, stalled: false }
}

// ---- reconcile (no-message-loss replay) ----------------------------------

// Re-hand-off events the message-router abandoned (agent_message failed after
// its 1h retry window) or that were never handed off (crash between insert and
// handoff). This is the invariant the whole decoupling exists for: a frozen
// main agent DELAYS a message, never LOSES it. Runs every tick in ALL states,
// because a message backfilled during a past window can still be abandoned by
// the router later while we sit idle. Idempotent: in-flight handoffs are
// excluded by getEventsNeedingHandoff, and a re-handoff creates a fresh
// agent_message rather than duplicating the source event.
function reconcilePending(): void {
  let events
  try {
    events = getEventsNeedingHandoff(SOURCE)
  } catch (err) {
    logger.error({ err }, 'channel-coordinator: reconcile query failed')
    return
  }
  for (const ev of events) {
    try {
      let parsedMeta: Record<string, unknown> = {}
      try { if (ev.meta) parsedMeta = JSON.parse(ev.meta) as Record<string, unknown> } catch {}
      const agentMessageId = createHandoffMessage(buildHandoffContent({
        kind: ev.kind,
        chat_id: ev.chat_id,
        user_id: ev.user_id,
        username: ev.username,
        message_id: ev.message_id,
        content: ev.content ?? '',
        tg_date: ev.tg_date,
        meta: parsedMeta,
      }))
      markEventDelivered(ev.id, agentMessageId)
      logger.warn({ update_id: ev.update_id, eventId: ev.id, agentMessageId }, 'channel-coordinator: re-queued abandoned/stranded inbound message')
    } catch (err) {
      logger.error({ err, eventId: ev.id }, 'channel-coordinator: reconcile re-handoff failed; will retry next cycle')
    }
  }
}

// ---- fatal --------------------------------------------------------------

// #1878 (10): the fatal alert used to be fire-and-forget plus a fixed 1.5 s
// sleep, so a notify.sh slower than that (a Slack round-trip, a Telegram retry)
// could be cut off by the exit. Wait for it, but never longer than the cap: a
// hung alert must not keep a dead coordinator around.
export const FATAL_ALERT_CAP_MS = 12_000

export async function alertBeforeExit(alert: () => Promise<void>, capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      alert().catch(() => { /* the alert's own failure is already logged */ }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, capMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function fatalExit(err: TelegramApiError, exit: (code: number) => never = process.exit): Promise<never> {
  logger.error({ msg: err.message }, 'channel-coordinator: fatal error, exiting')
  await alertBeforeExit(
    () => sendAlert(`${BOT_NAME} channel-coordinator FATAL: ${err.message}. Inbound backfill leallt amig nem javitod.`),
    FATAL_ALERT_CAP_MS,
  )
  return exit(1)
}

// ---- main loop (IDLE <-> BACKFILLING state machine) ----------------------

async function runLoop(token: string): Promise<void> {
  let transientAttempt = 0
  let stallAttempt = 0
  while (!stopping) {
    // No-message-loss replay runs every tick, regardless of state.
    reconcilePending()

    if (state === 'idle') {
      // Watch the native channel. Debounce DOWN readings so a momentary blip
      // (process-tree race, restart) does not flip us into polling. A recent
      // 409 overrides a DOWN reading: it proved the native poller is up, so we
      // distrust the (flaky) liveness probe until the cooldown expires.
      const down = probeNativeChannelDown(SESSION, PROVIDER) && !inNative409Cooldown(nativeConfirmedUpUntil, Date.now())
      downStreak = down ? downStreak + 1 : 0
      if (downStreak >= DOWN_DEBOUNCE) {
        try {
          // Seed poll_offset to the current high-water so we only deliver
          // messages that arrive DURING the outage; the detection-window
          // backlog (<= hw) is left for the native to deliver on recovery.
          const hw = await probeHighWater(token)
          if (hw != null) setOffset(SOURCE, hw)
          state = 'backfilling'
          transientAttempt = 0
          logger.warn({ session: SESSION, seededHighWater: hw }, 'channel-coordinator: native channel DOWN, entering BACKFILLING')
        } catch (err) {
          if (err instanceof TelegramApiError && err.kind === 'fatal') { await fatalExit(err) }
          // A 409 on the seed means the native is in fact polling -> stay idle
          // AND start the cooldown so a flaky DOWN probe can't immediately retry.
          if (err instanceof TelegramApiError && err.kind === 'conflict') {
            nativeConfirmedUpUntil = Date.now() + NATIVE_409_COOLDOWN_MS
            logger.info({ cooldownMs: NATIVE_409_COOLDOWN_MS }, 'channel-coordinator: high-water seed 409 -- native is polling, cooldown set, staying idle')
            downStreak = 0
          } else {
            logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'channel-coordinator: high-water seed failed, retrying next tick')
          }
        }
      }
      await sleep(TICK_MS)
      continue
    }

    // state === 'backfilling'
    // Yield the instant the native is back -- it owns inbound + the typing
    // indicator. Re-check before every poll.
    if (!probeNativeChannelDown(SESSION, PROVIDER)) {
      logger.info('channel-coordinator: native channel back UP, yielding to native (-> idle)')
      state = 'idle'; downStreak = 0
      continue
    }

    let updates: { update_id: number }[]
    try {
      updates = await getUpdates(token, getOffset(SOURCE) + 1, LONGPOLL_TIMEOUT_SEC, POLL_LIMIT)
      transientAttempt = 0
    } catch (err) {
      if (stopping) break
      if (err instanceof TelegramApiError && err.kind === 'fatal') { await fatalExit(err) }
      // 409 during backfill = the native grabbed the slot back. This is the
      // EXPECTED end-of-window signal, not an error: yield immediately, no
      // storm machinery, no tight loop. Set the cooldown -- the 409 proves the
      // native is up, so suppress re-entry even if the liveness probe keeps
      // reading DOWN (reparented poller / missing bot.pid false-negative).
      if (err instanceof TelegramApiError && err.kind === 'conflict') {
        nativeConfirmedUpUntil = Date.now() + NATIVE_409_COOLDOWN_MS
        logger.info({ cooldownMs: NATIVE_409_COOLDOWN_MS }, 'channel-coordinator: 409 during backfill -- native owns the slot again, cooldown set, yielding (-> idle)')
        state = 'idle'; downStreak = 0
        continue
      }
      if (err instanceof TelegramApiError && err.kind === 'rate_limit') {
        await sleep((err.retryAfterSec ?? 5) * 1000)
        continue
      }
      // transient (5xx / network / unexpected): exponential backoff, stay in backfilling
      await sleep(transientBackoffMs(Math.min(++transientAttempt, 6)))
      continue
    }

    if (updates.length === 0) continue // long-poll timed out; re-loop re-checks liveness

    // YIELD-BEFORE-HANDOFF: re-check the native did not just recover. If it did,
    // DISCARD this batch (do NOT hand off, do NOT advance the offset) and yield
    // -- the native will deliver these from its own offset. This closes the
    // recovery-overlap double-delivery window.
    if (!probeNativeChannelDown(SESSION, PROVIDER)) {
      logger.info({ batch: updates.length }, 'channel-coordinator: native recovered mid-batch, discarding + yielding (native will deliver)')
      state = 'idle'; downStreak = 0
      continue
    }

    const { offset, stalled } = processBatch(updates)
    // Persist offset ONLY after the batch is durable + handed off.
    if (offset != null) setOffset(SOURCE, offset)
    if (stalled) {
      // The store is failing: back off instead of re-fetching the same updates in a tight loop.
      await sleep(transientBackoffMs(Math.min(++stallAttempt, 6)))
    } else {
      stallAttempt = 0
    }
  }
}

// ---- bootstrap -----------------------------------------------------------

function installSignalHandlers(): void {
  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    logger.info({ sig }, 'channel-coordinator: shutting down')
    setTimeout(() => {
      releaseLock()
      closeIngestDb()
      process.exit(0)
    }, 3000)
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

async function main(): Promise<void> {
  const token = readToken()
  acquireSingleInstanceLock()
  initIngestDb()
  installSignalHandlers()
  logger.info({ stateDir: STATE_DIR, session: SESSION, provider: PROVIDER }, 'channel-coordinator: started in BACKFILL mode (idle while native is up)')
  await runLoop(token)
  releaseLock()
  closeIngestDb()
}

// Entry-point guard: only run the poller when executed directly (launchd /
// `node dist/channel-coordinator.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error({ err }, 'channel-coordinator: crashed')
    releaseLock()
    process.exit(1)
  })
}
