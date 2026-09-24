// The builtin owner commands (CMD920 3.2), read side.
//
// Every reply is measured state with its source; what cannot be measured says
// so. The writes of this list (/model, /model default, /context clear, /new,
// /clear) are registered as PLANNED here and replaced by the next release with
// the same `usage`; the nonce writes (/runs stop, /jobs on|off|run|skip,
// /approvals approve|reject|renew) stay planned (CMD920 2.).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, OWNER_NAME, APP_TZ, BOT_NAME } from '../config.js'
import {
  listApprovals,
  listKanbanCards,
  getKanbanCard,
  getKanbanComments,
  listTaskRunHistory,
  type Approval,
  type KanbanCard,
} from '../db.js'
import {
  registerCommand,
  renderHelp,
  listCommands,
  listInvalidCustomCommands,
  type CommandContext,
} from './commands.js'
import {
  getSystemStatus,
  formatSystemStatus,
  formatDayClock,
  formatDuration,
  formatSpan,
  formatTokens,
  configuredModelWithSource,
  modelsDiffer,
  notMeasurable,
  type StatusRow,
} from './system-status.js'
import { fetchAnthropicStatus } from './routes/status.js'
import { collectQueue, formatBlocks, collectRuns, formatRunsList, formatRunDetail } from './queue-view.js'
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir, readLastAssistantModel } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { readGateConfig, readGateRunState } from './context-restart-gate-store.js'
import { getAgentRunningSince } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { listScheduledTasks, type ScheduledTask } from './scheduled-tasks-io.js'
import { computeNextRun } from './cron.js'
import { getTokenSummary, getModelDistribution } from './token-usage.js'
import { registerModelWriteCommands, readModelChoices as readChoiceList, readHold, readLastSent, readEffortSent, readConfiguredEffort, withRetry, MODEL_CHOICES_FILE, MODEL_HOLD_FILE, MODEL_LAST_SENT_FILE, EFFORT_SENT_FILE, EFFORT_LEVELS, type LastSent, type HoldState, modelSupportsEffort } from './main-model.js'
import { contextClear } from './session-control.js'

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

// ---- /status ----------------------------------------------------------------

async function statusText(): Promise<string> {
  // The external lookup runs in parallel and never blocks the local rows.
  const [system, anthropic] = await Promise.all([
    getSystemStatus(),
    fetchAnthropicStatus().catch(() => null),
  ])
  const row: StatusRow = {
    label: 'Anthropic',
    source: 'status.claude.com',
    value: anthropic === null || anthropic.error
      ? notMeasurable('a status.claude.com nem válaszolt')
      : anthropic.overall,
  }
  // The owner-facing Modell row (same wording as /model); the /api/status JSON
  // keeps its technical value.
  const ms = modelStateLine(modelSummaryInput())
  const owner = {
    ...system,
    blocks: system.blocks.map(b => ({
      ...b,
      rows: b.rows.map(r => r.label === 'Modell' ? { ...r, value: ms.line + (ms.warn ? ' · ⚠️ eltér, l. /model' : '') } : r),
    })),
  }
  return formatSystemStatus(owner, { RENDSZER: [row] })
}

// ---- /model (status) --------------------------------------------------------

// A /model effort sent in this session wins over the configured default: the
// CLI takes it at once, and the transcript never carries it, so the status
// could only name the config before (ELSOKOR922 Phase 7 A-smoke).
export function effortLine(
  configured: { value: string; source: string } | null,
  sent: { level: string; at: number } | null,
): string {
  const v = sent
    ? `${sent.level} (elküldve ${formatDayClock(sent.at)})`
    : configured ? `${configured.value} (${configured.source})` : 'nincs beállítva (a CLI alapértéke)'
  return `Effort: ${v} · visszamérni nem tudjuk`
}

// The "Most fut" block. A measurement is only as fresh as the last assistant
// line: it is shown with its time, a /model sent after it is named as not yet
// measured, and the "eltér" warning compares against what SHOULD run now (the
// hold's model during a hold, else the configured one) -- ELSOKOR922 Phase 7
// A-smoke: after the 14:52 revert, /model still read "opus" from the 14:47
// turn and warned that it differed from the configured sonnet.
export function measuredModelLines(
  measured: { model: string; atMs: number } | null,
  lastSent: LastSent | null,
  holdModel: string | null,
  configured: string,
): { head: string[]; warn: string | null } {
  const head: string[] = []
  const pending = lastSent !== null && (measured === null || lastSent.at > measured.atMs)
  if (pending && lastSent?.acked) {
    // The CLI confirmed the switch after the last measured turn: that turn's
    // model is history. Owner feedback: "Átváltva" next to a "Most fut" still
    // naming the old model read as a contradiction.
    head.push(`Most fut: ${lastSent.model} (váltva ${formatDayClock(lastSent.at)}, a Claude Code visszaigazolta; rajta még nem futott kör)`)
  } else {
    head.push(`Most fut: ${measured ? `${measured.model} (utolsó kör ${formatDayClock(measured.atMs)})` : notMeasurable('nincs assistant-sor a transzkriptben')}`)
    if (pending && lastSent) head.push(`Azóta: /model ${lastSent.model} elküldve ${formatDayClock(lastSent.at)}, visszaigazolás nélkül; a következő kör méri`)
  }
  const expected = holdModel ?? configured
  const warn = measured && !pending && modelsDiffer(expected, measured.model)
    ? `⚠️ A futó modell eltér a ${holdModel ? 'tartásétól' : 'beállítottól'}.`
    : null
  return { head, warn }
}

