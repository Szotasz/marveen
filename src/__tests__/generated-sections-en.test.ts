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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
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
    listAgentNames: () => ['own-token-sub', 'shared-token-sub', 'curl-sub'],
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
    resolveAgentSecurityProfile: (name: string) => (name === 'strict-sub' ? 'developer-junior' : 'default'),
  }
})
// The generators' prompts are captured, not sent.
const captured = { prompt: '' }
vi.mock('../agent.js', () => ({
  runAgent: async (prompt: string) => { captured.prompt = prompt; return { text: '# Generated\n' } },
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

// The profiles load from <PROJECT_ROOT>/templates/profiles (the mocked root): the real files, copied in.
mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}

const sc = await import('../web/agent-scaffold.js')
const en = await import('../web/agent-scaffold-en.js')

const MAIN = 'agent-a'
const OWN = 'own-token-sub'
const SHARED = 'shared-token-sub'
const CURL = 'curl-sub'
const STRICT = 'strict-sub'
for (const n of [OWN, SHARED, CURL, STRICT]) mkdirSync(join(tmpRoot, 'agents', n, '.claude'), { recursive: true })
writeFileSync(join(tmpRoot, 'agents', OWN, '.dashboard-token'), 'c'.repeat(64), { mode: 0o600 })
writeFileSync(join(tmpRoot, 'agents', CURL, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }), 'utf-8')

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
  { id: 'pane-at-escape', build: () => sc.buildPaneAtEscapeBody() },
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
  { id: 'skill-section:curl', build: () => sc.buildSkillSection(undefined, join(tmpRoot, 'store', '.dashboard-token')) },
  { id: 'skill-section:helper', build: () => sc.buildSkillSection(OWN, join(tmpRoot, 'agents', OWN, '.dashboard-token')) },
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
  ['"content":"MIT"', '"content":"WHAT"'],
  ['## HH:MM -- Tema', '## HH:MM -- Topic'],
  ['Mi tortent, mi lett az eredmeny', 'What happened, what the result was'],
  ['"miért kell, mit javít"', '"why it is needed, what it fixes"'],
  ['[üzenet röviden]', '[the message in short]'],
  ['<tool_nev>', '<tool_name>'],
]
const translate = (span: string) => TRANSLATED_SPANS.reduce((s, [hu, e]) => s.split(hu).join(e), span)

const CODE_LINE = /^(bash |curl |node |grep |mkdir |python3 |cat |SKILLEOF$|JSON$|\{"from"|  -H |  --data-binary )/

/** The fenced lines and the inline backtick spans of a body, sorted (a translated sentence may reorder its spans). */
function codeSpans(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; out.push(line.trim()); continue }
    if (inFence) { out.push(line); continue }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1])
    // A bare recipe line outside a fence (the level-2 helper recipes, the creation prompt, the skill section).
    if (CODE_LINE.test(line)) out.push(line)
  }
  return out.sort()
}

/** The prose of a body: the code removed (fenced lines, backtick spans, bare recipe lines). */
function prose(text: string): string {
  let inFence = false
  return text.split('\n').filter((line) => {
    if (line.trimStart().startsWith('```')) { inFence = !inFence; return false }
    return !inFence && !CODE_LINE.test(line)
  }).map((l) => l.replace(/`[^`]+`/g, ' ')).join('\n')
}

const PROTOCOL_HU = ['Ismeretlen sender [ID] jelezett első üzenettel', 'Ki ez, mit válaszoljak?', '[Napló ']
const stripProtocol = (t: string) => PROTOCOL_HU.reduce((x, tok) => x.split(tok).join(' '), t)
/** Identifiers that can sit inside a sentence: "key":"value", key="value", and absolute paths under the test root. */
const proseIds = (text: string): string[] => [
  ...(text.match(/"[a-z_]+":"[^"]*"/g) ?? []),
  ...(text.match(/\b[a-z_]+="[^"]*"/g) ?? []),
  ...(text.match(new RegExp(`${tmpRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s\`'")]*`, 'g')) ?? []),
].sort()

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
      expect(proseIds(enBody)).toEqual(proseIds(hu).map(translate).sort())
      const p = stripProtocol(prose(enBody))
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
      sc.ensureMcpListChannelSection, sc.ensureMessageCloseSection, sc.ensureApiHelperSection, sc.ensureBackgroundCheckpointSection,
      sc.ensurePaneAtEscapeSection]
    setLang(null)
    for (const e of ensures) e(MAIN)
    const huText = readFileSync(file, 'utf-8')
    setLang('en')
    for (const e of ensures) e(MAIN)
    const enText = readFileSync(file, 'utf-8')
    const begins = (t: string) => (t.match(/<!-- BEGIN GENERATED: /g) ?? []).length
    expect(begins(huText)).toBe(12)
    expect(begins(enText)).toBe(12)
    expect(enText.startsWith('# Main\n\nOwner text.\n')).toBe(true)
    expect(enText).toContain('## Facts and guesses')
    expect(enText).toContain('If blocks with their own envelope follow the directive text (a `[KOTEG: ...]` head, or an `[Uzenet @...]` envelope\nwith the notice line before it), they are SEPARATE messages, NOT part of the directive: the content ends before the first such block; handle each block by its own envelope.')
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

