// /status collector (CMD920 3.5): every row is MEASURED and names its source.
//
// Rules:
//   - each row has its own try/catch: one throwing collector never takes the
//     others down; the broken row stays in the output with its error;
//   - what cannot be measured says so ("nem mérhető (<ok>)") and STAYS in the
//     output -- a vanished row would read as "nothing to report";
//   - nothing here touches the network. The Anthropic status is fetched by the
//     caller in parallel (routes/status.ts) and passed in, so a slow
//     status.claude.com never blocks the local rows, and `?only=system` stays
//     network-free.
//   - the local part is cached for 60 s.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, APP_TZ } from '../config.js'
import { readEnvFile } from '../env.js'
import { getDb, getDbFileSizeMb } from '../db.js'
import { resolveFromPath } from '../platform.js'
import {
  projectsDirFor,
  readActiveModelFromProjectDir,
  readContextTokensFromProjectDir,
} from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { readConfiguredMainModel } from './channel-monitor.js'
import { readModelFallbackConfig } from './model-fallback-store.js'
import { readMarveenTelegramConfig } from './telegram.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { readGateConfig } from './context-restart-gate-store.js'
import { readQuotaSnapshot, DEFAULT_MAX_AGE_SEC, type QuotaSnapshot, type QuotaWindow } from './quota.js'
import { getAgentRunningSince } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { listScheduledTasks } from './scheduled-tasks-io.js'
import { computeNextRun } from './cron.js'

const execFileAsync = promisify(execFile)

export interface StatusRow {
  label: string
  /** null only when the collector threw; see `error`. */
  value: string | null
  source: string
  error?: string
}

export interface StatusBlock {
  title: string
  rows: StatusRow[]
  /** See `formatSystemStatus`: the block is dropped, not just its rows blanked. */
  hideIfAllUnmeasurable?: boolean
}

export interface SystemStatus {
  generatedAt: number
  blocks: StatusBlock[]
}

export interface RowCollector {
  label: string
  source: string
  collect: () => string | Promise<string>
}

export interface BlockSpec {
  title: string
  rows: RowCollector[]
  /** See `formatSystemStatus`. */
  hideIfAllUnmeasurable?: boolean
}

export function notMeasurable(reason: string): string {
  return `nem mérhető (${reason})`
}

// Run every collector, isolating failures per row.
export async function runCollectors(specs: BlockSpec[], now = Date.now()): Promise<SystemStatus> {
  const blocks = await Promise.all(specs.map(async (b) => ({
    title: b.title,
    hideIfAllUnmeasurable: b.hideIfAllUnmeasurable,
    rows: await Promise.all(b.rows.map(async (r): Promise<StatusRow> => {
      try {
        return { label: r.label, value: await r.collect(), source: r.source }
      } catch (err) {
        return { label: r.label, value: null, source: r.source, error: err instanceof Error ? err.message : String(err) }
      }
    })),
  })))
  return { generatedAt: now, blocks }
}

// ELSOKOR922 Phase 7 A-smoke, tulajdonosi visszajelzés (2026-09-22): a
// fejléc-elv szerint alapból egy nem mérhető SOR a helyén marad ("egy eltűnt
// sor úgy nézne ki, mintha nincs mit jelenteni"), de a KERET blokk a
// legtöbb (headless szerver-) telepítésen MINDHÁROM sorára ugyanazt a
// "nem mérhető"-t adja, állandóan -- itt a három ismételt sor maga a zaj,
// nem egy eltűnő jel. `hideIfAllUnmeasurable` ezért a BLOKKOT dobja, nem a
// sort: csak akkor, ha MINDEN sora "nem mérhető (" (egy valódi hiba -- null
// value -- NEM számít annak, az marad, mert az tényleg jel).
export function formatSystemStatus(status: SystemStatus, extraRows: Record<string, StatusRow[]> = {}): string {
  const out: string[] = []
  for (const b of status.blocks) {
    const rows = [...b.rows, ...(extraRows[b.title] ?? [])]
    if (b.hideIfAllUnmeasurable && rows.every(r => r.value?.startsWith('nem mérhető ('))) continue
    if (out.length) out.push('')
    out.push(b.title)
    for (const r of rows) {
      out.push(`${r.label}: ${r.value ?? `hiba (${r.error ?? 'ismeretlen'})`}`)
    }
  }
  return out.join('\n')
}