// ---- /model: the owner's view (owner feedback 2026-09-24) -------------------
//
// The detailed view (model ids, config sources, measurement times) read like a
// debug dump on Telegram: "Most fut: nem mérhető (nincs assistant-sor ...)",
// "(.env MAIN_AGENT_MODEL)", "visszamérni nem tudjuk". This view says what
// runs, for how long, and what to type; the old text is /model details.

export interface ModelSummaryInput {
  measured: { model: string; atMs: number } | null
  lastSent: LastSent | null
  hold: HoldState | null
  configured: string
  effortConfigured: string | null
  effortSent: string | null
  choices: Array<{ name: string; id: string; purpose?: string }> | null
  now: number
}

// A choice's short name for a model id (opus, sonnet, ...), else the id itself.
export function shortModelName(id: string | null, choices: ModelSummaryInput['choices']): string {
  if (!id) return '?'
  const c = (choices ?? []).find(x => !modelsDiffer(x.id, id))
  return c ? c.name : id
}

// "16:20" when it is today, "09. 25. 16:20" otherwise.
function clockShort(ms: number, now: number): string {
  const a = formatDayClock(ms), b = formatDayClock(now)
  return a.slice(0, -5) === b.slice(0, -5) ? a.slice(-5) : a
}

function purposeShort(p?: string): string {
  return (p ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
}

// The one-line model state, shared by /model and the /status "Modell" row.
export function modelStateLine(i: ModelSummaryInput): { line: string; warn: string | null } {
  const short = (id: string | null) => shortModelName(id, i.choices)
  const pending = i.lastSent !== null && (i.measured === null || i.lastSent.at > i.measured.atMs)
  const expected = i.hold?.model ?? i.configured
  let line: string
  if (i.hold?.model) {
    line = `${short(i.hold.model)}, ideiglenes, ${clockShort(i.hold.until, i.now)}-ig (még ${formatSpan(Math.round((i.hold.until - i.now) / 1000))})`
  } else {
    line = `${short(i.configured)} (alap)`
  }
  if (pending && i.lastSent && !i.lastSent.acked) line += ', a váltást a Claude Code még nem igazolta vissza'
  else if (i.measured === null && !pending) line += ', a következő körtől mérem'
  const warn = i.measured && !pending && modelsDiffer(expected, i.measured.model)
    ? `⚠️ Most ${short(i.measured.model)} fut, pedig a ${i.hold?.model ? 'tartás' : 'beállítás'} ${short(expected)}. Lehetséges ok: kvóta miatti tartalék-modell vagy egy kézi váltás. A következő körtől újramérem.`
    : null
  return { line, warn }
}

export function modelSummary(i: ModelSummaryInput): string {
  const short = (id: string | null) => shortModelName(id, i.choices)
  const { line, warn } = modelStateLine(i)
  const out: string[] = [`Modell: ${line}`]
  if (warn) out.push(warn)
  if (i.hold?.model && i.hold.revert_to) out.push(`Utána vissza: ${short(i.hold.revert_to)}`)
  const effort = i.hold?.effort ?? i.effortSent ?? i.effortConfigured
  if (effort) {
    const tag = i.hold?.effort ? ', ideiglenes' : i.effortSent ? '' : ' (alap)'
    out.push(`Effort: ${effort}${tag}`)
  }
  if (!i.hold) out.push('Tartás: nincs')
  out.push('')
  if (i.choices === null) out.push('Választható: csak a beállított modell')
  else out.push(`Választható: ${i.choices.map(c => purposeShort(c.purpose) ? `${c.name} (${purposeShort(c.purpose)})` : c.name).join(' · ')}`)
  const current = short(i.hold?.model ?? i.configured)
  const example = (i.choices ?? []).find(c => c.name !== current)?.name
  out.push([
    example ? `Váltás: /model ${example} 30m` : null,
    i.hold ? 'vissza most: /model default' : null,
    'súgó: /model ?',
  ].filter(Boolean).join(' · '))
  return out.join('\n')
}

export function modelHelpText(i: ModelSummaryInput = modelSummaryInput()): string {
  const names = (i.choices ?? []).map(c => c.name)
  const withEffort = (i.choices ?? []).filter(c => modelSupportsEffort(c.id)).map(c => c.name)
  const a = names[0] ?? 'opus'
  const e = withEffort[0] ?? a
  return [
    '/model – melyik modell fut, és váltás',
    '',
    '/model            mi fut most, meddig',
    '/model details    technikai részletek',
    '/model default    vissza az alapra, most',
    '',
    'Váltás: /model <modell> [<effort>] [<idő>|keep]',
    `  modell: ${names.length ? names.join(' · ') : 'csak a beállított'}`,
    `  effort: ${EFFORT_LEVELS.join(' · ')}${names.some(n => !withEffort.includes(n)) ? ` (nincs: ${names.filter(n => !withEffort.includes(n)).join(', ')})` : ''}`,
    '  idő: 30m, 2h (alap: 2 óra) · keep = tartósan',
    '',
    'Példák:',
    `  /model ${a} 30m`.padEnd(24) + 'fél órára, utána vissza',
    `  /model ${e} high 2h`.padEnd(24) + 'magas efforttal, 2 órára',
    '  /model high 1h'.padEnd(24) + 'csak az effort, 1 órára',
    `  /model ${a} keep`.padEnd(24) + 'tartósan, újraindulás után is',
  ].join('\n')
}

export function modelSummaryInput(now = Date.now()): ModelSummaryInput {
  const conf = configuredModelWithSource()
  const h = readHold(MODEL_HOLD_FILE)
  const since = getAgentRunningSince(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
  let choices: ModelSummaryInput['choices'] = null
  try {
    const c = readChoiceList(MODEL_CHOICES_FILE, conf.model)
    if (c.fromFile) choices = c.choices
  } catch { /* the details view names the error */ }
  return {
    measured: readLastAssistantModel(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID)),
    lastSent: readLastSent(MODEL_LAST_SENT_FILE),
    hold: h.state ?? null,
    configured: conf.model,
    effortConfigured: readConfiguredEffort()?.value ?? null,
    effortSent: readEffortSent(EFFORT_SENT_FILE, since === null ? null : since * 1000)?.level ?? null,
    choices,
    now,
  }
}

export function modelStatusText(): string {
  const lines: string[] = []
  const conf = configuredModelWithSource()
  const h = readHold(MODEL_HOLD_FILE)
  const m = measuredModelLines(
    readLastAssistantModel(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID)),
    readLastSent(MODEL_LAST_SENT_FILE),
    h.state?.model ?? null,
    conf.model,
  )
  lines.push(...m.head)
  lines.push(`Beállítva: ${conf.model} (${conf.source})`)
  if (m.warn) lines.push(m.warn)
  const since = getAgentRunningSince(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
  lines.push(effortLine(readConfiguredEffort(), readEffortSent(EFFORT_SENT_FILE, since === null ? null : since * 1000)))
  const hold = h.error
    ? notMeasurable(`a main-model-hold.json olvashatatlan: ${h.error}`)
    : h.state
      ? `${[h.state.model, h.state.effort ? `effort ${h.state.effort}` : null].filter(Boolean).join(' + ')}`
        + ` eddig: ${formatDayClock(h.state.until)}, utána vissza: `
        + `${[h.state.revert_to, h.state.effort ? (h.state.revert_effort ? `effort ${h.state.revert_effort}` : 'effort: nincs alapérték, kézi') : null].filter(Boolean).join(' + ')}`
        + `${h.state.verify_pending ? ' (a váltás még nincs visszamérve)' : ''}`
      : 'nincs'
  lines.push(`Tartás: ${hold}`)
  lines.push('')
  let choices: string
  try {
    const c = readChoiceList(MODEL_CHOICES_FILE, conf.model)
    choices = !c.fromFile
      ? `csak a konfigurált modell (${conf.model}); a store/model-choices.json hiányzik`
      : '\n' + c.choices.map(x => `- ${x.name} = ${x.id}${x.purpose ? ` (${x.purpose})` : ''}`).join('\n')
  } catch (err) {
    choices = notMeasurable(`a model-choices.json olvashatatlan: ${err instanceof Error ? err.message : String(err)}`)
  }
  lines.push(`Választható: ${choices}`)
  lines.push('')
  // ELSOKOR922 Phase 7 A-smoke, tulajdonosi visszajelzés (2026-09-22): a
  // sima /model státusz nem mondta meg, HOGYAN kell váltani -- a szintaxis
  // csak a /help-ben (a registry `usage` mezőjében) volt látható, itt nem.
  lines.push(`Váltás: /model [<választás>] [<${EFFORT_LEVELS.join('|')}>] [<idő>|keep] · pl. /model opus 30m, /model opus low 4m, /model low 5m, /model opus keep`)
  lines.push('Vissza az alapra: /model default')
  return lines.join('\n')
}

// ---- /context (status) ------------------------------------------------------

export function contextStatusText(now = Date.now()): string {
  const tokens = readContextTokensFromProjectDir(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID))
  const gate = readGateConfig(MAIN_AGENT_ID)
  const state = readGateRunState(MAIN_AGENT_ID)
  const since = getAgentRunningSince(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
  return [
    `Kontextus: ${tokens === null ? notMeasurable('nincs usage a transzkriptben') : formatTokens(tokens)}`,
    `/clear küszöb: ${gate.enabled ? formatTokens(gate.thresholdTokens) : 'a gate ki van kapcsolva'}`,
    `Session kora: ${since === null ? notMeasurable('a tmux session nem található') : formatDuration(Math.floor(now / 1000) - since)}`,
    `Utolsó ürítés: ${state.lastClearAt ? formatDayClock(state.lastClearAt) : 'nincs feljegyezve'}`,
  ].join('\n')
}

// ---- /jobs ------------------------------------------------------------------

export function nextRunText(schedule: string, tz: string = APP_TZ): string {
  try {
    return formatDayClock(computeNextRun(schedule, tz) * 1000, tz)
  } catch {
    return 'érvénytelen cron'
  }
}

function lastRunText(name: string): string {
  const h = listTaskRunHistory(name, 1)[0]
  if (!h) return 'még nem futott'
  const end = h.completed_at === null ? 'nincs lezárva' : (h.outcome ?? 'lezárva')
  return `${formatDayClock(h.ts)} ${h.status}/${end}`
}

export function jobsListText(tasks: ScheduledTask[], tz: string = APP_TZ): string {
  if (tasks.length === 0) return 'nincs ütemezett feladat'
  return tasks
    .map(t => `${t.enabled ? '' : '[ki] '}${t.name} · ${t.schedule} · következő ${t.enabled ? nextRunText(t.schedule, tz) : '-'} · utolsó ${lastRunText(t.name)}`)
    .join('\n\n')
}

export function jobDetailText(t: ScheduledTask, tz: string = APP_TZ): string {
  const hist = listTaskRunHistory(t.name, 5)
  const lines = [
    t.name,
    `leírás: ${clip(t.description ?? '', 200) || '-'}`,
    `cron: ${t.schedule} (${tz}) · ágens: ${t.agent} · típus: ${t.type ?? 'task'} · ${t.enabled ? 'engedélyezve' : 'KIKAPCSOLVA'}`,
    `skipIfBusy: ${t.skipIfBusy ? 'igen' : 'nem'} · következő: ${t.enabled ? nextRunText(t.schedule, tz) : '-'}`,
    '',
    'Utolsó 5 futás:',
  ]
  if (hist.length === 0) lines.push('nincs')
  for (const h of hist) {
    const end = h.completed_at === null ? 'nincs lezárva' : `${h.outcome ?? 'lezárva'}${h.duration_ms !== null ? `, ${Math.round(h.duration_ms / 60000)} perc` : ''}`
    lines.push(`- ${formatDayClock(h.ts)} ${h.status} · ${end}`)
  }
  if (hist[0] && hist[0].completed_at === null && (hist[0].status === 'fired' || hist[0].status === 'fired_late')) {
    lines.push('', 'Most fut: lásd /runs')
  }
  return lines.join('\n')
}

// ---- /approvals -------------------------------------------------------------

export function approvalRecipients(a: Approval): string {
  if (!a.action_payload) return 'nem kiolvasható (nincs payload)'
  try {
    const p = JSON.parse(a.action_payload) as Record<string, unknown>
    const list = (v: unknown) => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []
    const to = [...list(p.to), ...list(p.recipients)]
    const cc = list(p.cc)
    const bcc = list(p.bcc)
    if (!to.length && !cc.length && !bcc.length) return 'nem kiolvasható (nincs to/cc a payloadban)'
    return [to.length ? `to: ${to.join(', ')}` : '', cc.length ? `cc: ${cc.join(', ')}` : '', bcc.length ? `bcc: ${bcc.join(', ')}` : '']
      .filter(Boolean).join(' · ')
  } catch {
    return 'nem kiolvasható (a payload nem JSON)'
  }
}

function windowText(a: Approval, nowSec: number): string {
  if (a.timeout_at === null) return 'ablak nélkül'
  if (a.timeout_at <= nowSec) return 'LEJÁRT'
  return `még ${formatSpan(a.timeout_at - nowSec)}`
}

export function approvalsListText(now = Date.now()): string {
  const nowSec = Math.floor(now / 1000)
  const list = listApprovals({ status: 'pending', limit: 50 })
  if (list.length === 0) return 'nincs jóváhagyásra váró tétel'
  return [
    ...list.map((a, i) => `${i + 1}. ${a.category} · ${clip(a.action_description, 60)} · ${approvalRecipients(a)} · kérve ${formatDayClock(a.requested_at * 1000)} · ${windowText(a, nowSec)}`),
    '',
    'Részletek: /approvals <n>',
  ].join('\n')
}

// Read-only: never changes the approval's state.
export function approvalDetailText(n: number, now = Date.now()): string {
  const list = listApprovals({ status: 'pending', limit: 50 })
  const a = list[n - 1]
  if (!a) return `Nincs ${n}. várakozó jóváhagyás. Lásd /approvals.`
  const nowSec = Math.floor(now / 1000)
  let payload = a.action_payload ?? '(nincs)'
  try { payload = JSON.stringify(JSON.parse(payload), null, 2) } catch { /* raw */ }
  return [
    `${a.category} · kérte: ${a.agent_id} · ${formatDayClock(a.requested_at * 1000)}`,
    `címzettek: ${approvalRecipients(a)}`,
    `ablak: ${windowText(a, nowSec)}`,
    `hash: ${a.content_hash ? a.content_hash.slice(0, 12) : 'nincs'}`,
    '',
    a.action_description,
    '',
    payload.length > 3000 ? `${payload.slice(0, 3000)}…` : payload,
  ].join('\n')
}

// ---- /usage (tokens only, never dollars: costops-ledger contract) -----------

function tzOffsetMs(utcMs: number, tz: string): number {
  const s = new Date(utcMs).toLocaleString('sv-SE', { timeZone: tz })
  return Date.parse(`${s.replace(' ', 'T')}Z`) - utcMs
}

/** Epoch ms of 00:00 of `ymd` (YYYY-MM-DD) in `tz`. */
export function dayStartMs(ymd: string, tz: string = APP_TZ): number {
  const guess = Date.parse(`${ymd}T00:00:00Z`)
  return guess - tzOffsetMs(guess, tz)
}

export function ymdInTz(ms: number, tz: string = APP_TZ): string {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: tz })
}