async function claudeMdPrompt(name: string): Promise<string> {
  captured.prompt = ''
  const out = await sc.generateClaudeMd(name, 'Test agent', 'test-model')
  return `${captured.prompt}\n=== appended ===\n${out}`
}

describe('the new sub-agent\'s CLAUDE.md prompt and SOUL/SKILL prompts in English', () => {
  for (const n of [OWN, SHARED, CURL, STRICT]) {
    it(`${n}: the same recipes in both languages, English prose, English appended blocks`, async () => {
      setLang(null)
      const hu = await claudeMdPrompt(n)
      setLang('en')
      const enP = await claudeMdPrompt(n)
      expect(codeSpans(enP)).toEqual(codeSpans(hu).map(translate).sort())
      expect(proseIds(enP)).toEqual(proseIds(hu).map(translate).sort())
      const p = stripProtocol(prose(enP))
      expect(p.split('\n').filter((l) => HU_ACCENT.test(l))).toEqual([])
      expect(p.match(HU_WORDS)).toBeNull()
      expect(enP).toContain('## Memory system')
      expect(enP).toContain(en.SKILL_SECTION_HEADING_EN)
      expect(enP).toContain('## The other agents of the fleet')
      expect(enP).toContain('## Autonomy and approval')
      // The ping frame stays word for word, the one the English main persona quotes.
      expect(enP).toContain('Ismeretlen sender [ID] jelezett első üzenettel:')
      expect(enP).not.toContain('Hungarian with')
    })
  }

  it('the curl-recipe agent really is on curl recipes, the others on the helper (the cases cover both forms)', async () => {
    setLang('en')
    expect(await claudeMdPrompt(CURL)).toContain('curl -s -X POST')
    expect(await claudeMdPrompt(SHARED)).toContain('marveen-api.sh memory-save AGENT_NAME')
    expect(await claudeMdPrompt(OWN)).toContain('The helper sends your OWN token (AGENT_TOKENS)')
  })

  it('the strict agent really is strict (the case above covers the dontAsk branch)', async () => {
    setLang('en')
    expect(await claudeMdPrompt(STRICT)).toContain('Your profile runs in dontAsk mode')
    setLang(null)
    expect(await claudeMdPrompt(STRICT)).toContain('A profilod dontAsk módban fut')
  })

  it('a configured shared Drive folder: the English rule names it, as the Hungarian one does', () => {
    const f = sc.scaffoldFrags(OWN)
    const p = en.buildClaudeMdPromptEn({ name: OWN, description: 'd', model: 'm', ownerName: 'TestOwner', appTz: 'Europe/Budapest',
      driveFolder: 'FOLDER123', agentsDir: join(tmpRoot, 'agents'), helper: true, R: en.strictPromptRecipesEn(false, f), skillSection: '', f })
    expect(p).toContain('https://drive.google.com/drive/folders/FOLDER123 - write here')
    expect(p).not.toContain('ask TestOwner for the right Drive folder')
  })

  it('the prose-identifier check really sees the identifiers (positive control)', () => {
    setLang('en')
    expect(proseIds(sc.buildSystemDirectiveAuthBody(OWN, true))).toContain(`to_agent="${OWN}"`)
    expect(proseIds(sc.buildAutonomyBody(OWN, true, false))).toContain(`"for_agent":"${OWN}"`)
    expect(proseIds(sc.buildAutonomyBody(OWN, true, false)).some((x) => x.endsWith('api-uzenet.txt'))).toBe(true)
  })

  it('the roster with no other agent says so in English', () => {
    expect(en.ROSTER_TEXT_EN.none).toBe('(no registered agent)')
  })

  it('the strict intro is English too', () => {
    const f = sc.scaffoldFrags(OWN)
    for (const strict of [true, false]) {
      const r = en.strictPromptRecipesEn(strict, f)
      const text = stripProtocol(Object.values(r).join('\n'))
      expect(text.split('\n').filter((l) => HU_ACCENT.test(l))).toEqual([])
    }
  })

  it('SOUL.md and SKILL.md prompts: English on en, the Hungarian ones without the key', async () => {
    setLang('en')
    await sc.generateSoulMd(OWN, 'x')
    expect(captured.prompt).toContain('Write the SOUL.md in English.')
    expect(captured.prompt).not.toContain('Hungarian')
    await sc.generateSkillMd('demo', 'x')
    expect(captured.prompt).toContain('Write the SKILL.md in English.')
    expect(captured.prompt).not.toMatch(/Hungarian with|Write ALL Hungarian/)
    setLang(null)
    await sc.generateSoulMd(OWN, 'x')
    expect(captured.prompt).toContain('Write ALL Hungarian text with proper accents')
  })

  it('the skill section migration on an English install: the other recipe form is upgraded, a Hungarian section is left alone', () => {
    setLang('en')
    const file = join(tmpRoot, 'agents', SHARED, 'CLAUDE.md')
    const curlForm = sc.buildSkillSection(undefined, join(tmpRoot, 'store', '.dashboard-token'))
    writeFileSync(file, `# Sub\n\n${curlForm}\n\n## After\n\nkept\n`, 'utf-8')
    expect(sc.ensureSkillSectionCurrent(SHARED)).toBe(true)
    const up = readFileSync(file, 'utf-8')
    expect(up).toContain(`marveen-api.sh skill-propose SKILL-NEV`)
    expect(up).not.toContain('/api/skills/propose -H')
    expect(up).toContain('## After\n\nkept\n')
    expect(sc.ensureSkillSectionCurrent(SHARED)).toBe(false)
    // A Hungarian section (the key set by hand on an older agent): never cross-language.
    setLang(null)
    const huForm = sc.buildSkillSection(undefined, join(tmpRoot, 'store', '.dashboard-token'))
    setLang('en')
    writeFileSync(file, `# Sub\n\n${huForm}\n`, 'utf-8')
    expect(sc.ensureSkillSectionCurrent(SHARED)).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe(`# Sub\n\n${huForm}\n`)
  })

  it('creation prompt staleness guard: the Hungarian prompt is the one the English twin was written against', async () => {
    setLang(null)
    const h = createHash('sha256')
    for (const n of [OWN, SHARED, CURL, STRICT]) h.update(`${n}\n${(await claudeMdPrompt(n)).split(tmpRoot).join('<ROOT>')}\n`)
    await sc.generateSoulMd('x', 'x'); h.update(captured.prompt)
    await sc.generateSkillMd('x', 'x'); h.update(captured.prompt)
    const digest = h.digest('hex').slice(0, 16)
    expect(HU_SOURCE_HASHES['claude-md-prompt'], `claude-md-prompt: the Hungarian prompt changed; update its English twin, then set the hash to '${digest}'`).toBe(digest)
  })
})

