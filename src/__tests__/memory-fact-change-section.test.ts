// MEMFACTCHANGE1118: when a fact changes, the old memory is fixed in the same round.
//
// Functional part mirrors pane-at-escape-section.test.ts (temp root, mocked config).
// What is pinned: the rule's four points in both languages, the recipes it hands
// over (the helper's --supersedes / memory-retract, or the raw routes for an
// agent off the helper), the idempotent insert/refresh, and the wiring to both
// surfaces (web.ts for the main agent, agent-process.ts for every agent start).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-memfactchange-test-'))
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
  }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['agent-a', 'agent-b'],
    readAgentCapabilities: () => [],
  }
})

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureMemoryFactChangeSection, buildMemoryFactChangeBody, buildPaneAtEscapeBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: memory-fact-change (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: memory-fact-change -->'

function setLang(lang: 'hu' | 'en' | null): void {
  if (lang === null) rmSync(join(tmpRoot, '.env'), { force: true })
  else writeFileSync(join(tmpRoot, '.env'), `AGENT_TEXT_LANG=${lang}\n`, 'utf-8')
}
function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('memory-fact-change section: what it says (Hungarian)', () => {
  setLang(null)
  const body = buildMemoryFactChangeBody('agent-b', true)

  it('the heading, and the why, measured', () => {
    expect(body.split('\n')[0]).toBe('## Ha egy tény megváltozik: a régi emléket is javítsd')
    expect(body).toMatch(/mérve 2026-11-18/)
  })

  it('a state-changing save first searches the old claim, strictly, and fixes it in the same round', () => {
    expect(body).toMatch(/ÁLLAPOTOT változtat meg[\s\S]{0,200}UGYANABBAN a körben javítsd/)
    expect(body).toMatch(/memory-search agent-b KULCSSZO --strict/)
  })

  it('own fully stale row: --supersedes or memory-retract with the agent\'s own name; partly valid: an in-place dated note', () => {
    expect(body).toMatch(/--supersedes <régi-id>/)
    expect(body).toMatch(/memory-retract <id> agent-b`/)
    expect(body).toMatch(/`memory-update` a régi id-re/)
    expect(body).toMatch(/\[ÉÉÉÉ-HH-NN: ELAVULT, mert \.\.\. \(új emlék #id\)\]/)
  })

  it('says what the server actually does: superseded vs skipped, and that memory-update replaces the whole content', () => {
    // saveAgentMemorySuperseding skips another agent's id without an error; only the reply tells.
    expect(body).toMatch(/`superseded` mezője mondja meg[\s\S]{0,120}`skipped` mezőben áll/)
    // memory-update is a PUT of the whole content: a note sent alone would overwrite the row.
    expect(body).toMatch(/TELJES tartalmát cseréli[\s\S]{0,80}teljes régi szöveget küldd vissza/)
  })

  it('never another agent\'s row, never a Q/D/B row; a present-tense claim is saved with its date', () => {
    expect(body).toMatch(/Idegen sort ne vonj vissza/)
    expect(body).toMatch(/Q\/D\/B azonosítós bejegyzést SOHA ne vonj vissza, és `supersedes`-ben se add meg/)
    expect(body).toMatch(/Jelen idejű állítást[\s\S]{0,80}dátummal ments/)
    expect(body).toMatch(/A visszavonás nem törlés/)
  })

  it('the rule file is fixed too, a rule is not copied into a memory, and a retraction has no way back', () => {
    expect(body).toMatch(/skillben vagy CLAUDE\.md-ben is le van írva, azt is javítsd ugyanabban a körben/)
    expect(body).toMatch(/1547 emlékből 34 ellentmondott egy szabályfájlnak,\s+és ebből 8 esetben a szabályfájl volt az elavult/)
    expect(body).toMatch(/Ne ments emléket olyan szabályról, ami már szó szerint/)
    expect(body).toMatch(/az esetet mentsd, és hivatkozz a szabály helyére/)
    // src/db.ts retractMemory is the only write to retracted_at, and it only ever sets it.
    expect(body).toMatch(/A visszavonásnak nincs visszaállító útja/)
    expect(body).toMatch(/kétség esetén a dátumos ELAVULT-jelölés a biztonságos/)
    // The new points sit after the Q/D/B point, before the present-tense one.
    expect(body.indexOf('Q/D/B azonosítós')).toBeLessThan(body.indexOf('Ha a megváltozott tény'))
    expect(body.indexOf('A visszavonásnak nincs')).toBeLessThan(body.indexOf('Jelen idejű állítást'))
  })

  it('one heading, no em or en dash, no at-sign (a CLAUDE.md reads at-sign plus path as an import)', () => {
    expect(body.split('\n').filter((l) => l.startsWith('## ')).length).toBe(1)
    expect(body).not.toMatch(/[–—]/)
    expect(body).not.toContain(String.fromCharCode(64))
  })
})

describe('memory-fact-change section: an agent off the helper gets the raw routes', () => {
  it('no helper verb, the retract route and the supersedes field instead', () => {
    setLang(null)
    const body = buildMemoryFactChangeBody('agent-b', false)
    expect(body).not.toMatch(/marveen-api\.sh/)
    expect(body).toMatch(/`POST \/api\/memories\/<id>\/retract`, törzs: `\{"agent_id":"agent-b"\}`/)
    expect(body).toMatch(/`"supersedes": \[<régi-id>\]`/)
    expect(body).toMatch(/&strict=1/)
    expect(body).toMatch(/`PUT \/api\/memories\/<id>` a régi id-re\. Ez a sor TELJES tartalmát cseréli/)
    expect(body).toMatch(/`skipped` mezőben áll/)
  })
})

describe('memory-fact-change section: the English twin', () => {
  it('says the same things, with both recipe variants', () => {
    setLang('en')
    const en = buildMemoryFactChangeBody('agent-b', true)
    const enRaw = buildMemoryFactChangeBody('agent-b', false)
    setLang(null)
    expect(en.split('\n')[0]).toBe('## When a fact changes: fix the old memory too')
    expect(en).toMatch(/measured 2026-11-18/)
    expect(en).toMatch(/memory-search agent-b KEYWORD --strict/)
    expect(en).toMatch(/--supersedes <old-id>/)
    expect(en).toMatch(/memory-retract <id> agent-b`/)
    expect(en).toMatch(/\[YYYY-MM-DD: OUTDATED, because \.\.\. \(new memory #id\)\]/)
    expect(en).toMatch(/Never retract or rewrite another agent's row/)
    expect(en).toMatch(/NEVER retract an entry that carries a Q\/D\/B id, and do not name it in `supersedes` either/)
    expect(en).toMatch(/`superseded` field says what it retracted, an id under `skipped`/)
    expect(en).toMatch(/replaces the row's WHOLE content, so\s+send the whole old text back/)
    expect(enRaw).toMatch(/`PUT \/api\/memories\/<id>` on the old id\. It replaces the row's WHOLE/)
    expect(en).toMatch(/A retraction is not a delete/)
    expect(en).toMatch(/also written in a skill or a CLAUDE\.md, fix that too in the same round/)
    expect(en).toMatch(/of 1547 memories, 34 contradicted a rule\s+file, and in 8 of those it was the rule file that was outdated/)
    expect(en).toMatch(/Do not save a memory about a rule that already stands word for word/)
    expect(en).toMatch(/A retraction has no way back/)
    expect(en).toMatch(/when in doubt, the dated OUTDATED note is the safe choice/)
    expect(enRaw).not.toMatch(/marveen-api\.sh/)
    expect(enRaw).toMatch(/`POST \/api\/memories\/<id>\/retract` with `\{"agent_id":"agent-b"\}`/)
    expect(en).not.toMatch(/[–—]/)
    expect(enRaw).not.toContain(String.fromCharCode(64))
  })
})

describe('memory-fact-change section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setLang(null)
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureMemoryFactChangeSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    expect(once).toContain('## Ha egy tény megváltozik')
    ensureMemoryFactChangeSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setLang(null)
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureMemoryFactChangeSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('leaves another generated section untouched', () => {
    setLang(null)
    const other = `<!-- BEGIN GENERATED: pane-at-escape (auto-generated, do not edit by hand) -->\n${buildPaneAtEscapeBody()}\n<!-- END GENERATED: pane-at-escape -->`
    setup('agent-d', `# D\n\n${other}\n`)
    ensureMemoryFactChangeSection('agent-d')
    const out = read('agent-d')
    expect(out).toContain(other)
    expect(out.indexOf(other)).toBeLessThan(out.indexOf(BEGIN))
  })

  it('no CLAUDE.md: nothing is created', () => {
    ensureMemoryFactChangeSection('agent-missing')
    expect(() => read('agent-missing')).toThrow()
  })

  it('the main agent is written at the project root CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureMemoryFactChangeSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toContain(BEGIN)
  })
})

describe('memory-fact-change section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureMemoryFactChangeSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureMemoryFactChangeSection\(name\)/m)
  })
})
