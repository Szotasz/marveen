// CLAUDEMD_COMPACT (opt-in, default off): ten generated sections carry a short rule in CLAUDE.md, and the
// unchanged full body is kept, code-owned, in CLAUDE-details.md beside it (not auto-loaded by Claude Code).
//
// Pins: switch off = today's full block and no details file, in both scaffold languages; a details file that cannot
// be written = the full block stays in CLAUDE.md; switch on = compact block with a pointer, the full
// body between the same markers in the details file, idempotent, a hand edit of the details block restored;
// switch off again = full block back; the English variant; the agents that keep the full text (the main agent's
// mcp-list-channel, a curl-recipe agent's helper-verb sections).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-compact-test-'))
// readEnvFile (src/env.ts) takes its folder from this at import time.
process.env.CLAUDECLAW_ENV_DIR = tmpRoot

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    STORE_DIR: '/nonexistent/claudeclaw-test-store',
    PROJECT_ROOT: tmpRoot,
    OWNER_NAME: 'TestOwner',
    MAIN_AGENT_ID: 'agent-a',
    BOT_NAME: 'agent-a',
    CHANNEL_PROVIDER: 'telegram',
    WEB_PORT: 3420,
    OWNER_DRIVE_FOLDER: '',
    DASHBOARD_PUBLIC_URL: '',
    AGENT_API_ORIGIN: '',
    APP_TZ: 'Europe/Budapest',
    mainAgentRecipientLedgerEnabled: () => false,
  }
})
const setting = { compact: '0' }
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return { ...real, getEffectiveSettingValue: (key: string) => (key === 'CLAUDEMD_COMPACT' ? setting.compact : real.getEffectiveSettingValue(key)) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['agent-b'],
    readAgentCapabilities: () => [],
  }
})
const writes: string[] = []
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => { writes.push(path); writeFileSync(path, content, 'utf-8') },
}))

const S = await import('../web/agent-scaffold.js')

const MAIN = 'agent-a'
type Sec = { id: string; ensure: (n: string) => void; full: (n: string) => string }
const SECTIONS: Sec[] = [
  { id: 'autonomy-wiring', ensure: S.ensureAutonomySection, full: (n) => S.buildAutonomyBody(n, true, false) },
  { id: 'skills-path-trap', ensure: S.ensureSkillsPathTrapSection, full: (n) => S.buildSkillsPathTrapBody(n) },
  { id: 'fleet-auth', ensure: S.ensureFleetAuthSection, full: () => S.buildFleetAuthBody() },
  { id: 'mcp-list-channel', ensure: S.ensureMcpListChannelSection, full: () => S.buildMcpListChannelBody() },
  { id: 'message-close', ensure: S.ensureMessageCloseSection, full: (n) => S.buildMessageCloseBody(true, n) },
  { id: 'agent-id-header', ensure: S.ensureAgentIdHeaderSection, full: (n) => S.buildAgentIdHeaderBody(n, true) },
  { id: 'background-checkpoint', ensure: S.ensureBackgroundCheckpointSection, full: () => S.buildBackgroundCheckpointBody() },
  { id: 'pane-at-escape', ensure: S.ensurePaneAtEscapeSection, full: () => S.buildPaneAtEscapeBody() },
  { id: 'memory-fact-change', ensure: S.ensureMemoryFactChangeSection, full: (n) => S.buildMemoryFactChangeBody(n, true) },
  { id: 'api-helper', ensure: S.ensureApiHelperSection, full: (n) => S.buildApiHelperBody(n) },
]

const begin = (id: string) => `<!-- BEGIN GENERATED: ${id} (auto-generated, do not edit by hand) -->`
const end = (id: string) => `<!-- END GENERATED: ${id} -->`
function blockOf(text: string, id: string): string | null {
  const i = text.indexOf(begin(id))
  const j = text.indexOf(end(id))
  return i < 0 || j < 0 ? null : text.slice(i + begin(id).length + 1, j - 1)
}
const longestLine = (s: string) => s.split('\n').reduce((a, b) => (b.length > a.length ? b : a), '')
const dirOf = (n: string) => (n === MAIN ? tmpRoot : join(tmpRoot, 'agents', n))
const claudeMd = (n: string) => readFileSync(join(dirOf(n), 'CLAUDE.md'), 'utf-8')
const detailsPath = (n: string) => join(dirOf(n), 'CLAUDE-details.md')
function setup(n: string): void {
  mkdirSync(dirOf(n), { recursive: true })
  writeFileSync(join(dirOf(n), 'CLAUDE.md'), '# Agent\n', 'utf-8')
  rmSync(detailsPath(n), { force: true })
}
function setLang(lang: 'hu' | 'en'): void {
  writeFileSync(join(tmpRoot, '.env'), `AGENT_TEXT_LANG=${lang}\n`, 'utf-8')
}
const runAll = (n: string) => { for (const s of SECTIONS) s.ensure(n) }