const REPO_TEMPLATE = join(__dirname, '..', '..', 'templates', 'settings.json.template')
type Hook = { type?: string; prompt?: string }
const preCompactPrompt = (json: string): string => {
  const t = JSON.parse(json) as { hooks: Record<string, Array<{ hooks: Hook[] }>> }
  return t.hooks.PreCompact.flatMap((g) => g.hooks).find((h) => h.type === 'agent')!.prompt!
}
const PRECOMPACT_TRANSLATED: Array<[string, string]> = [
  ['egy mondat mit csinálsz', 'one sentence on what you are doing'],
  ['már kész lépés', 'a step already done'],
  ['mit kinek adtál már át', 'what you already handed to whom'],
  ['a következő konkrét lépés', 'the next concrete step'],
  ['nyitott döntés vagy blokkoló ha van', 'an open decision or blocker, if any'],
]
const commandLines = (prompt: string, map: Array<[string, string]> = []) => prompt.split('\n')
  .filter((l) => /^\s*(bash |mkdir |\{"summary"|SKILLEOF$)/.test(l) || /scripts\/skill-index\.sh/.test(l))
  .map((l) => l.replace(/^.*?(bash \{\{PROJECT_ROOT\}\}\/scripts\/skill-index\.sh)/, '$1'))
  .map((l) => map.reduce((x, [a, b]) => x.split(a).join(b), l))

describe('the PreCompact agent-hook prompt of a new agent on an English install', () => {
  const raw = readFileSync(REPO_TEMPLATE, 'utf-8')

  it('without the key the template is returned byte for byte', () => {
    setLang(null)
    expect(sc.localizeSettingsTemplate(raw)).toBe(raw)
  })

  it('only the PreCompact AGENT hook is swapped: a command or prompt hook, and another event\'s agent hook, stay (Dani 72871 N2)', () => {
    setLang('en')
    const tpl = JSON.stringify({ hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: 'x.sh' }, { type: 'prompt', prompt: 'P-HU' }, { type: 'agent', prompt: 'A-HU', timeout: 180 }] }],
      Stop: [{ hooks: [{ type: 'agent', prompt: 'S-HU' }] }],
    } })
    const out = JSON.parse(sc.localizeSettingsTemplate(tpl)) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> }
    expect(out.hooks.PreCompact[0].hooks).toEqual([
      { type: 'command', command: 'x.sh' }, { type: 'prompt', prompt: 'P-HU' }, { type: 'agent', prompt: en.PRECOMPACT_PROMPT_EN_TPL, timeout: 180 },
    ])
    expect(out.hooks.Stop[0].hooks).toEqual([{ type: 'agent', prompt: 'S-HU' }])
  })

  it('with en only the PreCompact agent prompt changes, its commands are the Hungarian ones, its prose is English', () => {
    setLang('en')
    const out = sc.localizeSettingsTemplate(raw)
    const huPrompt = preCompactPrompt(raw)
    const enPrompt = preCompactPrompt(out)
    expect(enPrompt).toBe(en.PRECOMPACT_PROMPT_EN_TPL)
    // Everything else is the same template.
    const strip = (j: string) => JSON.stringify(JSON.parse(j, (k, v) => (k === 'prompt' ? '<p>' : v)))
    expect(strip(out)).toBe(strip(raw))
    expect(commandLines(enPrompt)).toEqual(commandLines(huPrompt, PRECOMPACT_TRANSLATED))
    expect(commandLines(enPrompt).length).toBeGreaterThanOrEqual(7)
    const p = stripProtocol(enPrompt)
    expect(p.split('\n').filter((l) => HU_ACCENT.test(l))).toEqual([])
    expect(p.match(HU_WORDS)).toBeNull()
  })

  it('ensureAgentHooks writes the English prompt into a new agent\'s settings on an English install', () => {
    mkdirSync(join(tmpRoot, 'templates'), { recursive: true })
    writeFileSync(join(tmpRoot, 'templates', 'settings.json.template'), raw, 'utf-8')
    const scopes = { user: join(tmpRoot, 'scope-user'), project: join(tmpRoot, 'scope-project') }
    for (const [lang, agent] of [['en', 'hooks-en'], [null, 'hooks-hu']] as const) {
      setLang(lang)
      mkdirSync(join(tmpRoot, 'agents', agent, '.claude'), { recursive: true })
      sc.ensureAgentHooks(agent, scopes)
      const written = preCompactPrompt(readFileSync(join(tmpRoot, 'agents', agent, '.claude', 'settings.json'), 'utf-8'))
      if (lang === 'en') expect(written.startsWith('The context is about to be compacted.')).toBe(true)
      else expect(written.startsWith('A kontextus hamarosan tömörítődik.')).toBe(true)
      expect(written).not.toContain('{{PROJECT_ROOT}}')
    }
  })

  it('PreCompact staleness guard: the Hungarian prompt is the one the English twin was written against', () => {
    const digest = createHash('sha256').update(preCompactPrompt(raw)).digest('hex').slice(0, 16)
    expect(HU_SOURCE_HASHES['precompact-prompt'], `precompact-prompt: the Hungarian prompt changed; update PRECOMPACT_PROMPT_EN_TPL, then set the hash to '${digest}'`).toBe(digest)
  })
})