function usageBlock(title: string, fromSec: number, toSec?: number): string[] {
  const summary = getTokenSummary(fromSec, toSec)
  const dist = getModelDistribution(fromSec, toSec)
  const tot = summary.reduce((acc, s) => ({
    in: acc.in + s.totalInput, out: acc.out + s.totalOutput,
    cr: acc.cr + s.totalCacheRead, cc: acc.cc + s.totalCacheCreation, calls: acc.calls + s.totalCalls,
  }), { in: 0, out: 0, cr: 0, cc: 0, calls: 0 })
  const lines = [title]
  if (tot.calls === 0) {
    lines.push('nincs adat')
    return lines
  }
  lines.push(`összesen: input ${formatTokens(tot.in)} · output ${formatTokens(tot.out)} · cache-olvasás ${formatTokens(tot.cr)} · cache-írás ${formatTokens(tot.cc)} · ${tot.calls} hívás`)
  for (const d of dist.slice(0, 6)) {
    lines.push(`- ${d.model}: ${d.count} hívás · input ${formatTokens(d.totalInput)} · output ${formatTokens(d.totalOutput)} · cache ${formatTokens(d.totalCacheRead)}`)
  }
  const top = [...summary].sort((a, b) => (b.totalInput + b.totalOutput + b.totalCacheCreation) - (a.totalInput + a.totalOutput + a.totalCacheCreation)).slice(0, 3)
  lines.push(`legnagyobb: ${top.map(s => `${s.agent} ${formatTokens(s.totalInput + s.totalOutput + s.totalCacheCreation)}`).join(', ')}`)
  return lines
}

