// PERSONAESC1107 PR 2+3 (plan v2, section 5): the English twins of the generated CLAUDE.md sections
// (src/web/agent-scaffold-en.ts), chosen by AGENT_TEXT_LANG=en in the install's .env.
//
// What this pins, for every builder and every branch combination it has:
//  - the code is the same in both languages: every fenced line and every backtick span (after the
//    TRANSLATED_SPANS placeholders), so an English install runs exactly the recipes a Hungarian one does;
//  - the English text has no Hungarian prose outside the code and the protocol tokens;
//  - the managed block is replaced IN PLACE when the language switches, never duplicated;
//  - a staleness guard: a hash of every Hungarian body is pinned here. When a Hungarian body changes, this goes red
//    until its English twin is brought along and the hash below is updated.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-sections-en-test-'))
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
    HEARTBEAT_AGENT_ID: 'heartbeat',
    BOT_NAME: 'Botty',
    CHANNEL_PROVIDER: 'telegram',
    WEB_PORT: 3420,
    OWNER_DRIVE_FOLDER: '',
    DASHBOARD_PUBLIC_URL: '',
    AGENT_API_ORIGIN: '',
    APP_TZ: 'Europe/Budapest',
    mainAgentRecipientLedgerEnabled: () => false,
  }
})
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return { ...real, getEffectiveSettingValue: (key: string) => (key === 'AGENT_TOKENS' ? '1' : real.getEffectiveSettingValue(key)) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['own-token-sub', 'shared-token-sub'],
    readAgentCapabilities: () => [],
  }
})
// The roster's role tags: own-token-sub reports to shared-token-sub, which may delegate to the main agent.
vi.mock('../web/agent-team.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-team.js')>()
  return {
    ...real,
    readAgentTeam: (name: string) => ({
      role: 'member' as const,
      reportsTo: name === 'own-token-sub' ? 'shared-token-sub' : null,
      delegatesTo: name === 'shared-token-sub' ? ['agent-a'] : [],
      autoDelegation: false,
      trustFrom: [],
    }),
    resolveAgentSecurityProfile: () => 'default',
  }
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const sc = await import('../web/agent-scaffold.js')
const en = await import('../web/agent-scaffold-en.js')

const MAIN = 'agent-a'
const OWN = 'own-token-sub'
const SHARED = 'shared-token-sub'
for (const n of [OWN, SHARED]) mkdirSync(join(tmpRoot, 'agents', n), { recursive: true })
writeFileSync(join(tmpRoot, 'agents', OWN, '.dashboard-token'), 'c'.repeat(64), { mode: 0o600 })

function setLang(lang: 'hu' | 'en' | null): void {
  if (lang === null) rmSync(join(tmpRoot, '.env'), { force: true })
  else writeFileSync(join(tmpRoot, '.env'), `AGENT_TEXT_LANG=${lang}\n`, 'utf-8')
}

/** Every builder with every branch combination it has (name picks main / own token / shared token). */
const NAMES = [MAIN, OWN, SHARED]
const B = [false, true]
const CASES: Array<{ id: string; build: () => string }> = [
  { id: 'mcp-list-channel', build: () => sc.buildMcpListChannelBody() },
  { id: 'background-checkpoint', build: () => sc.buildBackgroundCheckpointBody() },
  { id: 'fleet-auth', build: () => sc.buildFleetAuthBody() },
  ...[OWN, SHARED].map((n) => ({ id: `fleet-roster:${n}`, build: () => sc.buildFleetRosterBody(n) })),
  ...NAMES.flatMap((n) => B.flatMap((h) => B.map((s) => ({ id: `autonomy:${n}:helper=${h}:strict=${s}`, build: () => sc.buildAutonomyBody(n, h, s) })))),
  ...B.flatMap((m) => B.map((l) => ({ id: `evidence:main=${m}:ledger=${l}`, build: () => sc.buildEvidenceBody(m, l) }))),
  ...NAMES.flatMap((n) => B.map((h) => ({ id: `message-close:${n}:helper=${h}`, build: () => sc.buildMessageCloseBody(h, n) }))),
  ...[MAIN, OWN].map((n) => ({ id: `skills-path-trap:${n}`, build: () => sc.buildSkillsPathTrapBody(n) })),
  ...NAMES.flatMap((n) => B.map((h) => ({ id: `system-directive-auth:${n}:helper=${h}`, build: () => sc.buildSystemDirectiveAuthBody(n, h) }))),
  ...NAMES.flatMap((n) => B.map((h) => ({ id: `agent-id-header:${n}:helper=${h}`, build: () => sc.buildAgentIdHeaderBody(n, h) }))),
  ...NAMES.flatMap((n) => B.map((h) => ({ id: `memory-search-label:${n}:helper=${h}`, build: () => sc.buildMemorySearchLabelBody(n, h) }))),
  ...NAMES.map((n) => ({ id: `strict-api:${n}`, build: () => sc.buildStrictApiBody(n) })),
  ...NAMES.map((n) => ({ id: `api-helper:${n}`, build: () => sc.buildApiHelperBody(n) })),
]

