// ENVATLEAK1114: the rule that explains the backslash the delivery layer puts
// before an at-sign in everything it types into an agent's pane.
//
// Functional part mirrors message-close-section.test.ts (temp root, mocked config).
// The wiring part reads the two call sites with comment lines removed, so a
// commented-out call does not pass for a live one. The body must carry no
// at-sign at all (a CLAUDE.md reads an at-sign plus path as an import), so the
// character is built here, never written literally.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-paneatesc-test-'))
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

const { ensurePaneAtEscapeSection, buildPaneAtEscapeBody, buildMessageCloseBody } = await import('../web/agent-scaffold.js')

const AT = String.fromCharCode(64)
const BEGIN = '<!-- BEGIN GENERATED: pane-at-escape (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: pane-at-escape -->'

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

describe('pane-at-escape section: what it says (ENVATLEAK1114)', () => {
  setLang(null)
  const body = buildPaneAtEscapeBody()

  it('the heading, and the four places the delivery layer puts the backslash (the replacement mark is the fourth)', () => {
    expect(body.split('\n')[0]).toBe('## Fordított perjel a kukac előtt a kapott szövegben')
    expect(body).toMatch(/paneledbe gépel[\s\S]{0,120}fordított perjelet[\s\S]{0,40}szöveg elején, térköz \(szóköz, sortörés\) után, pontosvessző után vagy a helyettesítő jel után álló kukac elé/)
  })

  it('control characters: a line break and a lone CR become a space, a tab stays, the rest becomes the mark', () => {
    expect(body).toMatch(/A sortörésből és a magányos kocsivissza jelből szóköz lesz, a tabulátor marad, a többi vezérlőkarakterből helyettesítő jel \(U\+FFFD\)\./)
    expect(body).not.toMatch(/a vezérlőkaraktereket/)
  })

  it('why: Claude Code would attach the file with no tool call, measured', () => {
    expect(body).toMatch(/eszközhívás nélkül csatolná \(mérve 2026-11-14\)/)
  })

  it('the backslash is not part of the original, drop it when copying onward', () => {
    expect(body).toMatch(/NEM része az eredeti szövegnek/)
    expect(body).toMatch(/másolsz tovább, a kukac előtti fordított perjelet hagyd el/)
  })

  it('the original is in the queue row the directive-verify recipe reads', () => {
    expect(body).toMatch(/Inter-agent üzenetnél és rendszer-direktívánál az eredeti szöveg az üzenetsor sorában áll[\s\S]{0,60}`directive-verify`/)
    expect(body).toMatch(/A gépelt másolat a fordított perjelben és a helyettesítő jelben eltérhet a sortól\./)
  })

  it('scope: the section explains the backslash and carries no further rule (four lines after the heading)', () => {
    expect(body.split('\n').filter((l) => l.startsWith('- ')).length).toBe(3)
    expect(body).not.toMatch(/SOHA/)
  })

  it('short, one heading, no em or en dash', () => {
    expect(body.split('\n').filter((l) => l.startsWith('## ')).length).toBe(1)
    expect(body.split('\n').length).toBeLessThanOrEqual(8)
    expect(body).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('pane-at-escape section: no at-sign in either language', () => {
  it('the Hungarian and the English body carry none (a CLAUDE.md reads at-sign plus path as an import)', () => {
    setLang(null)
    const hu = buildPaneAtEscapeBody()
    setLang('en')
    const en = buildPaneAtEscapeBody()
    setLang(null)
    expect(hu).not.toContain(AT)
    expect(en).not.toContain(AT)
    expect(hu).toContain('kukac')
    expect(en).toContain('at-sign')
  })

  it('the English twin exists and says the same things', () => {
    setLang('en')
    const en = buildPaneAtEscapeBody()
    setLang(null)
    expect(en.split('\n')[0]).toBe('## A backslash before an at-sign in the text you receive')
    expect(en).toMatch(/start of the text, after whitespace \(space, line break\), after a semicolon or after the replacement mark: without it/)
    expect(en).toMatch(/A line break and a lone carriage return become a space, a tab stays, and every other control character becomes a replacement mark \(U\+FFFD\)\./)
    expect(en).not.toMatch(/each control character/)
    expect(en).toMatch(/The typed copy can differ from the row in the backslash and in the replacement mark\./)
    expect(en).toMatch(/with no tool call \(measured 2026-11-14\)/)
    expect(en).toMatch(/NOT part of the original text/)
    expect(en).toMatch(/drop the backslash that stands before the at-sign/)
    expect(en).toMatch(/For an inter-agent message and a system directive the original text is in the queue row[\s\S]{0,60}`directive-verify`/)
    expect(en.split('\n').filter((l) => l.startsWith('- ')).length).toBe(3)
    expect(en).not.toMatch(/[\u2013\u2014]/)
  })

  it('the whole written block carries no at-sign either', () => {
    setup('agent-at', '# At\n')
    ensurePaneAtEscapeSection('agent-at')
    const out = read('agent-at')
    expect(out).toContain(BEGIN)
    expect(out).not.toContain(AT)
  })
})

describe('pane-at-escape section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setLang(null)
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensurePaneAtEscapeSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensurePaneAtEscapeSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setLang(null)
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensurePaneAtEscapeSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('## Fordított perjel a kukac előtt')
    expect(out).toContain('tail')
  })

  it('leaves another generated section untouched', () => {
    setLang(null)
    const other = `<!-- BEGIN GENERATED: message-close (auto-generated, do not edit by hand) -->\n${buildMessageCloseBody()}\n<!-- END GENERATED: message-close -->`
    setup('agent-d', `# D\n\n${other}\n`)
    ensurePaneAtEscapeSection('agent-d')
    const out = read('agent-d')
    expect(out).toContain(other)
    expect(out.indexOf(other)).toBeLessThan(out.indexOf(BEGIN))
  })

  it('no CLAUDE.md: nothing is created', () => {
    ensurePaneAtEscapeSection('agent-missing')
    expect(() => read('agent-missing')).toThrow()
  })

  it('the main agent is written at the project root CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensurePaneAtEscapeSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toContain(BEGIN)
  })
})

describe('pane-at-escape section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensurePaneAtEscapeSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensurePaneAtEscapeSection\(name\)/m)
  })
})