describe('CLAUDEMD_COMPACT off (the default)', () => {
  it('every block is today\'s full body and no details file is written', () => {
    setLang('hu'); setting.compact = '0'
    setup('off-sub'); setup(MAIN)
    runAll('off-sub'); runAll(MAIN)
    for (const s of SECTIONS) {
      expect([s.id, blockOf(claudeMd('off-sub'), s.id)]).toEqual([s.id, s.full('off-sub')])
      expect([s.id, blockOf(claudeMd(MAIN), s.id)]).toEqual([s.id, s.full(MAIN)])
    }
    expect(existsSync(detailsPath('off-sub'))).toBe(false)
    expect(existsSync(detailsPath(MAIN))).toBe(false)
  })

  it('the English scaffold too: every block is the English full body, no details file', () => {
    setLang('en'); setting.compact = '0'
    setup('off-en'); setup(MAIN)
    runAll('off-en'); runAll(MAIN)
    for (const s of SECTIONS) {
      expect([s.id, blockOf(claudeMd('off-en'), s.id)]).toEqual([s.id, s.full('off-en')])
      expect([s.id, blockOf(claudeMd(MAIN), s.id)]).toEqual([s.id, s.full(MAIN)])
    }
    expect(blockOf(claudeMd('off-en'), 'fleet-auth')).toBe(S.buildFleetAuthBody())
    expect(/[áéíóöőúüű]/i.test(S.buildFleetAuthBody())).toBe(false)
    expect(existsSync(detailsPath('off-en'))).toBe(false)
    expect(existsSync(detailsPath(MAIN))).toBe(false)
    setLang('hu')
  })
})

describe('CLAUDEMD_COMPACT on, details file not writable', () => {
  it('every section keeps its full body in CLAUDE.md (never a short rule without its full text)', () => {
    setLang('hu'); setting.compact = '1'
    const n = 'nowrite-sub'
    setup(n)
    mkdirSync(detailsPath(n)) // a directory at the details path: every read/write of it throws
    runAll(n)
    for (const s of SECTIONS) expect([s.id, blockOf(claudeMd(n), s.id)]).toEqual([s.id, s.full(n)])
    rmSync(detailsPath(n), { recursive: true, force: true })
  })
})

