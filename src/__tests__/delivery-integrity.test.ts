import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyDelivery, readUserPromptsSince } from '../web/delivery-integrity.js'
import { checkTaskDeliveryIntegrity } from '../web/schedule-runner.js'
import { projectsDirFor } from '../web/active-model.js'

// PROMPTCSONK923 -- a scheduled prompt's delivery is judged by what the
// session's transcript recorded, not by the pane state at send time.
//
// The shapes below are the ones MEASURED on 2026-09-23 against an isolated
// Claude Code 2.1.280 probe driven by the real sendPromptToSession:
//   - foreign Enter mid-stream  -> two prompts: head (+ the foreign text) and
//     an envelope-less tail                                     => 'split'
//   - foreign C-u mid-stream    -> 13 chars missing from the middle => 'spliced'
//   - bracketed paste           -> whole text inside <pasted_content> => 'paste-wrapped'
// and the reference install's real truncation (2026-09-13 07:58:08Z,
// ledger-live-drain): only the last 870 of 1750 chars ever arrived => 'head-lost'.

function prompt(runId: string, len = 1750): string {
  let s = `[Utemezett feladat: ${runId}] <scheduled-task source="scheduled-task:${runId}"> body `
  let n = 0
  while (s.length < len) s += `#${String(n++).padStart(4, '0')} `
  return s + '</scheduled-task>'
}

describe('classifyDelivery', () => {
  const sent = prompt('drain')

  it('intact: a recorded prompt equals the typed text (surrounding whitespace ignored)', () => {
    expect(classifyDelivery(sent, [`  ${sent}\n`])).toBe('intact')
  })

  it("head-lost: the 2026-09-13 shape, only the tail was ever recorded", () => {
    expect(classifyDelivery(sent, [sent.slice(880)])).toBe('head-lost')
  })

  it('tail-lost: only the head was recorded', () => {
    expect(classifyDelivery(sent, [sent.slice(0, 700)])).toBe('tail-lost')
  })

  it('split: a foreign Enter cut it into two prompts (measured shape)', () => {
    const cut = 1440
    const head = sent.slice(0, cut) + '/rename probex' + sent.slice(cut, 1680)
    const tail = sent.slice(1680)
    expect(classifyDelivery(sent, [head, tail])).toBe('split')
  })

  it('spliced: head and tail in one prompt, middle damaged (measured C-u shape)', () => {
    const damaged = sent.slice(0, 900) + sent.slice(913)
    expect(classifyDelivery(sent, [damaged])).toBe('spliced')
  })

  it('paste-wrapped: whole text, but inside <pasted_content> (measured paste shape)', () => {
    const wrapped = `\n\n<pasted_content id="bd15">\n${sent}\n</pasted_content id="bd15">\n`
    expect(classifyDelivery(sent, [wrapped])).toBe('paste-wrapped')
  })

  it('the verdict closes at the first prompt carrying the tail: a LATER clean fire cannot mask it', () => {
    // The 2026-09-13 drain: truncated at 07:58:08, then fired again intact at
    // 08:00. An "any intact copy wins" rule read the damaged run as intact.
    expect(classifyDelivery(sent, [sent.slice(880), sent])).toBe('head-lost')
    expect(classifyDelivery(sent, [sent, sent.slice(880)])).toBe('intact')
  })

  it('a head-only fragment submitted before an otherwise whole copy is still a split', () => {
    expect(classifyDelivery(sent, [sent.slice(0, 500), sent])).toBe('split')
  })

  it('null -- not "fine" -- when nothing of ours arrived yet', () => {
    expect(classifyDelivery(sent, [])).toBeNull()
    expect(classifyDelivery(sent, ['[Inbox] Ha fent uj bejovo blokk van, dolgozd fel; ha nincs, hagyd.'])).toBeNull()
  })

  it("another task's prompt is not mistaken for ours", () => {
    expect(classifyDelivery(sent, [prompt('kanban-audit')])).toBeNull()
  })
})

