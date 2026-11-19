// DOCKERUX1118 (Samu 80886, 80891): the install language switch's persona part, on the REAL templates rendered by the
// REAL scripts/lib/seed-refresh.sh (render_seed_template), in a temp install. The first-boot files are made the way
// docker/first-boot.sh makes them (render_persona_file, its env); the wizard's name step is renameInPersonaFile's plain
// replace. The seeds' script is a stub here (its own test: lang-switch-seeds.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyNameStep,
  parseSeedReport,
  personaCore,
  switchInstallLanguage,
  type LangSwitchDeps,
  type RunResult,
} from '../web/install-lang-switch.js'

const ROOT = join(__dirname, '..', '..')
let root: string
let env: Record<string, string>
let seedRun: RunResult
let seedCalls: number

function readEnv(key: string): string | null {
  return key in env ? env[key] : null
}
function realRun(file: string, args: readonly string[], e: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { env: e, encoding: 'utf8' }, (err, stdout) => resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : null, stdout }))
  })
}
const deps = (over: Partial<LangSwitchDeps> = {}): LangSwitchDeps => ({
  root,
  dockerDir: join(root, 'docker-dir'),
  home: join(root, 'home'),
  readEnv,
  setEnv: (k, v) => { env[k] = v },
  readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null),
  writeFile: (p, t) => writeFileSync(p, t),
  exists: (p) => existsSync(p),
  run: async (file, args, e) => {
    if (args[0] === '-c') return realRun(file, args, e)
    seedCalls++
    return seedRun
  },
  agentRunning: () => false,
  ...over,
})