describe('CLAUDEMD_COMPACT on, Hungarian sub-agent', () => {
  const n = 'on-sub'

  it('CLAUDE.md carries the compact body with a pointer; the details file the full body', () => {
    setLang('hu'); setting.compact = '1'
    setup(n)
    runAll(n)
    const md = claudeMd(n)
    const details = readFileSync(detailsPath(n), 'utf-8')
    for (const s of SECTIONS) {
      const full = s.full(n)
      const block = blockOf(md, s.id)!
      const heading = full.split('\n')[0].replace(/^#+\s*/, '')
      expect([s.id, block.split('\n').at(-1)]).toEqual([s.id, `Teljes szöveg: ${detailsPath(n)}, "${heading}" szakasz.`])
      expect([s.id, block.length < full.length]).toEqual([s.id, true])
      expect([s.id, md.includes(longestLine(full))]).toEqual([s.id, false])
      expect([s.id, blockOf(details, s.id)]).toEqual([s.id, full])
    }
  })

  it('names the agent and keeps the hard prohibitions as clauses', () => {
    const md = claudeMd(n)
    expect(blockOf(md, 'memory-fact-change')).toContain(`memory-search ${n} KULCSSZO --strict`)
    expect(blockOf(md, 'skills-path-trap')).toContain(`agents/${n}/.claude/skills`)
    expect(blockOf(md, 'autonomy-wiring')).toMatch(/approval-consume[\s\S]*csak 0-s kilépési kódnál/)
    expect(blockOf(md, 'autonomy-wiring')).toMatch(/email_send és data_delete kategóriánál az `approval-consume`-ot NE hívd/)
    expect(blockOf(md, 'fleet-auth')).toMatch(/soha ne másold/)
    // A CLAUDE.md reads an at-sign plus path as an import: the compact text carries none.
    expect(blockOf(md, 'pane-at-escape')).not.toContain('@')
  })

  it('a second run writes nothing', () => {
    writes.length = 0
    runAll(n)
    expect(writes).toEqual([])
  })

  it('a hand-edited details block is restored on the next run', () => {
    const p = detailsPath(n)
    const id = 'message-close'
    const text = readFileSync(p, 'utf-8')
    writeFileSync(p, text.replace(blockOf(text, id)!, 'kezzel atirva'), 'utf-8')
    runAll(n)
    expect(blockOf(readFileSync(p, 'utf-8'), id)).toBe(S.buildMessageCloseBody(true, n))
  })

  it('switch off again: the full body is back in CLAUDE.md', () => {
    setting.compact = '0'
    runAll(n)
    for (const s of SECTIONS) expect([s.id, blockOf(claudeMd(n), s.id)]).toEqual([s.id, s.full(n)])
  })
})

describe('CLAUDEMD_COMPACT on, English', () => {
  it('every compact block is English, with the English pointer', () => {
    setLang('en'); setting.compact = '1'
    const n = 'en-sub'
    setup(n)
    runAll(n)
    const md = claudeMd(n)
    for (const s of SECTIONS) {
      const full = s.full(n)
      const block = blockOf(md, s.id)!
      const heading = full.split('\n')[0].replace(/^#+\s*/, '')
      expect([s.id, block.split('\n').at(-1)]).toEqual([s.id, `Full text: ${detailsPath(n)}, section "${heading}".`])
      expect([s.id, /[áéíóöőúüű]/i.test(block)]).toEqual([s.id, false])
      expect([s.id, blockOf(readFileSync(detailsPath(n), 'utf-8'), s.id)]).toEqual([s.id, full])
    }
    expect(blockOf(md, 'message-close')).toContain('message-close <id> --no-notify')
    expect(blockOf(md, 'memory-fact-change')).toContain(`memory-search ${n} KULCSSZO --strict`)
    expect(blockOf(md, 'autonomy-wiring')).toMatch(/email_send and data_delete categories do NOT call `approval-consume`/)
    setLang('hu')
  })
})

describe('CLAUDEMD_COMPACT on: who keeps the full text', () => {
  it('the main agent keeps the full mcp-list-channel text; its skills-path-trap is the main variant', () => {
    setLang('hu'); setting.compact = '1'
    setup(MAIN)
    runAll(MAIN)
    const md = claudeMd(MAIN)
    expect(blockOf(md, 'mcp-list-channel')).toBe(S.buildMcpListChannelBody())
    const trap = blockOf(md, 'skills-path-trap')!
    expect(trap).toContain('/api/skills/propose')
    expect(trap).not.toContain(`agents/${MAIN}`)
    expect(trap).not.toBe(blockOf(claudeMd('on-sub'), 'skills-path-trap'))
    expect(blockOf(readFileSync(detailsPath(MAIN), 'utf-8'), 'skills-path-trap')).toBe(S.buildSkillsPathTrapBody(MAIN))
  })

  it('an agent whose settings deny the helper keeps the full text of the helper-verb sections', () => {
    setLang('hu'); setting.compact = '1'
    const n = 'curl-sub'
    setup(n)
    mkdirSync(join(dirOf(n), '.claude'), { recursive: true })
    writeFileSync(join(dirOf(n), '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }), 'utf-8')
    runAll(n)
    const md = claudeMd(n)
    expect(blockOf(md, 'autonomy-wiring')).toBe(S.buildAutonomyBody(n, false, false))
    expect(blockOf(md, 'message-close')).toBe(S.buildMessageCloseBody(false, n))
    expect(blockOf(md, 'agent-id-header')).toBe(S.buildAgentIdHeaderBody(n, false))
    expect(blockOf(md, 'memory-fact-change')).toBe(S.buildMemoryFactChangeBody(n, false))
    expect(blockOf(md, 'api-helper')).toBeNull()
    // The sections without a helper verb still go compact.
    expect(blockOf(md, 'fleet-auth')).not.toBe(S.buildFleetAuthBody())
  })
})