describe('readUserPromptsSince', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deliv-int-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const T0 = Date.parse('2026-09-13T07:58:00.000Z')
  const line = (o: unknown) => JSON.stringify(o) + '\n'

  it('returns typed prompts at/after sinceMs, oldest first; skips tool results and other roles', () => {
    const f = join(dir, 's.jsonl')
    writeFileSync(f,
      line({ type: 'user', timestamp: '2026-09-13T07:57:59.000Z', message: { content: 'too old' } }) +
      line({ type: 'user', timestamp: '2026-09-13T07:58:09.000Z', message: { content: [{ type: 'text', text: 'second' }] } }) +
      line({ type: 'user', timestamp: '2026-09-13T07:58:08.541Z', message: { content: 'first' } }) +
      line({ type: 'user', timestamp: '2026-09-13T07:58:10.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'first' }] } }) +
      line({ type: 'assistant', timestamp: '2026-09-13T07:58:11.000Z', message: { content: 'user said first' } }) +
      'not json at all\n')
    expect(readUserPromptsSince([dir], T0)).toEqual(['first', 'second'])
  })

  it('does not open a transcript last modified before sinceMs', () => {
    const f = join(dir, 'old.jsonl')
    writeFileSync(f, line({ type: 'user', timestamp: '2026-09-13T07:58:30.000Z', message: { content: 'x' } }))
    const past = (T0 - 60_000) / 1000
    utimesSync(f, past, past)
    expect(readUserPromptsSince([dir], T0)).toEqual([])
  })

  it('reads only the tail window and drops the partial first line', () => {
    const f = join(dir, 'big.jsonl')
    const early = line({ type: 'user', timestamp: '2026-09-13T07:58:01.000Z', message: { content: 'E'.repeat(5000) } })
    const late = line({ type: 'user', timestamp: '2026-09-13T07:58:02.000Z', message: { content: 'late' } })
    writeFileSync(f, early + late)
    expect(readUserPromptsSince([dir], T0, late.length + 100)).toEqual(['late'])
  })

  it('a directory reached through two roots (symlink) is read once', () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 's.jsonl'), line({ type: 'user', timestamp: '2026-09-13T07:58:08.000Z', message: { content: 'once' } }))
    const link = join(dir, 'link')
    symlinkSync(real, link)
    expect(readUserPromptsSince([real, link], T0)).toEqual(['once'])
  })

  it('a missing directory is not an error', () => {
    expect(readUserPromptsSince([join(dir, 'nope')], T0)).toEqual([])
  })
})