/** Placeholders and example values the agent copies into a text someone reads: translated on purpose (plan v2, 2). */
const TRANSLATED_SPANS: Array<[hu: string, en: string]> = [
  ['[FELHÍVÁS] CATEGORY_KEY: MIT akartam elvégezni, de level 1 miatt csak jelzek.', '[NOTICE] CATEGORY_KEY: WHAT I wanted to do, but level 1 means I only flag it.'],
  ['Mit tervezel elvégezni és miért', 'What you plan to do and why'],
  ['@fájl', '@file'],
  ['<cim>', '<address>'],
  ['<honnan>', '<where from>'],
  ['--date tegnap', '--date yesterday'],
  ['&date=tegnap', '&date=yesterday'],
  ['ÉÉÉÉ-HH-NN', 'YYYY-MM-DD'],
  ['ÓÓ:PP', 'HH:MM'],
  ['date=<tól>..<ig>', 'date=<from>..<to>'],
  ['<projekt-gyökér>', '<project-root>'],
  ['<sajat-neved>', '<your-own-name>'],
  ['<a-te-neved>', '<your-name>'],
  ['<név>', '<name>'],
]
const translate = (span: string) => TRANSLATED_SPANS.reduce((s, [hu, e]) => s.split(hu).join(e), span)

/** The fenced lines and the inline backtick spans of a body, sorted (a translated sentence may reorder its spans). */
function codeSpans(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; out.push(line.trim()); continue }
    if (inFence) { out.push(line); continue }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1])
    // A bare recipe line outside a fence (the level-2 helper recipes are not fenced).
    if (/^(bash |curl |node )/.test(line)) out.push(line)
  }
  return out.sort()
}