/** A persona file as docker/first-boot.sh writes it: render_persona_file with its env, in the language's template. */
function firstBoot(name: 'CLAUDE.md' | 'SOUL.md', lang: 'en' | 'hu'): string {
  const tpl = lang === 'en' ? join(root, 'templates', 'en', `${name}.template`) : join(root, 'templates', `${name}.template`)
  const script = name === 'CLAUDE.md'
    ? '. scripts/lib/seed-refresh.sh; TZV="$(. scripts/lib/install-tz.sh; z="$(install_tz "$INSTALL_DIR")"; printf \'%s\' "${z:-UTC}")"; MAIN_AGENT_ID=marveen RENDER_CHAT_ID=0 RENDER_TIMEZONE="$TZV" render_persona_file "$1" "$2"'
    : '. scripts/lib/seed-refresh.sh; render_persona_file "$1" "$2"'
  execFileSync('bash', ['-c', script, 'fb', tpl, join(root, name)], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', INSTALL_DIR: root, OWNER_NAME: 'Owner', BOT_NAME: 'Marveen', WEB_PORT: '3420' },
  })
  return readFileSync(join(root, name), 'utf-8')
}
/** The wizard's name step: renameInPersonaFile, agent first, then owner (onboarding.ts). */
function nameStep(bot: string, owner: string) {
  for (const name of ['CLAUDE.md', 'SOUL.md']) {
    const f = join(root, name)
    writeFileSync(f, readFileSync(f, 'utf-8').split('Marveen').join(bot).split('Owner').join(owner))
  }
  env.BOT_NAME = bot
  env.OWNER_NAME = owner
}
const read = (name: string) => readFileSync(join(root, name), 'utf-8')
const BLOCK = '<!-- BEGIN GENERATED: evidence-rule (auto-generated, do not edit by hand) -->\nsome rule\n<!-- END GENERATED: evidence-rule -->'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'langsw-'))
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  for (const f of ['seed-refresh.sh', 'install-tz.sh']) cpSync(join(ROOT, 'scripts', 'lib', f), join(root, 'scripts', 'lib', f))
  cpSync(join(ROOT, 'templates', 'CLAUDE.md.template'), join(root, 'templates', 'CLAUDE.md.template'))
  cpSync(join(ROOT, 'templates', 'SOUL.md.template'), join(root, 'templates', 'SOUL.md.template'))
  cpSync(join(ROOT, 'templates', 'en'), join(root, 'templates', 'en'), { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  writeFileSync(join(root, '.lang'), 'en\n')
  env = { MAIN_AGENT_ID: 'marveen', BOT_NAME: 'Marveen', OWNER_NAME: 'Owner', AGENT_TEXT_LANG: 'en', DASHBOARD_LANG: 'en', WEB_PORT: '3420' }
  seedRun = { code: 0, stdout: 'seed updated .claude/skills/alpha/SKILL.md\nseed kept .claude/skills/beta/SKILL.md\nseed current .claude/skills/gamma/SKILL.md\nseed-refresh: shipped skills/tasks refreshed: 1\n' }
  seedCalls = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the persona files', () => {
  it('a fresh en install switched to hu: both files are the hu first-boot render; the keys, .lang and the seeds follow', async () => {
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    const huClaude = firstBoot('CLAUDE.md', 'hu'); const huSoul = firstBoot('SOUL.md', 'hu')
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    const r = await switchInstallLanguage('hu', deps())
    expect(r.ok).toBe(true)
    expect(read('CLAUDE.md')).toBe(huClaude)
    expect(read('SOUL.md')).toBe(huSoul)
    expect([env.AGENT_TEXT_LANG, env.DASHBOARD_LANG, read('.lang')]).toEqual(['hu', 'hu', 'hu\n'])
    expect(r.files).toEqual([
      { file: 'CLAUDE.md', result: 're-rendered' },
      { file: 'SOUL.md', result: 're-rendered' },
      { file: '.claude/skills/alpha/SKILL.md', result: 're-rendered' },
      { file: '.claude/skills/beta/SKILL.md', result: 'kept_customized' },
      { file: '.claude/skills/gamma/SKILL.md', result: 'unchanged' },
    ])
    expect(seedCalls).toBe(1)
  })

  it('only the name step was done: re-rendered, with the names, and a switch back gives the same bytes', async () => {
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    nameStep('Jarvis & Co', 'Kiss Anna')
    const before = { claude: read('CLAUDE.md'), soul: read('SOUL.md') }
    const r = await switchInstallLanguage('hu', deps())
    expect(r.files.slice(0, 2)).toEqual([{ file: 'CLAUDE.md', result: 're-rendered' }, { file: 'SOUL.md', result: 're-rendered' }])
    expect(read('CLAUDE.md')).toContain('Kiss Anna')
    expect(read('CLAUDE.md')).not.toContain('{{')
    expect(read('CLAUDE.md')).not.toBe(before.claude)
    const back = await switchInstallLanguage('en', deps())
    expect(back.files.slice(0, 2)).toEqual([{ file: 'CLAUDE.md', result: 're-rendered' }, { file: 'SOUL.md', result: 're-rendered' }])
    expect(read('CLAUDE.md')).toBe(before.claude)
    expect(read('SOUL.md')).toBe(before.soul)
  })

  it('a fresh install there and back (en -> hu -> en): byte for byte the original', async () => {
    const claude = firstBoot('CLAUDE.md', 'en'); const soul = firstBoot('SOUL.md', 'en')
    await switchInstallLanguage('hu', deps())
    await switchInstallLanguage('en', deps())
    expect(read('CLAUDE.md')).toBe(claude)
    expect(read('SOUL.md')).toBe(soul)
  })

  it.each<[string, (t: string) => string]>([
    ['one byte added in the middle', (t) => t.slice(0, 200) + 'x' + t.slice(200)],
    ['one byte changed', (t) => t.slice(0, 100) + (t[100] === 'a' ? 'b' : 'a') + t.slice(101)],
    ['a line added at the end', (t) => t + 'My own rule.\n'],
  ])('a hand edit (%s): kept_customized, the file untouched, the other file still switched', async (_l, edit) => {
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    writeFileSync(join(root, 'CLAUDE.md'), edit(read('CLAUDE.md')))
    const edited = read('CLAUDE.md')
    const r = await switchInstallLanguage('hu', deps())
    expect(r.files.slice(0, 2)).toEqual([{ file: 'CLAUDE.md', result: 'kept_customized' }, { file: 'SOUL.md', result: 're-rendered' }])
    expect(read('CLAUDE.md')).toBe(edited)
  })

  it('only a generated block differs (the dashboard added one): re-rendered, the block goes', async () => {
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    const huClaude = (() => { const c = firstBoot('CLAUDE.md', 'hu'); firstBoot('CLAUDE.md', 'en'); return c })()
    writeFileSync(join(root, 'CLAUDE.md'), read('CLAUDE.md').trimEnd() + '\n\n' + BLOCK + '\n')
    const r = await switchInstallLanguage('hu', deps())
    expect(r.files[0]).toEqual({ file: 'CLAUDE.md', result: 're-rendered' })
    expect(read('CLAUDE.md')).toBe(huClaude)
  })

  it('the same language: no file is rendered, the seeds are not run, a lost DASHBOARD_LANG comes back', async () => {
    const claude = firstBoot('CLAUDE.md', 'en')
    delete env.DASHBOARD_LANG
    const r = await switchInstallLanguage('en', deps())
    expect(r).toEqual({ ok: true, lang: 'en', previous: 'en', files: [] })
    expect(env.DASHBOARD_LANG).toBe('en')
    expect(read('CLAUDE.md')).toBe(claude)
    expect(seedCalls).toBe(0)
  })

  it('a render that fails writes nothing at all (no key, no file, no seeds)', async () => {
    const claude = firstBoot('CLAUDE.md', 'en')
    rmSync(join(root, 'scripts', 'lib', 'seed-refresh.sh'))
    const r = await switchInstallLanguage('hu', deps())
    expect(r).toMatchObject({ ok: false, error: 'render_failed' })
    expect([env.AGENT_TEXT_LANG, env.DASHBOARD_LANG, read('.lang'), read('CLAUDE.md')]).toEqual(['en', 'en', 'en\n', claude])
    expect(seedCalls).toBe(0)
  })

  it('a seed refresh that does not finish is reported; the persona part stays switched', async () => {
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    seedRun = { code: 1, stdout: 'seed updated .claude/skills/alpha/SKILL.md\n' }
    const r = await switchInstallLanguage('hu', deps())
    expect(r).toMatchObject({ ok: false, error: 'seed_refresh_failed' })
    expect(r.files.map((f) => f.result)).toEqual(['re-rendered', 're-rendered', 're-rendered'])
    expect(env.AGENT_TEXT_LANG).toBe('hu')
  })

  // Dani 80955 n2: the main agent started between the route's check and the writes (the wizard's launch, another window).
  it('the main agent runs by the time of the first write: agent_running, and nothing is written at all', async () => {
    const claude = firstBoot('CLAUDE.md', 'en'); const soul = firstBoot('SOUL.md', 'en')
    let asked = 0
    const r = await switchInstallLanguage('hu', deps({ agentRunning: () => { asked++; return true } }))
    expect(r).toEqual({ ok: false, error: 'agent_running', lang: 'hu', files: [] })
    expect(asked).toBe(1)
    expect([env.AGENT_TEXT_LANG, env.DASHBOARD_LANG, read('.lang'), read('CLAUDE.md'), read('SOUL.md')]).toEqual(['en', 'en', 'en\n', claude, soul])
    expect(seedCalls).toBe(0)
  })

  it('the second check comes after the renders, right before the first write', async () => {
    firstBoot('CLAUDE.md', 'en'); firstBoot('SOUL.md', 'en')
    const order: string[] = []
    await switchInstallLanguage('hu', deps({
      agentRunning: () => { order.push('check'); return false },
      setEnv: (k, v) => { order.push('write'); env[k] = v },
      run: async (file, args, e) => { order.push(args[0] === '-c' ? 'render' : 'seeds'); return args[0] === '-c' ? realRun(file, args, e) : seedRun },
    }))
    expect(order.indexOf('check')).toBe(order.lastIndexOf('render') + 1)
    expect(order[order.indexOf('check') + 1]).toBe('write')
  })

  it('a missing persona file is left missing', async () => {
    const r = await switchInstallLanguage('hu', deps())
    expect(r.files.slice(0, 2)).toEqual([{ file: 'CLAUDE.md', result: 'unchanged' }, { file: 'SOUL.md', result: 'unchanged' }])
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
  })
})

