// The builtin owner commands (CMD920 3.2), read side.
//
// Every reply is measured state with its source; what cannot be measured says
// so. The writes of this list (/model set/back/effort, /context clear, /new,
// /clear) are registered as PLANNED here and replaced by the next release with
// the same `usage`; the nonce writes (/runs stop, /jobs on|off|run|skip,
// /approvals approve|reject|renew) stay planned (CMD920 2.).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, OWNER_NAME, APP_TZ } from '../config.js'
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
import { registerModelWriteCommands, readModelChoices as readChoiceList, readHold, readLastSent, MODEL_CHOICES_FILE, MODEL_HOLD_FILE, MODEL_LAST_SENT_FILE, type LastSent } from './main-model.js'
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
  return formatSystemStatus(system, { RENDSZER: [row] })
}

// ---- /model (status) --------------------------------------------------------

function readEffortSetting(): { value: string; source: string } | null {
  if (process.env.CLAUDE_CODE_EFFORT_LEVEL) return { value: process.env.CLAUDE_CODE_EFFORT_LEVEL, source: 'env CLAUDE_CODE_EFFORT_LEVEL' }
  try {
    const s = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    if (typeof s?.effortLevel === 'string') return { value: s.effortLevel, source: '.claude/settings.json effortLevel' }
  } catch { /* no settings */ }
  return null
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
  head.push(`Most fut:    ${measured ? `${measured.model} (utolsó kör ${formatDayClock(measured.atMs)})` : notMeasurable('nincs assistant-sor a transzkriptben')}`)
  const pending = lastSent !== null && (measured === null || lastSent.at > measured.atMs)
  if (pending && lastSent) head.push(`Azóta:       /model ${lastSent.model} elküldve ${formatDayClock(lastSent.at)}; a következő kör méri`)
  const expected = holdModel ?? configured
  const warn = measured && !pending && modelsDiffer(expected, measured.model)
    ? `FIGYELEM: a futó modell eltér a ${holdModel ? 'tartásétól' : 'beállítottól'}.`
    : null
  return { head, warn }
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
  lines.push(`Beállítva:   ${conf.model} (${conf.source})`)
  if (m.warn) lines.push(m.warn)
  const effort = readEffortSetting()
  lines.push(`Effort:      ${effort ? `${effort.value} (${effort.source})` : 'nincs beállítva (a CLI alapértéke)'} · visszamérni nem tudjuk`)
  const hold = h.error
    ? notMeasurable(`a main-model-hold.json olvashatatlan: ${h.error}`)
    : h.state
      ? `${h.state.model} eddig: ${formatDayClock(h.state.until)}, utána vissza: ${h.state.revert_to}${h.state.verify_pending ? ' (a váltás még nincs visszamérve)' : ''}`
      : 'nincs'
  lines.push(`Tartás:      ${hold}`)
  let choices: string
  try {
    const c = readChoiceList(MODEL_CHOICES_FILE, conf.model)
    choices = !c.fromFile
      ? `csak a konfigurált modell (${conf.model}); a store/model-choices.json hiányzik`
      : c.choices.map(x => `${x.name} = ${x.id}${x.purpose ? ` (${x.purpose})` : ''}`).join('\n             ')
  } catch (err) {
    choices = notMeasurable(`a model-choices.json olvashatatlan: ${err instanceof Error ? err.message : String(err)}`)
  }
  lines.push(`Választható: ${choices}`)
  // ELSOKOR922 Phase 7 A-smoke, tulajdonosi visszajelzés (2026-09-22): a
  // sima /model státusz nem mondta meg, HOGYAN kell váltani -- a szintaxis
  // csak a /help-ben (a registry `usage` mezőjében) volt látható, itt nem.
  lines.push('Váltás: /model <választás> [<idő>|keep], pl. /model opus 30m')
  return lines.join('\n')
}

// ---- /context (status) ------------------------------------------------------

