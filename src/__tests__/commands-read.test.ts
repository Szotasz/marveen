import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase,
  getDb,
  createApproval,
  getApproval,
  resolveApproval,
  createKanbanCard,
  archiveKanbanCard,
  addKanbanComment,
  listKanbanCards,
} from '../db.js'
import {
  approvalsListText,
  approvalDetailText,
  approvalRecipients,
  usageText,
  usageDayText,
  dayStartMs,
  boardText,
  boardAllText,
  boardFilterText,
  parseBoardFilter,
  botAliases,
  botHandle,
  boardHelpText,
  nalNel,
  findCard,
  cardDetailText,
  nextRunText,
} from '../web/builtin-commands.js'
import {
  summarizeRound,
  formatOpenCalls,
  formatBlocks,
  collectBlock,
  collectQueue,
  callPreview,
} from '../web/queue-view.js'
import { isRegistryCommand, openQuestionIgnoringCommands } from '../web/open-question.js'
import { registerCommand, clearCommandsForTest } from '../web/commands.js'
import { MAIN_AGENT_ID } from '../config.js'
import { computeNextRun } from '../web/cron.js'

beforeEach(() => {
  initDatabase(':memory:')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('/approvals (CMD920 test 19)', () => {
  it('lists only pending items, marks the expired window, shows recipients', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    createApproval({ id: 'aaaaaaaa-1', agent_id: 'marveen', category: 'email', action_description: 'Ajánlat küldése', action_payload: JSON.stringify({ to: ['ugyfel@example.com'], cc: 'fonok@example.com' }), timeout_at: nowSec + 1200 })
    createApproval({ id: 'bbbbbbbb-2', agent_id: 'marveen', category: 'email', action_description: 'Régi levél', timeout_at: nowSec - 60 })
    createApproval({ id: 'cccccccc-3', agent_id: 'marveen', category: 'email', action_description: 'Már elbírálva' })
    resolveApproval('cccccccc-3', 'approved', 'owner')

    const text = approvalsListText()
    expect(text).toContain('Ajánlat küldése')
    expect(text).toContain('to: ugyfel@example.com · cc: fonok@example.com')
    expect(text).toContain('Régi levél')
    expect(text).toMatch(/Régi levél.*LEJÁRT/)
    expect(text).toMatch(/Ajánlat küldése.*még 20 perc/)
    expect(text).not.toContain('Már elbírálva')
  })

  it('the detail view shows content, hash and window, and changes no state', () => {
    createApproval({ id: 'dddddddd-4', agent_id: 'marveen', category: 'email', action_description: 'Levél', action_payload: JSON.stringify({ to: ['a@b.c'], text: 'Tisztelt Ügyfél' }), content_hash: 'abcdef0123456789' })
    const before = getApproval('dddddddd-4')
    const text = approvalDetailText(1)
    expect(text).toContain('hash: abcdef012345')
    expect(text).toContain('Tisztelt Ügyfél')
    expect(text).toContain('címzettek: to: a@b.c')
    expect(getApproval('dddddddd-4')).toEqual(before)
    expect(approvalDetailText(9)).toMatch(/Nincs 9\./)
  })

  it('recipients: missing or non-JSON payload is said out loud', () => {
    const base = { id: 'x', agent_id: 'a', category: 'c', action_description: 'd', status: 'pending', timeout_at: null, telegram_message_id: null, requested_at: 0, resolved_at: null, resolved_by: null, content_hash: null, consumed_at: null } as const
    expect(approvalRecipients({ ...base, action_payload: null })).toMatch(/nincs payload/)
    expect(approvalRecipients({ ...base, action_payload: 'nem json' })).toMatch(/nem JSON/)
    expect(approvalRecipients({ ...base, action_payload: '{"text":"x"}' })).toMatch(/nincs to\/cc/)
  })

  it('empty list says so', () => {
    expect(approvalsListText()).toBe('nincs jóváhagyásra váró tétel')
  })
})

describe('/usage speaks tokens, never dollars (CMD920 test 20)', () => {
  function insertUsage(agent: string, ts: number, model: string, input: number, output: number) {
    getDb().prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(agent, `s-${agent}`, ts, input, output, 1000, 10, model)
  }

  it('today and 7 days in tokens, by model; no currency anywhere', () => {
    const now = Date.now()
    insertUsage('marveen', Math.floor(now / 1000) - 60, 'claude-opus-5', 12_000, 3_000)
    insertUsage('worker', Math.floor(now / 1000) - 3 * 86400, 'claude-sonnet-5', 50_000, 1_000)
    const text = usageText(now, 'Europe/Budapest')
    expect(text).toMatch(/MA \(/)
    expect(text).toMatch(/7 NAP/)
    expect(text).toContain('claude-opus-5')
    expect(text).toContain('claude-sonnet-5')
    expect(text).toMatch(/input 12k/)
    expect(text).not.toMatch(/\$|USD|dollár |EUR|Ft\b/)
  })

  it('empty ledger -> "nincs adat", not zero', () => {
    expect(usageText(Date.now(), 'Europe/Budapest')).toMatch(/MA \([^)]*\)\nnincs adat/)
  })

  it('/usage <day> and /usage <n>; bad input explains the syntax', () => {
    const now = Date.parse('2026-09-22T10:00:00Z')
    insertUsage('marveen', Math.floor(Date.parse('2026-09-21T12:00:00Z') / 1000), 'claude-opus-5', 7_000, 100)
    expect(usageDayText('2026-09-21', now, 'Europe/Budapest')).toMatch(/^2026-09-21\n.*input 7k/s)
    expect(usageDayText('1', now, 'Europe/Budapest')).toMatch(/^2026-09-21/)
    expect(usageDayText('tegnapelőtt', now, 'Europe/Budapest')).toMatch(/Használat/)
  })

  it('dayStartMs is local midnight in the zone', () => {
    expect(new Date(dayStartMs('2026-09-22', 'Europe/Budapest')).toISOString()).toBe('2026-09-21T22:00:00.000Z')
    expect(new Date(dayStartMs('2026-01-15', 'Europe/Budapest')).toISOString()).toBe('2026-01-14T23:00:00.000Z')
  })
})

describe('/board (read only)', () => {
  it('short list: two groups, "41) title", assignee only when not the owner, zero columns left out, archived left out', () => {
    createKanbanCard({ id: 'c0000001', title: 'Tervezett, nem az enyém', status: 'planned', assignee: 'samu' })
    createKanbanCard({ id: 'c0000002', title: 'Rám vár', status: 'waiting', assignee: 'Marveen' })
    createKanbanCard({ id: 'c0000003', title: 'Nekem szól', status: 'in_progress', assignee: 'andrás' })
    createKanbanCard({ id: 'c0000004', title: 'Archivált várakozó', status: 'waiting' })
    archiveKanbanCard('c0000004')
    const cards = listKanbanCards()
    const seq = (id: string) => cards.find(c => c.id === id)!.seq
    const text = boardText(cards, 'András')
    expect(text).toMatch(/^Oszlopok: planned 1 · in_progress 1 · waiting 1\n/)
    expect(text).toContain(`\nVÁRAKOZIK (1)\n${seq('c0000002')}) Rám vár · Marveen\n`)
    expect(text).toContain(`\nHOZZÁD RENDELVE (1)\n${seq('c0000003')}) Nekem szól\n`)
    expect(text).not.toContain('Archivált várakozó')
    expect(text).not.toContain('Tervezett, nem az enyém')
    expect(text).not.toMatch(/#\d|c000000/) // no hashtag links, no hex ids in the list
    expect(text).toMatch(new RegExp(`Egy kártya: /board ${seq('c0000002')} · Szűrők és példák: /board \\?$`))
  })

  // Owner case 2026-09-24: three children were archived as standalone tasks.
  it('a parent says how many open children it has; a child says whose it is (↑); titles are cut to 40', () => {
    createKanbanCard({ id: 'p0000001', title: 'Emanuel Swedenborg munkái', status: 'waiting', assignee: 'Marveen' })
    createKanbanCard({ id: 'k0000001', title: 'Könyvtárstruktúra és YAML front matter konvenció LLM-feldolgozáshoz', status: 'planned', assignee: 'András', parent_id: 'p0000001' })
    createKanbanCard({ id: 'k0000002', title: 'Licenc', status: 'planned', assignee: 'samu', parent_id: 'p0000001' })
    createKanbanCard({ id: 'k0000003', title: 'Kész gyerek', status: 'done', parent_id: 'p0000001' })
    const cards = listKanbanCards()
    const seq = (id: string) => cards.find(c => c.id === id)!.seq
    const text = boardText(cards, 'András')
    expect(text).toContain(`${seq('p0000001')}) Emanuel Swedenborg munkái · Marveen\n    └ 2 alfeladat`)
    expect(text).toContain(`${seq('k0000001')}) Könyvtárstruktúra és YAML front matter k… ↑${seq('p0000001')}`)
  })

  it('/board all: by column, children nested under the parent with their own status when it differs; uncut', () => {
    createKanbanCard({ id: 'p0000001', title: 'Szülő', status: 'planned', assignee: 'Marveen' })
    createKanbanCard({ id: 'k0000001', title: 'Gyerek egy', status: 'planned', parent_id: 'p0000001' })
    createKanbanCard({ id: 'k0000002', title: 'Gyerek kettő', status: 'waiting', parent_id: 'p0000001' })
    createKanbanCard({ id: 'u0000001', title: 'Unoka', status: 'planned', parent_id: 'k0000001' })
    for (let i = 0; i < 33; i++) createKanbanCard({ id: `b${String(i).padStart(7, '0')}`, title: `Várakozó ${i}`, status: 'waiting' })
    createKanbanCard({ id: 'd0000002', title: 'Kész Y', status: 'done' })
    const cards = listKanbanCards()
    const seq = (id: string) => cards.find(c => c.id === id)!.seq
    expect(boardText(cards, 'András')).toMatch(/\+\d+ további: \/board all/)
    const all = boardAllText(cards, 'András')
    expect(all).toMatch(/^Minden nyitott kártya: 37\n/)
    // siblings follow the board's own sort_order; the nesting is what matters
    expect(all).toContain(`PLANNED (1)\n${seq('p0000001')}) Szülő · Marveen\n    └ `)
    expect(all).toContain(`    └ ${seq('k0000001')}) Gyerek egy\n        └ ${seq('u0000001')}) Unoka`)
    expect(all).toContain(`    └ ${seq('k0000002')}) Gyerek kettő (waiting)`)
    expect(all).toMatch(/\nWAITING \(33\)\n/) // the child is under its parent, not counted again
    expect(all.match(/Várakozó \d+/g)).toHaveLength(33)
    expect(all).not.toContain('Kész Y')
  })

  it('/board <szám>: children listed on a parent, the parent named on a child; lookup by number or id', () => {
    createKanbanCard({ id: 'p0ffee01', title: 'Szülő kártya', status: 'waiting', assignee: 'Marveen' })
    createKanbanCard({ id: 'c0ffee01', title: 'Kártya', status: 'testing', parent_id: 'p0ffee01' })
    createKanbanCard({ id: 'c0ffee02', title: 'Kész testvér', status: 'done', parent_id: 'p0ffee01' })
    addKanbanComment('c0ffee01', 'marveen', 'első komment')
    const cards = listKanbanCards()
    const seq = (id: string) => cards.find(c => c.id === id)!.seq!
    expect(findCard(`${seq('c0ffee01')}`)?.id).toBe('c0ffee01')
    expect(findCard(`#${seq('c0ffee01')}`)?.id).toBe('c0ffee01')
    expect(findCard('c0ffee01')?.id).toBe('c0ffee01')
    const child = cardDetailText(findCard('c0ffee01')!, cards, 'András')
    expect(child).toMatch(new RegExp(`^${seq('c0ffee01')}\\) Kártya\\ntesting · nincs felelős · normal\\n`))
    expect(child).toContain(`↑ Szülő: ${seq('p0ffee01')}) Szülő kártya`)
    expect(child).toContain('marveen: első komment')
    expect(child).toMatch(/azonosító: c0ffee01$/)
    const parent = cardDetailText(findCard('p0ffee01')!, cards, 'András')
    expect(parent).toContain(`Alfeladatok (1 nyitott, 1 kész):\n${seq('c0ffee01')}) Kártya · testing`)
    expect(findCard('nincsilyen')).toBeUndefined()
  })
})

describe('/jobs next run is timezone-correct (CMD920 test 18)', () => {
  it('0 1,4,7-23 * * * at 02:30 Budapest -> 04:00 Budapest', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-22T00:30:00Z')) // 02:30 CEST
    expect(new Date(computeNextRun('0 1,4,7-23 * * *', 'Europe/Budapest') * 1000).toISOString()).toBe('2026-09-22T02:00:00.000Z')
    expect(nextRunText('0 1,4,7-23 * * *', 'Europe/Budapest')).toMatch(/04:00/)
  })

  it('winter time is honoured too', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-10T05:10:00Z')) // 06:10 CET
    expect(nextRunText('0 1,4,7-23 * * *', 'Europe/Budapest')).toMatch(/07:00/)
  })

  it('invalid cron is reported, not thrown', () => {
    expect(nextRunText('nem cron', 'Europe/Budapest')).toBe('érvénytelen cron')
  })
})