describe('the helpers', () => {
  it('personaCore cuts every generated block and the posture block, with the blank lines before them', () => {
    const posture = '<!-- BEGIN PER-INSTALL POSTURE (from store/egress-allowlist.json) -->\nx\n<!-- END PER-INSTALL POSTURE -->'
    expect(personaCore('# Me\ntext\n\n' + BLOCK + '\n\n' + posture + '\n')).toBe('# Me\ntext')
    expect(personaCore('# Me\ntext\n')).toBe('# Me\ntext')
    // an unclosed block is not a block: the text stays (and then is not equal to a render: kept)
    expect(personaCore('# Me\n<!-- BEGIN GENERATED: x -->\nno end\n')).toBe('# Me\n<!-- BEGIN GENERATED: x -->\nno end')
  })

  it('applyNameStep is the name step on first-boot names only', () => {
    expect(applyNameStep('Marveen serves Owner. marveen', 'Jarvis', 'Anna')).toBe('Jarvis serves Anna. marveen')
    expect(applyNameStep('Marveen serves Owner.', 'Marveen', 'Owner')).toBe('Marveen serves Owner.')
  })

  it('parseSeedReport maps the four outcomes and skips every other line', () => {
    expect(parseSeedReport('seed updated a\nseed kept b c\nseed current d\nseed added e\nseed-refresh: x\nseed weird f\n')).toEqual([
      { file: 'a', result: 're-rendered' },
      { file: 'b c', result: 'kept_customized' },
      { file: 'd', result: 'unchanged' },
      { file: 'e', result: 'added' },
    ])
  })
})