// ---- pure helpers (exported for tests) --------------------------------------

export function formatClock(ms: number, tz: string = APP_TZ): string {
  return new Intl.DateTimeFormat('hu-HU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

export function formatDayClock(ms: number, tz: string = APP_TZ): string {
  return new Intl.DateTimeFormat('hu-HU', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

export function formatDuration(sec: number): string {
  if (sec < 0) sec = 0
  if (sec < 3600) return `${Math.floor(sec / 60)} perce`
  if (sec < 48 * 3600) return `${Math.floor(sec / 3600)} órája`
  return `${Math.floor(sec / 86400)} napja`
}

// A span without the "ago" suffix: "12 perc", "3 óra", "2 nap".
export function formatSpan(sec: number): string {
  if (sec < 0) sec = 0
  if (sec < 3600) return `${Math.floor(sec / 60)} perc`
  if (sec < 48 * 3600) return `${Math.floor(sec / 3600)} óra`
  return `${Math.floor(sec / 86400)} nap`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// Measured ids differ in detail per model (claude-opus-5 undated,
// claude-haiku-4-5-20251001 dated) and the configured one may carry a `[1m]`
// suffix. Compare normalized, PRINT raw (CMD920 3.3).
export function normalizeModelId(id: string): string {
  return id.trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
}

export function modelsDiffer(configured: string, measured: string): boolean {
  return normalizeModelId(configured) !== normalizeModelId(measured)
}

export interface TaskRunRow {
  status: string
  outcome: string | null
  completed_at: number | null
}

// task_runs broken down by how the run ENDED (utemezo-egeszseg-meres rule 1):
// a dispatched run is counted by its outcome, an undispatched one by its own
// status. skipped-precheck stays apart from skipped. Empty window -> "nincs
// adat", never "0 hiba".
export function summarizeTaskRuns(rows: TaskRunRow[]): string {
  if (rows.length === 0) return 'nincs adat (üres ablak)'
  const buckets = new Map<string, number>()
  const add = (k: string) => buckets.set(k, (buckets.get(k) ?? 0) + 1)
  for (const r of rows) {
    if (r.status === 'fired' || r.status === 'fired_late') {
      if (r.completed_at === null) add('nyitott')
      else add(r.outcome ?? 'lezárt, kimenet nélkül')
    } else {
      add(r.status)
    }
  }
  const done = buckets.get('done') ?? 0
  buckets.delete('done')
  const lost = (buckets.get('lost') ?? 0) + (buckets.get('lost-giveup') ?? 0)
  buckets.delete('lost')
  buckets.delete('lost-giveup')
  const parts = [`lefutott ${done}`]
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    parts.push(`${k} ${n}`)
  }
  parts.push(`elveszett ${lost}`)
  return parts.join(' · ')
}

// Cache hit ratio over a fixed window (CMD920 open question 2: last 24 h):
// cache_read / (input + cache_read + cache_creation) of the assistant turns.
export function cacheHitRatio(lines: string[], sinceMs: number): number | null {
  let read = 0
  let total = 0
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    try {
      const e = JSON.parse(line)
      const ts = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
      if (!Number.isFinite(ts) || ts < sinceMs) continue
      const u = e?.message?.usage
      if (!u || typeof u !== 'object') continue
      const inp = Number(u.input_tokens) || 0
      const cr = Number(u.cache_read_input_tokens) || 0
      const cc = Number(u.cache_creation_input_tokens) || 0
      read += cr
      total += inp + cr + cc
    } catch { /* malformed line */ }
  }
  return total > 0 ? read / total : null
}

function quotaWindowText(w: QuotaWindow | null): string {
  if (!w) return notMeasurable('nincs ilyen ablak a leolvasásban')
  if (w.expired) return notMeasurable('az ablak lejárt, azóta nincs új leolvasás')
  const reset = w.resetsAt !== null ? ` · nullázódik ${formatDayClock(w.resetsAt * 1000)}` : ''
  return `${Math.round(w.usedPercentage)}%${reset}`
}

export function formatQuota(q: QuotaSnapshot): { fiveHour: string; sevenDay: string } {
  if (q.status === 'missing') {
    const why = q.reason === 'no-file' ? 'nincs keret-leolvasás a store-ban'
      : q.reason === 'no-rate-limits' ? 'a leolvasásban nincs keret-adat (API kulcs?)'
        : 'a keret-fájl olvashatatlan'
    return { fiveHour: notMeasurable(why), sevenDay: notMeasurable(why) }
  }
  if (q.status === 'stale') {
    const why = `elavult leolvasás, ${formatDuration(q.ageSec ?? 0)}`
    return { fiveHour: notMeasurable(why), sevenDay: notMeasurable(why) }
  }
  return { fiveHour: quotaWindowText(q.fiveHour), sevenDay: quotaWindowText(q.sevenDay) }
}

// ---- the live collectors ----------------------------------------------------

// Telegram plugin patch (scripts/patch-telegram-plugin.py, review on #1529):
// when it is missing, the plugin answers /status and /help itself, and that
// fallback must not be silent. Measured now, not only at channel start: the
// state file names the cache the last start patched and why a file failed;
// each cached version's server.ts is re-read for the marker, so a plugin
// version that arrived after the start shows up too.
export const PLUGIN_PATCH_MARKER = 'MARVEEN-PATCH(elsokor922-d4)'
// The two independent patches, each with what the owner loses without it.
const PLUGIN_PATCHES = [
  { name: 'd4', marker: PLUGIN_PATCH_MARKER, label: '', fallback: 'a /status és a /help a plugin saját válasza' },
  { name: 'fwd', marker: 'MARVEEN-PATCH(elsokor922-fwd)', label: ' (továbbítás-jelölő)', fallback: 'egy továbbított parancs úgy fut, mint a begépelt' },
]

export function telegramPluginPatchStatus(stateFile = join(STORE_DIR, 'telegram-plugin-patch.json')): string {
  if (!existsSync(stateFile)) return 'nincs adat (a csatorna-indítás még nem futtatta a patchert; nem Telegram csatorna?)'
  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
    root?: string
    files?: Array<{ version: string; status: string; patches?: Record<string, string> }>
  }
  if (!state.root) return notMeasurable('az állapotfájlban nincs cache-útvonal')
  const base = join(state.root, 'claude-plugins-official', 'telegram')
  const versions = existsSync(base) ? readdirSync(base).filter(v => existsSync(join(base, v, 'server.ts'))).sort() : []
  if (versions.length === 0) return `nincs Telegram plugin a cache-ben (${state.root})`
  const texts = new Map(versions.map(v => [v, readFileSync(join(base, v, 'server.ts'), 'utf-8')]))
  const lines: string[] = []
  for (const p of PLUGIN_PATCHES) {
    const missing: string[] = []
    for (const v of versions) {
      if (texts.get(v)!.includes(p.marker)) continue
      const file = state.files?.find(f => f.version === v)
      const recorded = file ? (file.patches?.[p.name] ?? file.status) : undefined
      const why = !recorded ? 'új verzió, a következő csatorna-indításkor kerül rá'
        : recorded === 'patched' || recorded === 'already' ? 'a fájl az indítás óta cserélődött'
        : recorded
      missing.push(`${v} (${why})`)
    }
    if (missing.length) lines.push(`HIÁNYZIK${p.label}: ${missing.join(', ')} · ${p.fallback}`)
  }
  if (lines.length === 0) return `rendben (${versions.join(', ')})`
  return lines.join('; ')
}

function newestTranscript(): string | null {
  const dir = projectsDirFor(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID))
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return files.length ? join(dir, files[0].f) : null
}

export function configuredModelWithSource(): { model: string; source: string } {
  const model = readConfiguredMainModel(PROJECT_ROOT)
  const env = readEnvFile(['MAIN_AGENT_MODEL']).MAIN_AGENT_MODEL?.trim()
  if (env) return { model, source: '.env MAIN_AGENT_MODEL' }
  try {
    const parsed = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    if (typeof parsed?.model === 'string' && parsed.model.trim()) return { model, source: '.claude/settings.json' }
  } catch { /* fall through */ }
  return { model, source: 'szállított alapérték' }
}

function dirSizeBytes(dir: string, budget = { entries: 50_000 }): number {
  let total = 0
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (--budget.entries < 0) throw new Error('túl sok fájl a méréshez')
    const p = join(dir, ent.name)
    if (ent.isDirectory()) total += dirSizeBytes(p, budget)
    else if (ent.isFile()) total += statSync(p).size
  }
  return total
}