export function usageText(now = Date.now(), tz: string = APP_TZ): string {
  const today = dayStartMs(ymdInTz(now, tz), tz)
  return [
    ...usageBlock(`MA (${ymdInTz(now, tz)})`, Math.floor(today / 1000)),
    '',
    ...usageBlock('7 NAP', Math.floor((now - 7 * 86400_000) / 1000)),
    '',
    'Tokenben, nem dollárban. Egy nap: /usage <ÉÉÉÉ-HH-NN> vagy /usage <n> (n nappal ezelőtt).',
  ].join('\n')
}

export function usageDayText(arg: string, now = Date.now(), tz: string = APP_TZ): string {
  let ymd: string
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) ymd = arg
  else if (/^\d{1,3}$/.test(arg)) ymd = ymdInTz(now - Number(arg) * 86400_000, tz)
  else return 'Használat: /usage <ÉÉÉÉ-HH-NN> vagy /usage <n> (n nappal ezelőtt)'
  const from = dayStartMs(ymd, tz)
  const to = dayStartMs(ymdInTz(from + 36 * 3600_000, tz), tz) - 1000
  return usageBlock(ymd, Math.floor(from / 1000), Math.floor(to / 1000)).join('\n')
}

// ---- /board (read only) -----------------------------------------------------

const STATUSES: KanbanCard['status'][] = ['planned', 'in_progress', 'testing', 'waiting', 'done']

