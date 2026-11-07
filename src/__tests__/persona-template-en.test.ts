// PERSONAEN1107 (HOSTINGERDOCKER1107, Samu 72702): the English persona templates are a faithful translation of the
// Hungarian ones. Every recipe the other template tests pin lives in a code fence or an inline code span, so those are
// byte-identical here, and so are the placeholders and the heading structure. The installers and update.sh pick the
// template by the install's language through scripts/lib/persona-template.sh; Hungarian stays the default.
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const PAIRS = [
  ['templates/CLAUDE.md.template', 'templates/en/CLAUDE.md.template'],
  ['templates/SOUL.md.template', 'templates/en/SOUL.md.template'],
] as const

// PERSONAESC1107 (Marveen 72742): the spans translated ON PURPOSE (no code reads them; the owner and the agent do).
// Each English text must be in the English template once, its Hungarian original in the Hungarian one once; the parity
// below compares the English template with these put back, so every other byte of code still has to match.
const INTENDED: ReadonlyArray<readonly [string, string, string]> = [
  ['templates/en/CLAUDE.md.template',
    "`Egy sub-ágenshez ismeretlen, NEM párosított sender [ID] írt: '...'. Jóváhagyod?`",
    "`An unknown, NOT paired sender [ID] wrote to a sub-agent: '...'. Do you approve?`"],
  ['templates/en/CLAUDE.md.template',
    '   # A SAJÁT csatornád configja a munkakönyvtáradban van (<cwd>/.claude/channels/...: a Főnöknél a projekt gyökere, sub-ágensnél az agents/<név> mappa).',
    "   # YOUR OWN channel's config is in your working directory (<cwd>/.claude/channels/...: the project root for the main agent, the agents/<name> folder for a sub-agent)."],
  ['templates/en/CLAUDE.md.template',
    '   # A $HOME/.claude/channels csak tartalék: Marveen-telepítésben ott nincs ilyen fájl, ezért a vak $HOME-olvasás hamis "NEM"-et vagy hibát ad.',
    '   # $HOME/.claude/channels is only a fallback: a Marveen install has no such file there, so a blind $HOME read gives a false "NEM" (no) or an error.'],
]
const restored = (en: string, E: string) =>
  INTENDED.filter(([f]) => f === en).reduce((acc, [, hu, eng]) => acc.split(eng).join(hu), E)

// Indented fences too (a code block inside a list item): the first version matched only column-0 fences.
const fences = (s: string) => s.match(/^[ \t]*```[\s\S]*?^[ \t]*```/gm) ?? []
const withoutFences = (s: string) => s.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '')
const inline = (s: string) => withoutFences(s).match(/`[^`\n]+`/g) ?? []
const placeholders = (s: string) => (s.match(/\{\{[A-Z_]+\}\}/g) ?? []).sort()
const headings = (s: string) => (withoutFences(s).match(/^#{1,6} /gm) ?? []).map((h) => h.trim())

describe('the English persona templates', () => {
  for (const [hu, en] of PAIRS) {
    it(`${en}: the code fences, the inline code, the placeholders and the headings match ${hu}`, () => {
      const H = read(hu), E = restored(en, read(en))
      expect(fences(E)).toEqual(fences(H))
      expect(inline(E)).toEqual(inline(H))
      expect(placeholders(E)).toEqual(placeholders(H))
      expect(headings(E)).toEqual(headings(H))
      expect(E.split('\n').length).toBe(H.split('\n').length)
    })

    it(`${en}: every intentionally translated span is there once, its Hungarian original once in ${hu}`, () => {
      for (const [f, huText, enText] of INTENDED.filter(([f]) => f === en)) {
        expect(read(f).split(enText).length - 1, enText).toBe(1)
        expect(read(f), enText).not.toContain(huText)
        expect(read(hu).split(huText).length - 1, huText).toBe(1)
      }
    })

    it(`${en}: no em or en dash, and the language line names the owner's language`, () => {
      const E = read(en)
      expect(E).not.toMatch(/[\u2013\u2014]/)
      expect(E).not.toMatch(/magyarul/)
      expect(E).toContain("the owner's language (English by default on an English install)")
    })
  }
})