describe('the retired path of the English text (EGM review Major 2): per language, never cross-language', () => {
  it('retiredHookPromptsFor: plain keys are Hungarian, "en:" keys are English, nothing crosses', () => {
    const all = { PreCompact: ['hu-old'], 'en:PreCompact': ['en-old'], _comment: [] as string[] }
    expect(sc.retiredHookPromptsFor(all, 'hu')).toEqual({ PreCompact: ['hu-old'], _comment: [] })
    expect(sc.retiredHookPromptsFor(all, 'en')).toEqual({ PreCompact: ['en-old'] })
  })

  it('an English install: a retired ENGLISH skill section (the English heading\'s list) is upgraded to the current one', () => {
    setLang('en')
    const file = join(tmpRoot, 'agents', SHARED, 'CLAUDE.md')
    const current = sc.buildSkillSection(SHARED, join(tmpRoot, 'store', '.dashboard-token'))
    const old = current.replace('You are a self-improving agent.', 'You are a self-improving agent (old wording).')
    const retiredFile = join(tmpRoot, 'retired-sections-en.json')
    writeFileSync(retiredFile, JSON.stringify({ [en.SKILL_SECTION_HEADING_EN]: [old], '## Öntanulás és Skill rendszer': [] }), 'utf-8')
    writeFileSync(file, `# Sub\n\n${old}\n`, 'utf-8')
    expect(sc.ensureSkillSectionCurrent(SHARED, retiredFile)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toContain('You are a self-improving agent. You learn')
    expect(readFileSync(file, 'utf-8')).not.toContain('(old wording)')
  })

  it('an English install: an agent on a retired HUNGARIAN stock PreCompact prompt keeps it (no switch to English)', () => {
    const raw = readFileSync(REPO_TEMPLATE, 'utf-8')
    mkdirSync(join(tmpRoot, 'templates'), { recursive: true })
    writeFileSync(join(tmpRoot, 'templates', 'settings.json.template'), raw, 'utf-8')
    const retiredRepo = readFileSync(join(__dirname, '..', '..', 'templates', 'retired-hook-prompts.json'), 'utf-8')
    writeFileSync(join(tmpRoot, 'templates', 'retired-hook-prompts.json'), retiredRepo, 'utf-8')
    const oldHu = sc.resolveTemplatePlaceholders((JSON.parse(retiredRepo) as { PreCompact: string[] }).PreCompact[0])
    const scopes = { user: join(tmpRoot, 'scope-user2'), project: join(tmpRoot, 'scope-project2') }
    for (const lang of ['en', null] as const) {
      const agent = `retired-${lang ?? 'hu'}`
      mkdirSync(join(tmpRoot, 'agents', agent, '.claude'), { recursive: true })
      const settings = join(tmpRoot, 'agents', agent, '.claude', 'settings.json')
      writeFileSync(settings, JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: 'agent', prompt: oldHu, timeout: 180 }] }] } }), 'utf-8')
      setLang(lang)
      sc.ensureAgentHooks(agent, scopes)
      const written = preCompactPrompt(readFileSync(settings, 'utf-8'))
      if (lang === 'en') expect(written).toBe(oldHu)
      else expect(written.startsWith('A kontextus hamarosan tömörítődik.') && written !== oldHu).toBe(true)
    }
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
  'fleet-roster': '4849b0f0ec0dab70',
  'skill-section': 'ccb3df74b18e6c8f',
  'claude-md-prompt': '47a4cd6b4097e6be',
  'precompact-prompt': 'ba0d64daf27b1316',
  'mcp-list-channel': 'a7ccf3ed2f0ca342',
  'memory-search-label': '9ddf9811134c353e',
  'message-close': '835ee6c92d6e0a7a',
  'pane-at-escape': '9c49452f3804a26b',
  'skills-path-trap': '76b7632b730c8120',
  'strict-api': 'e619c666af284fec',
  'system-directive-auth': '5f72174ed4de6b5d',
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