describe('/runs from the transcript (CMD920 test 17)', () => {
  const ts = (s: number) => new Date(Date.parse('2026-09-22T08:00:00Z') + s * 1000).toISOString()
  const user = (text: string, s: number) => JSON.stringify({ type: 'user', timestamp: ts(s), message: { role: 'user', content: text } })
  const toolUse = (uses: Array<[string, string, unknown]>, s: number) => JSON.stringify({
    type: 'assistant', timestamp: ts(s),
    message: { role: 'assistant', stop_reason: 'tool_use', content: uses.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) },
  })
  const result = (id: string, s: number) => JSON.stringify({ type: 'user', timestamp: ts(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
  const endTurn = (s: number) => JSON.stringify({ type: 'assistant', timestamp: ts(s), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'kész' }] } })

  it('lists every unpaired call; a Task sub-agent\'s open calls one level deeper', () => {
    const lines = [
      user('régi kör', 0), endTurn(5),
      user('nézd meg a naplót', 10),
      toolUse([['a', 'Bash', { command: 'ls -la' }]], 11),
      result('a', 12),
      toolUse([['t', 'Task', { description: 'kutatás' }], ['r', 'Read', { file_path: '/x/y.md' }]], 13),
      result('r', 14),
    ]
    const sub = [
      JSON.stringify({ type: 'user', timestamp: ts(13), message: { role: 'user', content: 'alfeladat' } }),
      toolUse([['s1', 'Grep', { pattern: 'TODO' }]], 15),
    ]
    const r = summarizeRound(lines, { 'agent-1.jsonl': sub })
    expect(r.idle).toBe(false)
    expect(r.prompt).toBe('nézd meg a naplót')
    expect(r.toolCalls).toBe(3)
    expect(r.open.map(o => o.name)).toEqual(['Task'])
    expect(r.open[0].children.map(c => c.name)).toEqual(['Grep'])
    const out = formatOpenCalls(r.open, Date.parse(ts(75)))
    expect(out[0]).toMatch(/^- Task: kutatás/)
    expect(out[1]).toMatch(/^ {2}- Grep: TODO/)
  })

  it('more than 5 parallel open calls: 5 listed, then "+N további"', () => {
    const uses: Array<[string, string, unknown]> = Array.from({ length: 7 }, (_, i) => [`id${i}`, 'Bash', { command: `sleep ${i}` }])
    const r = summarizeRound([user('sok', 0), toolUse(uses, 1)])
    expect(r.open).toHaveLength(7)
    const out = formatOpenCalls(r.open, Date.parse(ts(2)))
    expect(out).toHaveLength(6)
    expect(out[5]).toBe('+2 további')
  })

  it('finished round is idle; a reply call marks the message as sent', () => {
    const r = summarizeRound([
      user('szia', 0),
      toolUse([['m', 'mcp__plugin_telegram_telegram__reply', { text: 'hello' }]], 1),
      result('m', 2),
      endTurn(3),
    ])
    expect(r.idle).toBe(true)
    expect(r.messageSent).toBe(true)
  })

  it('call preview redacts secret-looking values', () => {
    expect(callPreview('Bash', { command: 'curl -H authorization: Bearer123 https://x' })).toContain('[REDACTED]')
    expect(callPreview('Bash', { command: 'TOKEN=abc123 ./run.sh' })).toBe('Bash: TOKEN=[REDACTED] ./run.sh')
  })
})