// Telegram lines are narrow (owner screenshot 2026-09-24: every /board line
// wrapped in two; "#36" became a hashtag link). A line is "41) title", the
// status sits in the group header, the assignee only when it is not the owner,
// and a child says whose it is (↑64) -- the owner archived three children as
// if they were standalone tasks, because the flat list never showed a parent.
const TITLE_MAX = 40

function openCards(cards: KanbanCard[]): KanbanCard[] {
  return cards.filter(c => c.archived_at === null && c.status !== 'done')
}

function seqOf(c: KanbanCard): string {
  return String(c.seq ?? '?')
}

function isOwner(assignee: string | null, owner: string): boolean {
  return (assignee ?? '').toLocaleLowerCase('hu') === owner.toLocaleLowerCase('hu')
}

function cardLine(c: KanbanCard, owner: string, byId: Map<string, KanbanCard>, opts: { parentMark: boolean } = { parentMark: true }): string {
  const who = c.assignee && !isOwner(c.assignee, owner) ? ` · ${c.assignee}` : ''
  const parent = c.parent_id ? byId.get(c.parent_id) : undefined
  const up = opts.parentMark && parent ? ` ↑${seqOf(parent)}` : ''
  return `${seqOf(c)}) ${clip(c.title, TITLE_MAX)}${who}${up}`
}

function openChildren(parent: KanbanCard, open: KanbanCard[]): KanbanCard[] {
  return open.filter(c => c.parent_id === parent.id)
}

export function boardText(cards: KanbanCard[], owner: string = OWNER_NAME): string {
  const live = cards.filter(c => c.archived_at === null)
  const open = openCards(cards)
  const byId = new Map(cards.map(c => [c.id, c]))
  const counts = STATUSES.map(st => [st, live.filter(c => c.status === st).length] as const)
    .filter(([, n]) => n > 0).map(([st, n]) => `${st} ${n}`).join(' · ')
  const waiting = open.filter(c => c.status === 'waiting')
  const assigned = open.filter(c => c.status !== 'waiting' && isOwner(c.assignee, owner))
  const lines = [`Oszlopok: ${counts || 'üres'}`]
  const LIMIT = 30
  let shown = 0
  let first: KanbanCard | undefined
  for (const [title, group] of [['VÁRAKOZIK', waiting], ['HOZZÁD RENDELVE', assigned]] as const) {
    if (group.length === 0) continue
    lines.push('', `${title} (${group.length})`)
    for (const c of group) {
      if (shown >= LIMIT) break
      lines.push(cardLine(c, owner, byId))
      const kids = openChildren(c, open).length
      if (kids > 0) lines.push(`    └ ${kids} alfeladat`)
      first ??= c
      shown++
    }
  }
  if (shown === 0) lines.push('', 'Nincs rád váró vagy hozzád rendelt nyitott kártya.')
  const total = waiting.length + assigned.length
  if (total > shown) lines.push(`+${total - shown} további: /board all`)
  lines.push('', `Egy kártya: /board ${first ? seqOf(first) : '<szám>'} · ${boardHints()}`)
  return lines.join('\n')
}

// /board all: every open card by column, uncut; children nested under their
// parent (in the parent's column), with their own status when it differs.
export function boardAllText(cards: KanbanCard[], owner: string = OWNER_NAME): string {
  const open = openCards(cards)
  const byId = new Map(cards.map(c => [c.id, c]))
  const openIds = new Set(open.map(c => c.id))
  // A child whose parent is closed/archived stands on its own (with its ↑mark).
  const roots = open.filter(c => !c.parent_id || !openIds.has(c.parent_id))
  const lines = [`Minden nyitott kártya: ${open.length}`]
  for (const st of STATUSES.filter(x => x !== 'done')) {
    const col = roots.filter(c => c.status === st)
    if (col.length === 0) continue
    lines.push('', `${st.toUpperCase()} (${col.length})`)
    const walk = (c: KanbanCard, depth: number, parentStatus: string | null) => {
      const status = parentStatus !== null && c.status !== parentStatus ? ` (${c.status})` : ''
      const line = cardLine(c, owner, byId, { parentMark: depth === 0 })
      lines.push(depth === 0 ? line : `${'    '.repeat(depth)}└ ${line}${status}`)
      for (const k of openChildren(c, open)) walk(k, depth + 1, c.status)
    }
    for (const c of col) walk(c, 0, null)
  }
  lines.push('', `Egy kártya: /board <szám> · ${boardHints()}`)
  return lines.join('\n')
}