describe('checkTaskDeliveryIntegrity (the sweep decision)', () => {
  const sent = prompt('drain')
  const base = {
    sentText: sent,
    typedAt: 1000,
    deliveryVerdict: undefined,
    workingDir: '/Users/x/ClaudeClaw',
    configDirs: ['/cfg/a', undefined, '/cfg/a'] as ReadonlyArray<string | undefined>,
  }

  it('reads the transcript dirs of EVERY config root, once each, since typing began', () => {
    let seen: { dirs: readonly string[]; since: number } | null = null
    checkTaskDeliveryIntegrity(base, false, (dirs, since) => { seen = { dirs, since }; return [sent] })
    expect(seen).not.toBeNull()
    expect(seen!.since).toBe(1000)
    expect([...seen!.dirs].sort()).toEqual([
      projectsDirFor('/Users/x/ClaudeClaw', '/cfg/a'),
      projectsDirFor('/Users/x/ClaudeClaw', undefined),
    ].sort())
  })

  it("persists 'tail-lost' only on the closing look (the tail of a split may still come)", () => {
    const read = () => [sent.slice(0, 600)]
    expect(checkTaskDeliveryIntegrity(base, false, read)).toBeNull()
    expect(checkTaskDeliveryIntegrity(base, true, read)).toBe('tail-lost')
  })

  it('every other verdict is final on first sight', () => {
    expect(checkTaskDeliveryIntegrity(base, false, () => [sent.slice(880)])).toBe('head-lost')
    expect(checkTaskDeliveryIntegrity(base, false, () => [sent])).toBe('intact')
  })

  it('no-op for a remote agent (no sentText) and after a verdict is recorded', () => {
    const read = () => { throw new Error('must not read') }
    expect(checkTaskDeliveryIntegrity({ ...base, sentText: undefined }, true, read)).toBeNull()
    expect(checkTaskDeliveryIntegrity({ ...base, deliveryVerdict: 'intact' }, true, read)).toBeNull()
  })

  it('a reader failure is swallowed in flight, and is unverifiable at the close', () => {
    const boom = () => { throw new Error('EACCES') }
    expect(checkTaskDeliveryIntegrity(base, false, boom)).toBeNull()
    expect(checkTaskDeliveryIntegrity(base, true, boom)).toBe('unverifiable')
  })

  it("the closing look never leaves it NULL: nothing arrived + readable transcript = 'not-arrived'", () => {
    // Marveen's #1506 review: in flight "nothing yet" is right, at the close
    // there is no "yet" -- a wholly lost prompt must not look like a row
    // nobody checked.
    expect(checkTaskDeliveryIntegrity(base, false, () => [], () => true)).toBeNull()
    expect(checkTaskDeliveryIntegrity(base, true, () => [], () => true)).toBe('not-arrived')
    expect(checkTaskDeliveryIntegrity(base, true, () => ['[Inbox] unrelated'], () => true)).toBe('not-arrived')
  })

  it("no readable transcript directory at the close = 'unverifiable', not 'not-arrived'", () => {
    expect(checkTaskDeliveryIntegrity(base, true, () => [], () => false)).toBe('unverifiable')
  })

  it('a remote agent (no sentText) stays NULL even at the close: never checked', () => {
    expect(checkTaskDeliveryIntegrity({ ...base, sentText: undefined }, true, () => [], () => true)).toBeNull()
  })

  it('end to end on disk: the 2026-09-13 shape is recorded as head-lost', () => {
    const root = mkdtempSync(join(tmpdir(), 'deliv-e2e-'))
    try {
      const pdir = projectsDirFor('/Users/x/ClaudeClaw', root)
      mkdirSync(pdir, { recursive: true })
      writeFileSync(join(pdir, 'fresh.jsonl'), JSON.stringify({
        type: 'user', timestamp: new Date(2000).toISOString(), message: { content: sent.slice(880) },
      }) + '\n')
      expect(checkTaskDeliveryIntegrity({ ...base, configDirs: [root] }, false)).toBe('head-lost')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the sweep is wired to it (source-level: the sweep needs live tmux)', () => {
  const RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  const DB = readFileSync(join(__dirname, '../db.ts'), 'utf-8')

  it('the fire path records the typed byte stream and when typing began, for local agents only', () => {
    const typedIdx = RUNNER.indexOf('let typedAt = Date.now()')
    const sendIdx = RUNNER.indexOf('await sendPromptToSession(session, fullPrompt, host, {')
    expect(typedIdx).toBeGreaterThan(0)
    expect(typedIdx).toBeLessThan(sendIdx)
    // typedAt is re-stamped at the first emitted keystroke, not at call start
    expect(RUNNER.slice(sendIdx, sendIdx + 200)).toMatch(/onEmitStart: \(\) => \{\s*typedAt = Date\.now\(\)/)
    const AP = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
    const emitIdx = AP.indexOf("const emitToPane = async (): Promise<'sent'> => {")
    expect(emitIdx).toBeGreaterThan(0)
    expect(AP.slice(emitIdx, emitIdx + 500)).toContain('opts.onEmitStart?.()')
    expect(RUNNER).toMatch(/host == null \? \{ sentText: paneOneLine\(fullPrompt\), typedAt \} : \{\}/)
  })

  it('the sweep checks BEFORE a closing decision deletes the entry, and persists the verdict', () => {
    const sweepIdx = RUNNER.indexOf('const decision = decideTaskTimeout(entry, state, now, {')
    const checkIdx = RUNNER.indexOf('checkTaskDeliveryIntegrity(entry, closing)', sweepIdx)
    const doneIdx = RUNNER.indexOf("if (decision === 'done' || decision === 'abandoned') {", sweepIdx)
    expect(checkIdx).toBeGreaterThan(sweepIdx)
    expect(checkIdx).toBeLessThan(doneIdx)
    expect(RUNNER.slice(checkIdx, doneIdx)).toContain('setTaskRunDelivery(entry.runId, verdict)')
    expect(RUNNER).toMatch(/const closing = decision === 'done' \|\| decision === 'abandoned' \|\| decision === 'lost'/)
  })

  it('the verdict lives in its own column, written once; status keeps its meaning', () => {
    expect(DB).toMatch(/ALTER TABLE task_runs ADD COLUMN delivery TEXT/)
    expect(DB).toMatch(/UPDATE task_runs SET delivery = \? WHERE id = \? AND delivery IS NULL/)
    expect(DB).toMatch(/SELECT ts, status, agent, completed_at, outcome, delivery FROM task_runs/)
  })
})
