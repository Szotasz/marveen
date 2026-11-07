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

describe('persona_template (scripts/lib/persona-template.sh)', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  function pick(name: string, opts: { lang?: string; dotLang?: string; en?: boolean }) {
    dir = mkdtempSync(join(tmpdir(), 'geri-persona-'))
    mkdirSync(join(dir, 'templates', 'en'), { recursive: true })
    writeFileSync(join(dir, 'templates', name), 'hu')
    if (opts.en !== false) writeFileSync(join(dir, 'templates', 'en', name), 'en')
    if (opts.dotLang !== undefined) writeFileSync(join(dir, '.lang'), opts.dotLang)
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
    if (opts.lang !== undefined) env.MARVEEN_LANG = opts.lang
    const r = spawnSync('bash', ['-c', `. "$1"; persona_template "$2" "$3"`, '_', join(ROOT, 'scripts/lib/persona-template.sh'), dir, name], { env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    return r.stdout.replace(dir, '<dir>')
  }

  it('English when MARVEEN_LANG=en, or when the .lang says en', () => {
    expect(pick('CLAUDE.md.template', { lang: 'en' })).toBe('<dir>/templates/en/CLAUDE.md.template')
    expect(pick('SOUL.md.template', { dotLang: 'en\n' })).toBe('<dir>/templates/en/SOUL.md.template')
  })

  it('Hungarian by default, for any other language, and when the English file is missing', () => {
    expect(pick('CLAUDE.md.template', {})).toBe('<dir>/templates/CLAUDE.md.template')
    expect(pick('CLAUDE.md.template', { lang: 'hu' })).toBe('<dir>/templates/CLAUDE.md.template')
    expect(pick('CLAUDE.md.template', { lang: 'de' })).toBe('<dir>/templates/CLAUDE.md.template')
    expect(pick('CLAUDE.md.template', { lang: 'en', en: false })).toBe('<dir>/templates/CLAUDE.md.template')
  })

  it('MARVEEN_LANG wins over the .lang', () => {
    expect(pick('CLAUDE.md.template', { lang: 'hu', dotLang: 'en' })).toBe('<dir>/templates/CLAUDE.md.template')
  })
})

describe('the installers and update.sh render the persona through it', () => {
  const CALL = (name: string) => `"$(. "$INSTALL_DIR/scripts/lib/persona-template.sh"; persona_template "$INSTALL_DIR" ${name})"`
  it('install-linux.sh and install-macos.sh: CLAUDE.md and SOUL.md', () => {
    for (const f of ['install-linux.sh', 'install-macos.sh']) {
      const s = read(f)
      expect(s, f).toContain(CALL('CLAUDE.md.template'))
      expect(s, f).toContain(CALL('SOUL.md.template'))
      expect(s, f).not.toMatch(/"\$INSTALL_DIR\/templates\/(CLAUDE|SOUL)\.md\.template" *>/)
    }
  })
  it('update.sh --regen-claudemd: CLAUDE.md', () => {
    const s = read('update.sh')
    expect(s).toContain(CALL('CLAUDE.md.template') + ' > "$CLAUDE_MD"')
  })
})