describe('/queue blocks (CMD920 test 16)', () => {
  it('an empty block says "nincs"; a throwing block keeps the others', () => {
    const text = formatBlocks([
      collectBlock('ELSŐ', () => []),
      collectBlock('HIBÁS', () => { throw new Error('db zárva') }),
      collectBlock('HARMADIK', () => ['egy sor']),
    ])
    expect(text).toBe('ELSŐ\nnincs\n\nHIBÁS\nhiba (db zárva)\n\nHARMADIK\negy sor')
  })

  it('the live queue has every block, owner-facing ones first, and shows pending approvals', () => {
    createApproval({ id: 'eeeeeeee-5', agent_id: 'marveen', category: 'email', action_description: 'Várakozó levél' })
    const blocks = collectQueue()
    expect(blocks.map(b => b.title)).toEqual([
      'VÁLASZRA VÁRÓ KÉRDÉS', 'JÓVÁHAGYÁS', 'INBOX (fő ágens)', 'INTER-AGENT (válaszra vár)',
      'FOLYAMATBAN', 'ÚJRAPRÓBÁLÁS', 'ÜTEMEZETT (következő 5)',
    ])
    const text = formatBlocks(blocks)
    expect(text).toMatch(/JÓVÁHAGYÁS\neeeeeeee · email · Várakozó levél/)
    expect(text).toMatch(/ÚJRAPRÓBÁLÁS\nnincs/)
  })
})