// ---- /board filters: status letter and/or whose (owner request 2026-09-24) ----
//
// "/board w", "/board p me", "/board marveen": short enough to type on a phone.
// The main agent's name is NOT hard-coded: its aliases come from BOT_NAME and
// MAIN_AGENT_ID ("Marveen TEST" / "marveen-test" on the test instance), and the
// assignee field is free text ("Marveen" and "marveen" on the same live board),
// so every name match is case-insensitive.

const STATUS_ALIASES: Record<string, KanbanCard['status']> = {
  w: 'waiting', waiting: 'waiting', p: 'planned', planned: 'planned',
  i: 'in_progress', in_progress: 'in_progress', t: 'testing', testing: 'testing',
  d: 'done', done: 'done',
}

export function botAliases(botName: string = BOT_NAME, agentId: string = MAIN_AGENT_ID): Set<string> {
  const n = botName.trim().toLocaleLowerCase('hu')
  return new Set([n, n.split(/\s+/)[0], agentId.toLocaleLowerCase('hu'), 'bot'].filter(Boolean))
}

// The bot's name as the owner types it: the first word of BOT_NAME, lowercase.
export function botHandle(botName: string = BOT_NAME): string {
  return botName.trim().split(/\s+/)[0].toLocaleLowerCase('hu') || 'bot'
}

export type BoardWho = { kind: 'me' } | { kind: 'bot' } | { kind: 'none' } | { kind: 'name'; name: string }
export interface BoardFilter { status: KanbanCard['status'] | null; who: BoardWho | null }

export function parseBoardFilter(args: string[], aliases: Set<string> = botAliases()): BoardFilter | string {
  const f: BoardFilter = { status: null, who: null }
  for (const raw of args) {
    const a = raw.trim().toLocaleLowerCase('hu')
    const st = STATUS_ALIASES[a]
    if (st) {
      if (f.status) return `Kétszer adtál meg oszlopot: „${raw}”.`
      f.status = st
      continue
    }
    if (f.who) return `Kétszer adtál meg felelőst: „${raw}”.`
    f.who = a === 'me' ? { kind: 'me' } : a === '-' ? { kind: 'none' } : aliases.has(a) ? { kind: 'bot' } : { kind: 'name', name: a }
  }
  return f
}

function whoMatches(c: KanbanCard, who: BoardWho, owner: string, aliases: Set<string>): boolean {
  const a = (c.assignee ?? '').trim().toLocaleLowerCase('hu')
  if (who.kind === 'none') return a === ''
  if (who.kind === 'me') return isOwner(c.assignee, owner)
  if (who.kind === 'bot') return a !== '' && (aliases.has(a) || aliases.has(a.split(/\s+/)[0]))
  return a === who.name
}

function whoLabel(who: BoardWho, owner: string, handle: string): string {
  if (who.kind === 'me') return owner
  if (who.kind === 'bot') return handle
  if (who.kind === 'none') return 'felelős nélkül'
  return who.name
}

// The compact footer; the full explanation is /board ? (owner feedback: the
// switch list at the bottom was dense and hard to read).
export function boardHints(): string {
  return 'Szűrők és példák: /board ?'
}

// "Marveennél", "Edithnél", "Samunál": -nál/-nél by the last vowel (the name
// comes from BOT_NAME, so it cannot be spelled out once).
export function nalNel(name: string): string {
  const v = name.toLocaleLowerCase('hu').match(/[aáeéiíoóöőuúüű]/g)
  const last = v ? v[v.length - 1] : 'e'
  return `${name}${'aáoóuú'.includes(last) ? 'nál' : 'nél'}`
}

export function boardHelpText(handle: string = botHandle()): string {
  const Name = `${handle[0].toUpperCase()}${handle.slice(1)}`
  return [
    '/board – a kanban tábla',
    '',
    '/board          ami rád vár (várakozik + hozzád rendelt)',
    '/board 41       egy kártya, alfeladataival',
    '/board all      minden nyitott kártya, fában',
    '',
    'Egy oszlop:',
    '  w várakozik · p tervezett · i folyamatban',
    '  t tesztelés · d kész (még nem archivált)',
    '',
    'Kié:',
    '  me       a tiéd',
    `  ${handle.padEnd(8)} ${handle === 'bot' ? 'a boté' : `${Name} kártyái`}`,
    '  -        senkié',
    '  samu     bárki más, név szerint',
    '',
    'Példák:',
    '  /board w          mi várakozik',
    '  /board p me       a tervezett feladataid',
    `  /board ${handle.padEnd(10)} ${Name} minden nyitott kártyája`,
    `  /board w ${handle.padEnd(8)} ami ${nalNel(Name)} várakozik`,
  ].join('\n')
}