function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function msOf(v: number): number {
  return v > 1e12 ? v : v * 1000
}

export function liveBlockSpecs(now = Date.now()): BlockSpec[] {
  return [
    {
      title: 'MARVEEN',
      rows: [
        {
          label: 'Verzió', source: 'package.json, git log -1',
          collect: async () => {
            const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')) as { version?: string }
            let commit = ''
            try {
              const { stdout } = await execFileAsync('git', ['-C', PROJECT_ROOT, 'log', '-1', '--format=%h, %cs'], { timeout: 5_000 })
              commit = ` (${stdout.trim()})`
            } catch {
              commit = ' (commit nem mérhető: nincs git)'
            }
            return `${pkg.version ?? '?'}${commit}`
          },
        },
        {
          label: 'Fő session', source: 'tmux #{session_created}',
          collect: () => {
            const since = getAgentRunningSince(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
            if (since === null) return notMeasurable('a tmux session nem található')
            return `fut, ${formatDuration(Math.floor(now / 1000) - since)}`
          },
        },
        {
          label: 'Dashboard', source: 'process.uptime()',
          collect: () => `fut, ${formatDuration(Math.floor(process.uptime()))}`,
        },
        {
          label: 'Modell', source: 'transzkript (mérve), konfig-lánc (beállítva)',
          collect: () => {
            const measured = readActiveModelFromProjectDir(PROJECT_ROOT, undefined, configDirFor(MAIN_AGENT_ID))
            const conf = configuredModelWithSource()
            const m = measured ? `${measured} (mérve)` : notMeasurable('nincs assistant-sor a transzkriptben')
            const warn = measured && modelsDiffer(conf.model, measured) ? ' · ELTÉR a beállítottól' : ''
            return `${m} · beállítva ${conf.model} (${conf.source})${warn}`
          },
        },
        {
          label: 'Fallback', source: 'store/model-fallback.json',
          collect: () => {
            const cfg = readModelFallbackConfig()
            return `${cfg.enabled ? 'be' : 'ki'} · ${cfg.chain.join(' -> ')}`
          },
        },
        {
          label: 'Auth', source: 'env',
          collect: () => {
            const env = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])
            if (process.env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) return 'OAuth token (env)'
            if (process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY) return 'API kulcs (env)'
            return notMeasurable('nincs env-token; a CLI saját bejelentkezése')
          },
        },
        {
          label: 'Kontextus', source: 'transzkript usage, store/context-restart-gate.json',
          collect: () => {
            const tokens = readContextTokensFromProjectDir(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID))
            const gate = readGateConfig(MAIN_AGENT_ID)
            const clear = gate.enabled ? `/clear küszöb ${formatTokens(gate.thresholdTokens)}` : '/clear gate kikapcsolva'
            return `${tokens === null ? notMeasurable('nincs usage a transzkriptben') : formatTokens(tokens)} · ${clear}`
          },
        },
        {
          label: 'Cache', source: 'transzkript usage, utolsó 24 óra',
          collect: () => {
            const file = newestTranscript()
            if (!file) return notMeasurable('nincs transzkript')
            const ratio = cacheHitRatio(readFileSync(file, 'utf-8').split('\n'), now - 24 * 3600_000)
            return ratio === null ? notMeasurable('nincs usage az utolsó 24 órában') : `${Math.round(ratio * 100)}% találat (24 óra)`
          },
        },
      ],
    },
    {
      title: 'KERET',
      hideIfAllUnmeasurable: true,
      rows: (() => {
        const read = () => readQuotaSnapshot(
          join(STORE_DIR, '.claude-rate-limits.json'),
          Math.floor(now / 1000),
          Number(process.env.QUOTA_MAX_AGE_SEC) || DEFAULT_MAX_AGE_SEC,
        )
        return [
          { label: '5 órás', source: 'store/.claude-rate-limits.json', collect: () => formatQuota(read()).fiveHour },
          { label: 'Heti', source: 'store/.claude-rate-limits.json', collect: () => formatQuota(read()).sevenDay },
          { label: 'Előfizetés', source: '-', collect: () => notMeasurable('a keret-leolvasás nem hordozza a csomag nevét') },
        ]
      })(),
    },
    {
      title: 'ÜTEMEZŐ (24 óra)',
      rows: [
        {
          label: 'Körök', source: 'task_runs, kimenet szerint',
          collect: () => {
            const rows = getDb().prepare(
              'SELECT status, outcome, completed_at FROM task_runs WHERE ts >= ?',
            ).all(now - 24 * 3600_000) as TaskRunRow[]
            return summarizeTaskRuns(rows)
          },
        },
        {
          label: 'Következő', source: 'scheduled-tasks cron',
          collect: () => {
            let best: { name: string; at: number } | null = null
            for (const t of listScheduledTasks()) {
              if (!t.enabled) continue
              try {
                const at = computeNextRun(t.schedule) * 1000
                if (!best || at < best.at) best = { name: t.name, at }
              } catch { /* invalid cron: /jobs shows it */ }
            }
            return best ? `${best.name} ${formatDayClock(best.at)}` : 'nincs engedélyezett feladat'
          },
        },
      ],
    },
    {
      title: 'CSATORNA',
      rows: [
        {
          // The plugin's own /status used to answer "Paired as ..."; the D-4
          // patch takes that handler out, so the pairing has to be measured
          // here or it disappears from the chat entirely (owner, 2026-09-23).
          label: 'Párosítás', source: 'channels/telegram/.env + getMe cache',
          collect: () => {
            const cfg = readMarveenTelegramConfig()
            if (!cfg.hasTelegram) return notMeasurable('nincs bot-token a csatorna .env-jében')
            const chat = resolveOwnerChatId()
            // The cache may or may not carry the leading @ -- normalise, never double it.
            const bot = cfg.botUsername ? `@${cfg.botUsername.replace(/^@+/, '')}` : notMeasurable('a bot neve még nincs lekérdezve')
            return `${bot} · tulajdonos chat: ${chat ?? notMeasurable('nincs ALLOWED_CHAT_ID')}`
          },
        },
        {
          label: 'Forgalom', source: 'conversation_log',
          collect: () => {
            const q = getDb().prepare(
              'SELECT direction, MAX(created_at) AS last FROM conversation_log WHERE agent_id = ? GROUP BY direction',
            ).all(MAIN_AGENT_ID) as Array<{ direction: string; last: number | null }>
            const get = (d: string) => q.find(r => r.direction === d)?.last ?? null
            const fmt = (v: number | null) => v === null ? 'nincs' : formatDayClock(msOf(v))
            return `bejövő ${fmt(get('in'))} · kimenő ${fmt(get('out'))}`
          },
        },
        {
          label: 'Telegram plugin-patch', source: 'store/telegram-plugin-patch.json, server.ts jelölő',
          collect: () => telegramPluginPatchStatus(),
        },
        {
          label: 'Hiba-napló (24 óra)', source: 'store/channels.error.log mtime',
          collect: () => {
            const f = join(STORE_DIR, 'channels.error.log')
            if (!existsSync(f)) return 'nincs hiba-napló fájl'
            const m = statSync(f).mtimeMs
            return now - m < 24 * 3600_000 ? `új bejegyzés, utolsó ${formatDayClock(m)}` : 'nincs új bejegyzés'
          },
        },
      ],
    },
    {
      title: 'RENDSZER',
      rows: [
        {
          label: 'Claude Code', source: 'claude --version',
          collect: async () => {
            const { stdout } = await execFileAsync(resolveFromPath('claude'), ['--version'], { timeout: 10_000 })
            return stdout.trim().split('\n')[0]
          },
        },
        {
          label: 'Tárhely', source: 'stat, statfs',
          collect: () => {
            const db = getDbFileSizeMb()
            const fs = statfsSync(STORE_DIR)
            let store: string
            try { store = mb(dirSizeBytes(STORE_DIR)) } catch (err) { store = notMeasurable(err instanceof Error ? err.message : String(err)) }
            return `DB ${db === null ? notMeasurable('stat hiba') : `${db} MB`} · store ${store} · szabad ${mb(Number(fs.bavail) * Number(fs.bsize))}`
          },
        },
      ],
    },
  ]
}

const CACHE_MS = 60_000
let cache: { at: number; value: SystemStatus } | null = null

export async function getSystemStatus(opts: { now?: number; specs?: BlockSpec[]; noCache?: boolean } = {}): Promise<SystemStatus> {
  const now = opts.now ?? Date.now()
  if (!opts.noCache && !opts.specs && cache && now - cache.at < CACHE_MS) return cache.value
  const value = await runCollectors(opts.specs ?? liveBlockSpecs(now), now)
  if (!opts.specs) cache = { at: now, value }
  return value
}

export function _resetSystemStatusCacheForTest(): void {
  cache = null
}