/** The prose of a body: the code removed (fenced lines, backtick spans, bare recipe lines). */
function prose(text: string): string {
  let inFence = false
  return text.split('\n').filter((line) => {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; return false }
    return !inFence && !/^(bash |curl |node )/.test(line)
  }).map((l) => l.replace(/`[^`]+`/g, ' ')).join('\n')
}

const HU_ACCENT = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
// Accent-free Hungarian words that would slip past the accent check.
const HU_WORDS = /\b(hogy|vagy|csak|kell|mert|nincs|soha|akkor|amit|majd|neked|tehat|ezert|ugyanaz|mielott|eloszor)\b/i

describe('generated sections: the English twin of every Hungarian body', () => {
  it('without the key the Hungarian body is built (no install changes by itself)', () => {
    setLang(null)
    expect(sc.buildFleetAuthBody()).toContain('## Flotta-szintű AUTH-szabály')
    setLang('hu')
    expect(sc.buildFleetAuthBody()).toContain('## Flotta-szintű AUTH-szabály')
    setLang('en')
    expect(sc.buildFleetAuthBody()).toContain('## Fleet-wide AUTH rule')
  })

  for (const c of CASES) {
    it(`${c.id}: the same code in both languages, and no Hungarian prose in the English one`, () => {
      setLang(null)
      const hu = c.build()
      setLang('en')
      const enBody = c.build()
      expect(enBody).not.toBe(hu)
      expect(codeSpans(enBody)).toEqual(codeSpans(hu).map(translate).sort())
      const p = prose(enBody)
      const accented = p.split('\n').filter((l) => HU_ACCENT.test(l))
      expect(accented).toEqual([])
      expect(p.match(HU_WORDS)).toBeNull()
      // The heading level and the line it starts with stay the same kind of line.
      expect(enBody.split('\n')[0].startsWith('## ')).toBe(true)
    })
  }

  it('the roster role tags and hierarchy lines are English too (the shared logic picks the English words)', () => {
    setLang('en')
    const own = sc.buildFleetRosterBody(OWN)
    const shared = sc.buildFleetRosterBody(SHARED)
    expect(own).toContain(`- **${SHARED}** (agent_id: ${SHARED}) (your lead): -`)
    expect(own).toContain(`Your lead: **${SHARED}**.`)
    expect(shared).toContain(`- **${OWN}** (agent_id: ${OWN}) (reports to you): -`)
    expect(shared).toContain(`- **${MAIN}** (agent_id: ${MAIN}) (you can delegate to them): -`)
    expect(shared).toContain(`Reporting to you: **${OWN}**.`)
    expect(shared).toContain(`You can delegate to: **${MAIN}**.`)
  })

  it('the English skills heading is the one the English template points at ("Skill path trap")', () => {
    const tpl = readFileSync(join(__dirname, '..', '..', 'templates', 'en', 'CLAUDE.md.template'), 'utf-8')
    expect(tpl).toContain('"Skill path trap" section')
    expect(en.SKILLS_TRAP_HEADING_EN.startsWith('## Skill path trap')).toBe(true)
  })

  it('a language switch replaces each managed block in place: one block, the new language, the text around it kept', () => {
    const file = join(tmpRoot, 'CLAUDE.md')
    writeFileSync(file, '# Main\n\nOwner text.\n', 'utf-8')
    const ensures = [sc.ensureAutonomySection, sc.ensureSkillsPathTrapSection, sc.ensureSystemDirectiveAuthSection,
      sc.ensureAgentIdHeaderSection, sc.ensureMemorySearchLabelSection, sc.ensureFleetAuthSection, sc.ensureEvidenceSection,
      sc.ensureMcpListChannelSection, sc.ensureMessageCloseSection, sc.ensureApiHelperSection, sc.ensureBackgroundCheckpointSection]
    setLang(null)
    for (const e of ensures) e(MAIN)
    const huText = readFileSync(file, 'utf-8')
    setLang('en')
    for (const e of ensures) e(MAIN)
    const enText = readFileSync(file, 'utf-8')
    const begins = (t: string) => (t.match(/<!-- BEGIN GENERATED: /g) ?? []).length
    expect(begins(huText)).toBe(11)
    expect(begins(enText)).toBe(11)
    expect(enText.startsWith('# Main\n\nOwner text.\n')).toBe(true)
    expect(enText).toContain('## Facts and guesses')
    expect(enText).not.toContain('## Tények és találgatás')
    // Running it again changes nothing.
    for (const e of ensures) e(MAIN)
    expect(readFileSync(file, 'utf-8')).toBe(enText)
    // And back (a hand edit of the key): the Hungarian file again, byte for byte.
    setLang(null)
    for (const e of ensures) e(MAIN)
    expect(readFileSync(file, 'utf-8')).toBe(huText)
  })
})

// STALENESS GUARD. A Hungarian body changed? Bring its English twin in src/web/agent-scaffold-en.ts along, then
// update the hash here (the failing test prints the new one). The hash covers every branch combination above.
const HU_SOURCE_HASHES: Record<string, string> = {
  'agent-id-header': '44f5248d7fc36cbc',
  'api-helper': 'a70dbd6e315bb59e',
  'autonomy': '728210d786c75e11',
  'background-checkpoint': '04505f8789507f70',
  'evidence': '9dff6e8bd9b8d64c',
  'fleet-auth': '93c48bc9916ec0da',
  'fleet-roster': '1150d059b61e7362',
  'mcp-list-channel': 'a7ccf3ed2f0ca342',
  'memory-search-label': '9ddf9811134c353e',
  'message-close': '835ee6c92d6e0a7a',
  'skills-path-trap': '76b7632b730c8120',
  'strict-api': 'e619c666af284fec',
  'system-directive-auth': '2267241c76f696aa',
}

describe('generated sections: staleness guard (a Hungarian change needs its English twin)', () => {
  const groups = new Map<string, string[]>()
  for (const c of CASES) {
    const g = c.id.split(':')[0]
    groups.set(g, [...(groups.get(g) ?? []), c.id])
  }
  for (const [g, ids] of groups) {
    it(`${g}: the Hungarian body is the one the English twin was written against`, () => {
      setLang(null)
      const h = createHash('sha256')
      // The bodies embed the (random) test root: hashed as <ROOT>, so the digest is the same on every run.
      for (const id of ids) h.update(`${id}\n${CASES.find((c) => c.id === id)!.build().split(tmpRoot).join('<ROOT>')}\n`)
      const digest = h.digest('hex').slice(0, 16)
      expect(HU_SOURCE_HASHES[g], `${g}: the Hungarian body changed; update its English twin, then set the hash to '${digest}'`).toBe(digest)
    })
  }
})