// A filtered view: matching cards by column; a matching child sits under its
// matching parent, else stands alone with its ↑mark.
export function boardFilterText(cards: KanbanCard[], f: BoardFilter, owner: string = OWNER_NAME, aliases: Set<string> = botAliases(), handle: string = botHandle()): string {
  const live = cards.filter(c => c.archived_at === null)
  const byId = new Map(cards.map(c => [c.id, c]))
  const match = live.filter(c =>
    (f.status ? c.status === f.status : c.status !== 'done')
    && (f.who ? whoMatches(c, f.who, owner, aliases) : true))
  const ids = new Set(match.map(c => c.id))
  const roots = match.filter(c => !c.parent_id || !ids.has(c.parent_id))
  const title = [f.status ? f.status.toUpperCase() : 'NYITOTT', f.who ? whoLabel(f.who, owner, handle) : null].filter(Boolean).join(' · ')
  const lines = [`${title} (${match.length})`]
  if (f.status === 'done') lines.push('(csak a még nem archivált kész kártyák)')
  if (match.length === 0) lines.push('nincs')
  const statuses = f.status ? [f.status] : STATUSES.filter(x => x !== 'done')
  for (const st of statuses) {
    const col = roots.filter(c => c.status === st)
    if (col.length === 0) continue
    if (!f.status) lines.push('', `${st.toUpperCase()} (${col.length})`)
    const walk = (c: KanbanCard, depth: number, parentStatus: string | null) => {
      const status = parentStatus !== null && c.status !== parentStatus ? ` (${c.status})` : ''
      const line = cardLine(c, owner, byId, { parentMark: depth === 0 })
      lines.push(depth === 0 ? line : `${'    '.repeat(depth)}└ ${line}${status}`)
      for (const k of match.filter(x => x.parent_id === c.id)) walk(k, depth + 1, c.status)
    }
    for (const c of col) walk(c, 0, null)
  }
  lines.push('', boardHints())
  return lines.join('\n')
}

export function findCard(ref: string, cards: () => KanbanCard[] = listKanbanCards): KanbanCard | undefined {
  const r = ref.trim()
  if (/^#?\d+$/.test(r)) {
    const seq = Number(r.replace('#', ''))
    return cards().find(c => c.seq === seq)
  }
  return getKanbanCard(r) ?? cards().find(c => c.id.startsWith(r.toLowerCase()))
}

export function cardDetailText(card: KanbanCard, cards: KanbanCard[] = listKanbanCards(), owner: string = OWNER_NAME): string {
  const comments = getKanbanComments(card.id)
  const byId = new Map(cards.map(c => [c.id, c]))
  const parent = card.parent_id ? byId.get(card.parent_id) : undefined
  const kids = cards.filter(c => c.parent_id === card.id && c.archived_at === null)
  const openKids = kids.filter(c => c.status !== 'done')
  const lines = [
    `${seqOf(card)}) ${card.title}`,
    `${card.status} · ${card.assignee ?? 'nincs felelős'} · ${card.priority}${card.archived_at ? ' · ARCHIVÁLT' : ''}`,
    `létrehozva ${formatDayClock(card.created_at * 1000)} · frissítve ${formatDayClock(card.updated_at * 1000)}`,
  ]
  if (parent) lines.push(`↑ Szülő: ${seqOf(parent)}) ${clip(parent.title, TITLE_MAX)}`)
  if (kids.length > 0) {
    lines.push('', `Alfeladatok (${openKids.length} nyitott${kids.length > openKids.length ? `, ${kids.length - openKids.length} kész` : ''}):`)
    for (const k of openKids) lines.push(`${cardLine(k, owner, byId, { parentMark: false })} · ${k.status}`)
  }
  lines.push('', clip(card.description ?? '(nincs leírás)', 800), '', `Kommentek (${comments.length}):`)
  if (comments.length === 0) lines.push('nincs')
  for (const c of comments.slice(-10)) lines.push(`- ${formatDayClock(c.created_at * 1000)} ${c.author}: ${clip(c.content, 300)}`)
  if (comments.length > 10) lines.push(`(csak az utolsó 10; összesen ${comments.length})`)
  lines.push('', `azonosító: ${card.id}`)
  return lines.join('\n')
}

// ---- /commands --------------------------------------------------------------

export function customCommandsText(): string {
  const custom = listCommands().filter(e => e.source === 'custom')
  const invalid = listInvalidCustomCommands()
  const lines = ['Saját parancsok:']
  if (custom.length === 0) lines.push('nincs')
  for (const e of custom) lines.push(`${e.usage ?? `/${e.name}`} — ${e.description}`)
  lines.push('', 'Érvénytelen definíciók:')
  if (invalid.length === 0) lines.push('nincs')
  for (const i of invalid) lines.push(`/${i.name} — ${i.reason}`)
  return lines.join('\n')
}

// ---- registration -----------------------------------------------------------

function parseIndex(arg: string | undefined): number | null {
  if (!arg || !/^\d{1,4}$/.test(arg)) return null
  const n = Number(arg)
  return n >= 1 ? n : null
}

const reply = (ctx: CommandContext, text: string) => ctx.reply(text)