// Measured on the test bot (2026-09-23): the ledger logs the owner's /queue as
// an inbound question before the hook answers, and /queue listed itself.
describe('/queue: the open question is not the command being answered', () => {
  function logIn(mid: string, text: string) {
    getDb().prepare(`INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES (?, '42', 'in', ?, ?, '', ?)`)
      .run(MAIN_AGENT_ID, mid, text, Math.floor(Date.now() / 1000))
  }
  beforeEach(() => {
    clearCommandsForTest()
    registerCommand({ name: 'queue', kind: 'read', description: 'sor', run: async () => {} })
  })

  it('a registry command as the last inbound: no open question', () => {
    logIn('637', '/queue extra szavak')
    expect(formatBlocks(collectQueue())).toMatch(/VÁLASZRA VÁRÓ KÉRDÉS\nnincs/)
  })

  it('a real question (or an unknown /word) still shows', () => {
    logIn('640', 'mikor lesz kész a riport?')
    expect(formatBlocks(collectQueue())).toMatch(/VÁLASZRA VÁRÓ KÉRDÉS\nnyitott bejövő kérdés \(üzenet 640\)/)
    expect(isRegistryCommand('/kanban')).toBe(false)
    expect(isRegistryCommand('/Queue')).toBe(true)
    expect(isRegistryCommand(null)).toBe(false)
  })

  it('the /clear gate input (openQuestionIgnoringCommands): the command is not its own blocker', () => {
    registerCommand({ name: 'new', kind: 'write', description: 'új', run: async () => {} })
    logIn('700', '/new')
    expect(openQuestionIgnoringCommands(MAIN_AGENT_ID)).toBeNull()
    logIn('701', 'és a számla?')
    expect(openQuestionIgnoringCommands(MAIN_AGENT_ID)).toBe('701')
  })
})