describe('persona_template and the once-decided AGENT_TEXT_LANG (scripts/lib/persona-template.sh)', () => {
  // PERSONAESC1107 (Samu 72762 (b)): the language is decided at the FIRST render (no CLAUDE.md yet) and kept in .env;
  // every later render only reads it. An install without the key is Hungarian.
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  type Opts = { lang?: string; dotLang?: string; en?: boolean; env?: string; claudeMd?: boolean }
  function setup(name: string, opts: Opts) {
    dir = mkdtempSync(join(tmpdir(), 'geri-persona-'))
    mkdirSync(join(dir, 'templates', 'en'), { recursive: true })
    for (const n of new Set([name, 'CLAUDE.md.template'])) {
      writeFileSync(join(dir, 'templates', n), 'hu')
      if (opts.en !== false) writeFileSync(join(dir, 'templates', 'en', n), 'en')
    }
    if (opts.dotLang !== undefined) writeFileSync(join(dir, '.lang'), opts.dotLang)
    if (opts.env !== undefined) writeFileSync(join(dir, '.env'), opts.env)
    if (opts.claudeMd) writeFileSync(join(dir, 'CLAUDE.md'), 'existing')
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
    if (opts.lang !== undefined) env.MARVEEN_LANG = opts.lang
    return env
  }
  function run(script: string, env: Record<string, string>, ...args: string[]) {
    const r = spawnSync('bash', ['-c', `. "$1"; shift; ${script}`, '_', join(ROOT, 'scripts/lib/persona-template.sh'), ...args], { env, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.split(dir).join('<dir>')
  }
  const pick = (name: string, opts: Opts, mode = '') => run(`persona_template "$1" "$2" ${mode}`, setup(name, opts), dir, name)
  const envFile = () => { try { return readFileSync(join(dir, '.env'), 'utf8') } catch { return null } }

  it('first render (decide, no CLAUDE.md): English from MARVEEN_LANG or the .lang, and the key is written', () => {
    expect(pick('CLAUDE.md.template', { lang: 'en', env: 'A=1\n' }, 'decide')).toBe('<dir>/templates/en/CLAUDE.md.template')
    expect(envFile()).toBe('A=1\nAGENT_TEXT_LANG=en\n')
    expect(pick('SOUL.md.template', { dotLang: 'en\n', env: '' }, 'decide')).toBe('<dir>/templates/en/SOUL.md.template')
    expect(envFile()).toBe('AGENT_TEXT_LANG=en\n')
  })

  it('first render: Hungarian (and the key hu) by default, for another language, without the English file; MARVEEN_LANG wins', () => {
    for (const o of [{}, { lang: 'hu' }, { lang: 'de' }, { lang: 'EN' }, { lang: 'en', en: false }, { lang: 'hu', dotLang: 'en' }] as Opts[]) {
      expect(pick('CLAUDE.md.template', { ...o, env: 'A=1' }, 'decide'), JSON.stringify(o)).toBe('<dir>/templates/CLAUDE.md.template')
      expect(envFile(), JSON.stringify(o)).toBe('A=1\nAGENT_TEXT_LANG=hu\n')
    }
  })

  it('the key decides every later render; nothing more is written', () => {
    expect(pick('CLAUDE.md.template', { lang: 'hu', env: 'AGENT_TEXT_LANG=en\n' }, 'decide')).toBe('<dir>/templates/en/CLAUDE.md.template')
    expect(envFile()).toBe('AGENT_TEXT_LANG=en\n')
    expect(pick('CLAUDE.md.template', { lang: 'en', env: 'AGENT_TEXT_LANG=hu\n' }, 'decide')).toBe('<dir>/templates/CLAUDE.md.template')
  })

  it('an existing install (CLAUDE.md there) without the key stays Hungarian, and nothing is written, even with .lang=en', () => {
    expect(pick('CLAUDE.md.template', { lang: 'en', dotLang: 'en', env: 'A=1\n', claudeMd: true }, 'decide')).toBe('<dir>/templates/CLAUDE.md.template')
    expect(envFile()).toBe('A=1\n')
  })

  it('read only (update.sh): the key, else Hungarian; MARVEEN_LANG and .lang are not looked at, nothing is written', () => {
    expect(pick('CLAUDE.md.template', { env: 'AGENT_TEXT_LANG=en\n' })).toBe('<dir>/templates/en/CLAUDE.md.template')
    expect(pick('CLAUDE.md.template', { lang: 'en', dotLang: 'en', env: 'A=1\n' })).toBe('<dir>/templates/CLAUDE.md.template')
    expect(envFile()).toBe('A=1\n')
  })

  it('as the installers call it: the substitution runs before the redirect creates CLAUDE.md, so a fresh install decides', () => {
    const env = setup('CLAUDE.md.template', { lang: 'en', env: '' })
    run('sed -e "" "$(persona_template "$1" CLAUDE.md.template decide)" > "$1/CLAUDE.md"', env, dir)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('en')
    expect(envFile()).toBe('AGENT_TEXT_LANG=en\n')
  })
})

describe('the installers and update.sh render the persona through it', () => {
  const CALL = (name: string, mode = '') => `"$(. "$INSTALL_DIR/scripts/lib/persona-template.sh"; persona_template "$INSTALL_DIR" ${name}${mode})"`
  it('install-linux.sh and install-macos.sh: CLAUDE.md and SOUL.md', () => {
    for (const f of ['install-linux.sh', 'install-macos.sh']) {
      const s = read(f)
      expect(s, f).toContain(CALL('CLAUDE.md.template', ' decide'))
      expect(s, f).toContain(CALL('SOUL.md.template', ' decide'))
      expect(s, f).not.toMatch(/"\$INSTALL_DIR\/templates\/(CLAUDE|SOUL)\.md\.template" *>/)
    }
  })
  it('update.sh --regen-claudemd: CLAUDE.md, read only (it never decides the language)', () => {
    const s = read('update.sh')
    expect(s).toContain(CALL('CLAUDE.md.template') + ' > "$CLAUDE_MD"')
  })
})