export function contextStatusText(now = Date.now()): string {
  const tokens = readContextTokensFromProjectDir(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID))
  const gate = readGateConfig(MAIN_AGENT_ID)
  const state = readGateRunState(MAIN_AGENT_ID)
  const since = getAgentRunningSince(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
  return [
    `Kontextus:     ${tokens === null ? notMeasurable('nincs usage a transzkriptben') : formatTokens(tokens)}`,
    `/clear küszöb: ${gate.enabled ? formatTokens(gate.thresholdTokens) : 'a gate ki van kapcsolva'}`,
    `Session kora:  ${since === null ? notMeasurable('a tmux session nem található') : formatDuration(Math.floor(now / 1000) - since)}`,
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
    .join('\n')
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

export function boardText(cards: KanbanCard[], owner: string = OWNER_NAME): string {
  const live = cards.filter(c => c.archived_at === null)
  const counts = STATUSES.map(s => `${s} ${live.filter(c => c.status === s).length}`).join(' · ')
  const ownerKey = owner.toLocaleLowerCase('hu')
  const mine = live.filter(c => c.status !== 'done' && (c.status === 'waiting' || (c.assignee ?? '').toLocaleLowerCase('hu') === ownerKey))
  const lines = [`Oszlopok: ${counts}`, '', 'Ami rád vár (waiting, vagy hozzád rendelve):']
  if (mine.length === 0) lines.push('nincs')
  for (const c of mine.slice(0, 30)) {
    lines.push(`- #${c.seq ?? '?'} ${c.id.slice(0, 8)} · ${c.status} · ${c.assignee ?? '-'} · ${clip(c.title, 60)}`)
  }
  if (mine.length > 30) lines.push(`+${mine.length - 30} további`)
  lines.push('', 'Részletek: /board <id> (8 jegyű id vagy #szám)')
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

export function cardDetailText(card: KanbanCard): string {
  const comments = getKanbanComments(card.id)
  const lines = [
    `#${card.seq ?? '?'} ${card.id} · ${card.title}`,
    `státusz: ${card.status} · felelős: ${card.assignee ?? '-'} · prioritás: ${card.priority}${card.archived_at ? ' · ARCHIVÁLT' : ''}`,
    `létrehozva ${formatDayClock(card.created_at * 1000)} · frissítve ${formatDayClock(card.updated_at * 1000)}`,
    '',
    clip(card.description ?? '(nincs leírás)', 800),
    '',
    `Kommentek (${comments.length}):`,
  ]
  if (comments.length === 0) lines.push('nincs')
  for (const c of comments.slice(-10)) lines.push(`- ${formatDayClock(c.created_at * 1000)} ${c.author}: ${clip(c.content, 300)}`)
  if (comments.length > 10) lines.push(`(csak az utolsó 10; összesen ${comments.length})`)
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
  registerCommand({ name: 'help', kind: 'read', description: 'mit lehet kérni; a tervezett írások külön jelölve', run: ctx => reply(ctx, renderHelp()) })
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
  registerCommand({ name: 'model', kind: 'read', description: 'futó és beállított modell, effort, választék', run: ctx => reply(ctx, modelStatusText()) })
  registerCommand({ name: 'context', kind: 'read', description: 'kontextus mérete, küszöb, session kora', run: ctx => reply(ctx, contextStatusText(ctx.now)) })
  registerCommand({
    name: 'usage', kind: 'read', usage: '/usage [<nap>]', description: 'token-fogyasztás, ma és 7 nap, modell szerint; <nap>: egy nap bontása',
    run: (ctx, args) => reply(ctx, args.length === 0 ? usageText(ctx.now) : usageDayText(args[0], ctx.now)),
  })
  registerCommand({
    name: 'board', kind: 'read', usage: '/board [<id>]', description: 'kanban: oszlopok és ami rád vár; <id>: egy kártya kommentekkel',
    run: (ctx, args) => {
      if (args.length === 0) return reply(ctx, boardText(listKanbanCards()))
      if (args.length > 1) return reply(ctx, 'A /board csak olvas; kártyát írni innen nem lehet. Részletek: /board <id>')
      const card = findCard(args[0])
      return reply(ctx, card ? cardDetailText(card) : `Nincs ilyen kártya: ${args[0]}`)
    },
  })
  registerCommand({ name: 'commands', kind: 'read', description: 'a saját parancsaid, az érvénytelenek külön', run: ctx => reply(ctx, customCommandsText()) })

  // ÍR, megerősítés nélkül (CMD920 3.3, 3.4). /new and /clear are shipped
  // as default CUSTOM commands (custom-commands.ts DEFAULT_COMMANDS).
  registerModelWriteCommands()
  registerCommand({
    name: 'context', kind: 'write', usage: '/context clear', description: 'azonnali /clear (foglalt sessionnél nem)',
    matches: args => args[0]?.toLowerCase() === 'clear',
    run: async ctx => ctx.reply((await contextClear(ctx.now)).text),
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