export function registerBuiltinCommands(): void {
  // OLVAS
  registerCommand({ name: 'help', kind: 'read', description: 'ez a parancslista', run: ctx => reply(ctx, renderHelp()) })
  registerCommand({ name: 'status', kind: 'read', description: 'rendszer-állapot', run: async ctx => reply(ctx, await statusText()) })
  registerCommand({ name: 'queue', kind: 'read', description: 'mi vár rád, mi indul magától', run: ctx => reply(ctx, formatBlocks(collectQueue(ctx.now))) })
  registerCommand({
    name: 'runs', kind: 'read', usage: '/runs [<n>]', description: 'futó körök; <n>: egy kör részletei a futó hívásokkal',
    run: (ctx, args) => {
      const v = collectRuns(ctx.now)
      if (args.length === 0) return reply(ctx, formatRunsList(v, ctx.now))
      const n = parseIndex(args[0])
      return reply(ctx, n === null ? 'Használat: /runs vagy /runs <n>' : formatRunDetail(v, n, ctx.now))
    },
  })
  registerCommand({
    name: 'jobs', kind: 'read', usage: '/jobs [<név>]', description: 'ütemezett feladatok; <név>: részletek, utolsó 5 futás',
    run: (ctx, args) => {
      const tasks = listScheduledTasks()
      if (args.length === 0) return reply(ctx, jobsListText(tasks))
      const t = tasks.find(x => x.name === args[0]) ?? tasks.find(x => x.name.toLowerCase() === args[0].toLowerCase())
      return reply(ctx, t ? jobDetailText(t) : `Nincs ilyen feladat: ${args[0]}. Lásd /jobs.`)
    },
  })
  registerCommand({
    name: 'approvals', kind: 'read', usage: '/approvals [<n>]', description: 'jóváhagyásra várók; <n>: teljes tartalom, címzettek, hash, ablak',
    run: (ctx, args) => {
      if (args.length === 0) return reply(ctx, approvalsListText(ctx.now))
      const n = parseIndex(args[0])
      return reply(ctx, n === null ? 'Használat: /approvals vagy /approvals <n>' : approvalDetailText(n, ctx.now))
    },
  })
  registerCommand({ name: 'model', kind: 'read', description: 'mi fut most, meddig, és mire válthatsz', help: () => modelHelpText(), run: ctx => reply(ctx, modelSummary(modelSummaryInput(ctx.now))) })
  registerCommand({
    name: 'model', kind: 'read', usage: '/model details', description: 'a modell-állapot technikai részletei (azonosítók, források, mérés)',
    matches: args => args[0]?.toLowerCase() === 'details',
    run: ctx => reply(ctx, modelStatusText()),
  })
  registerCommand({ name: 'context', kind: 'read', description: 'kontextus mérete, küszöb, session kora', run: ctx => reply(ctx, contextStatusText(ctx.now)) })
  registerCommand({
    name: 'usage', kind: 'read', usage: '/usage [<nap>]', description: 'token-fogyasztás, ma és 7 nap, modell szerint; <nap>: egy nap bontása',
    run: (ctx, args) => reply(ctx, args.length === 0 ? usageText(ctx.now) : usageDayText(args[0], ctx.now)),
  })
  registerCommand({
    name: 'board', kind: 'read', usage: `/board [<szám>|w|p|i|t|d|all] [me|${botHandle()}|-]`,
    description: `kanban: ami rád vár; <szám>: egy kártya; w/p/i/t/d: egy oszlop; me, ${botHandle()}, -: kié; all: minden, fában`,
    help: () => boardHelpText(),
    run: (ctx, args) => {
      if (args.length === 0) return reply(ctx, boardText(listKanbanCards()))
      if (args.length === 1 && ['all', 'a'].includes(args[0].toLowerCase())) return reply(ctx, boardAllText(listKanbanCards()))
      if (args.length === 1 && /^#?\d+$/.test(args[0].trim())) {
        const card = findCard(args[0])
        return reply(ctx, card ? cardDetailText(card) : `Nincs ilyen nyitott kártya: ${args[0]}. Minden nyitott kártya: /board all`)
      }
      if (args.length > 2) return reply(ctx, `A /board csak olvas; kártyát írni innen nem lehet. Legfeljebb egy oszlopot és egy felelőst kap. ${boardHints()}`)
      const f = parseBoardFilter(args)
      if (typeof f === 'string') return reply(ctx, `${f} ${boardHints()}`)
      // exactly an 8-char hex id still opens the card (a short name like
      // "ada" must not prefix-match an id)
      if (args.length === 1 && /^[0-9a-f]{8}$/i.test(args[0].trim())) {
        const card = findCard(args[0])
        if (card) return reply(ctx, cardDetailText(card))
      }
      return reply(ctx, boardFilterText(listKanbanCards(), f))
    },
  })
  registerCommand({ name: 'commands', kind: 'read', description: 'a saját parancsaid, az érvénytelenek külön', run: ctx => reply(ctx, customCommandsText()) })

  // ÍR, megerősítés nélkül (CMD920 3.3, 3.4). /new and /clear are shipped
  // as default CUSTOM commands (custom-commands.ts DEFAULT_COMMANDS).
  registerModelWriteCommands()
  registerCommand({
    name: 'context', kind: 'write', usage: '/context clear', description: 'azonnali /clear (foglalt sessionnél nem)',
    matches: args => args[0]?.toLowerCase() === 'clear',
    touches: ['context'],
    run: async ctx => { const r = await contextClear(ctx.now); ctx.reply(withRetry('/context clear', { ok: r.cleared, text: r.text, busy: r.busy }, ctx)) },
  })

  // ÍR, megerősítéssel: planned until after the stabilization (CMD920 2.).
  registerCommand({ name: 'runs', kind: 'write', confirm: true, planned: true, usage: '/runs stop <nonce>', description: 'a futó kör megszakítása', matches: args => args[0]?.toLowerCase() === 'stop' })
  registerCommand({
    name: 'jobs', kind: 'write', confirm: true, planned: true, usage: '/jobs <név> on|off|run|skip <nonce>', description: 'feladat be/ki, futtatás most, következő kihagyása',
    matches: args => args.length >= 2 && ['on', 'off', 'run', 'skip'].includes(args[1].toLowerCase()),
  })
  registerCommand({
    name: 'approvals', kind: 'write', confirm: true, planned: true, usage: '/approvals <n> approve|reject|renew <nonce>', description: 'jóváhagyás, elutasítás, megújítás',
    matches: args => args.length >= 2 && ['approve', 'reject', 'renew'].includes(args[1].toLowerCase()),
  })
}