// /board filters (owner request 2026-09-24): a status letter and/or whose.
describe('/board filters', () => {
  const aliases = botAliases('Marveen TEST', 'marveen-test')
  it('the bot name is not hard-coded: aliases and the help handle come from BOT_NAME / MAIN_AGENT_ID', () => {
    expect([...aliases].sort()).toEqual(['bot', 'marveen', 'marveen test', 'marveen-test'])
    expect(botHandle('Marveen TEST')).toBe('marveen')
    expect(botHandle('Edith')).toBe('edith')
  })

  it('parses status letters and whose, in any order, case-insensitive', () => {
    expect(parseBoardFilter(['w'], aliases)).toEqual({ status: 'waiting', who: null })
    expect(parseBoardFilter(['ME', 'p'], aliases)).toEqual({ status: 'planned', who: { kind: 'me' } })
    expect(parseBoardFilter(['Marveen'], aliases)).toEqual({ status: null, who: { kind: 'bot' } })
    expect(parseBoardFilter(['-', 'i'], aliases)).toEqual({ status: 'in_progress', who: { kind: 'none' } })
    expect(parseBoardFilter(['samu'], aliases)).toEqual({ status: null, who: { kind: 'name', name: 'samu' } })
    expect(parseBoardFilter(['w', 'p'], aliases)).toMatch(/Kétszer adtál meg oszlopot/)
  })

  it('filters by column and by whose; the bot matches every spelling; a matching child nests under a matching parent', () => {
    createKanbanCard({ id: 'p0000001', title: 'Szülő', status: 'waiting', assignee: 'Marveen' })
    createKanbanCard({ id: 'k0000001', title: 'Gyerek várakozik', status: 'waiting', assignee: 'marveen', parent_id: 'p0000001' })
    createKanbanCard({ id: 'k0000002', title: 'Gyerek tervezett', status: 'planned', assignee: 'András', parent_id: 'p0000001' })
    createKanbanCard({ id: 'x0000001', title: 'Senkié', status: 'planned' })
    createKanbanCard({ id: 'x0000002', title: 'Samué', status: 'waiting', assignee: 'SAMU' })
    createKanbanCard({ id: 'x0000003', title: 'Kész', status: 'done', assignee: 'Marveen' })
    const cards = listKanbanCards()
    const seq = (id: string) => cards.find(c => c.id === id)!.seq
    const w = boardFilterText(cards, { status: 'waiting', who: null }, 'András', aliases, 'marveen')
    expect(w).toMatch(/^WAITING \(3\)\n/)
    expect(w).toContain(`${seq('p0000001')}) Szülő · Marveen\n    └ ${seq('k0000001')}) Gyerek várakozik · marveen`)
    expect(w).not.toContain('Gyerek tervezett')
    const bot = boardFilterText(cards, { status: null, who: { kind: 'bot' } }, 'András', aliases, 'marveen')
    expect(bot).toMatch(/^NYITOTT · marveen \(2\)\n/) // Marveen + marveen, done left out
    const meP = boardFilterText(cards, { status: 'planned', who: { kind: 'me' } }, 'András', aliases, 'marveen')
    expect(meP).toContain(`PLANNED · András (1)\n${seq('k0000002')}) Gyerek tervezett ↑${seq('p0000001')}`) // parent not in the view: ↑mark
    expect(boardFilterText(cards, { status: null, who: { kind: 'none' } }, 'András', aliases, 'marveen')).toContain('Senkié')
    expect(boardFilterText(cards, { status: null, who: { kind: 'name', name: 'samu' } }, 'András', aliases, 'marveen')).toContain('Samué')
    const d = boardFilterText(cards, { status: 'done', who: null }, 'András', aliases, 'marveen')
    expect(d).toMatch(/^DONE \(1\)\n\(csak a még nem archivált kész kártyák\)\n/)
  })

  it('/board ? explains the options with examples, in the resolved bot name; never "<név>"', () => {
    const h = boardHelpText('marveen')
    expect(h).toMatch(/^\/board – a kanban tábla\n/)
    expect(h).toContain('  w várakozik · p tervezett · i folyamatban')
    expect(h).toContain('  marveen  Marveen kártyái')
    expect(h).toContain('  /board w marveen  ami Marveennél várakozik')
    expect(h).not.toContain('<név>')
    expect(boardHelpText('bot')).toContain('  bot      a boté')
    expect(nalNel('Marveen')).toBe('Marveennél')
    expect(nalNel('Samu')).toBe('Samunál')
    expect(nalNel('Edith')).toBe('Edithnél')
  })
})

