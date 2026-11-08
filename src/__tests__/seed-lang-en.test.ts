import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { seedEnRel, seedSourceFor } from '../web/seed-lang.js'

// PERSONAESC1107 seed A (Samu 72845, 73243): on an English install (AGENT_TEXT_LANG=en) every seeder writes the bytes of
// i18n/en/<rel> for a seeded Markdown file <rel>, when that exists. The mirror tree, not a twin beside the file: the
// update that PULLS this change runs the OLD update.sh (no re-exec), and a twin beside the file would be copied into
// every install under its own name (EGM codebase review B2). Hungarian installs stay byte-for-byte as they were.

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
const UPDATE = read('update.sh')
const MACOS = read('install-macos.sh')
const LINUX = read('install-linux.sh')
const FIRSTBOOT = read('docker/first-boot.sh')
const OLD = read('src/__tests__/fixtures/update-sh-pre-seed-a.sh')

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`\n${name}() {`)
  if (start < 0) throw new Error(`${name}() not found`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start + 1, end + 3)
}

/** A `for <head>` loop at any indent, verbatim to its matching `done`. */
function sliceLoop(src: string, head: string, from = 0): string {
  const lines = src.split('\n')
  let skip = from
  const i = lines.findIndex((l) => l.trim() === head && skip-- === 0)
  if (i < 0) throw new Error(`loop ${head} not found`)
  const indent = lines[i].slice(0, lines[i].indexOf('for'))
  const j = lines.findIndex((l, k) => k > i && l === `${indent}done`)
  return lines.slice(i, j + 1).join('\n')
}

const NEW_FUNCS = ['render_seed_template', 'render_seeded_task_config', 'render_seed_stream', 'seed_copy_is_untouched', 'render_seed_file',
  'seed_en_file', 'seed_copy_is_untouched_any', 'seed_refresh_dir_lang', 'sched_pre_verify_once', 'refresh_one_seed_file',
  'refresh_untouched_seeds', 'run_seed_refresh', 'sched_task_verified_ok', 'sched_task_all_shipped', 'register_refreshed_schedule']
  .map((n) => sliceShellFn(UPDATE, n)).join('\n')

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

const HU1 = {
  'seed-skills/demo/SKILL.md': 'skill hu v1\n',
  'seed-skills/demo/references/r.md': 'ref hu v1\n',
  'seed-scheduled-tasks/task1/SKILL.md': 'task hu v1 {{MAIN_AGENT_ID}}\n',
  'seed-scheduled-tasks/task1/references/ref.md': 'tref hu v1 {{BOT_NAME}}\n',
}
const HU2: Record<string, string> = {
  'seed-skills/demo/SKILL.md': 'skill hu v2\n',
  'seed-skills/demo/references/r.md': 'ref hu v2\n',
  'seed-scheduled-tasks/task1/SKILL.md': 'task hu v2 {{MAIN_AGENT_ID}}\n',
  'seed-scheduled-tasks/task1/references/ref.md': 'tref hu v2 {{BOT_NAME}}\n',
}
const EN2: Record<string, string> = {
  'seed-skills/demo/SKILL.md': 'skill en v2\n',
  'seed-skills/demo/references/r.md': 'ref en v2\n',
  'seed-scheduled-tasks/task1/SKILL.md': 'task en v2 {{MAIN_AGENT_ID}}\n',
  'seed-scheduled-tasks/task1/references/ref.md': 'tref en v2 {{BOT_NAME}}\n',
}
const render = (t: string) => t.replace(/\{\{MAIN_AGENT_ID\}\}/g, 'marveen').replace(/\{\{BOT_NAME\}\}/g, 'Marveen')

/** An install with a two-commit seed history (v1 Hungarian; v2 Hungarian + its English mirror) and a ~/.claude tree. */
function makeInstall(opts: { lang?: 'en' | 'hu'; withI18n?: boolean; helper?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'seedlang-'))
  const install = join(base, 'install')
  const home = join(base, 'home')
  mkdirSync(install, { recursive: true })
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(home, '.claude', 'scheduled-tasks'), { recursive: true })
  writeFileSync(join(install, '.env'), `MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=Owner\nWEB_PORT=3420\n${opts.lang ? `AGENT_TEXT_LANG=${opts.lang}\n` : ''}`)
  if (opts.helper !== false) {
    for (const f of ['seed-lang.sh', 'persona-template.sh']) put(install, `scripts/lib/${f}`, read(`scripts/lib/${f}`))
  }
  git(install, ['init', '-q'])
  git(install, ['config', 'user.email', 'test@example.invalid'])
  git(install, ['config', 'user.name', 'test'])
  for (const [rel, text] of Object.entries(HU1)) put(install, rel, text)
  git(install, ['add', '-A'])
  git(install, ['commit', '-q', '-m', 'v1'])
  for (const [rel, text] of Object.entries(HU2)) put(install, rel, text)
  if (opts.withI18n !== false) for (const [rel, text] of Object.entries(EN2)) put(install, `i18n/en/${rel}`, text)
  git(install, ['add', '-A'])
  git(install, ['commit', '-q', '-m', 'v2'])
  return { base, install, home }
}

/** The installed copy of a seed (rendered for the task, verbatim for the skill). */
const target = (home: string, rel: string) =>
  rel.startsWith('seed-skills/') ? join(home, '.claude', 'skills', rel.slice('seed-skills/'.length))
    : join(home, '.claude', 'scheduled-tasks', rel.slice('seed-scheduled-tasks/'.length))
function seedInstalled(home: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = target(home, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, rel.startsWith('seed-skills/') ? text : render(text))
  }
}
const installedText = (home: string, rel: string) => readFileSync(target(home, rel), 'utf-8')

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(root, p)] = readFileSync(p, 'utf-8')
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

function bash(script: string, file: string): { out: string; code: number } {
  writeFileSync(file, script)
  try {
    return { out: execFileSync('bash', [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { out: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`, code: err.status ?? -1 }
  }
}

const PRELUDE = (install: string, home: string) => [
  'set -u', 'GREEN=""; NC=""; ORANGE=""',
  `INSTALL_DIR="${install}"`, `HOME="${home}"`,
  'MAIN_AGENT_ID=""; BOT_NAME=""; OWNER_NAME=""; WEB_PORT=""; RESEED_FLEET="${RESEED_FLEET:-0}"',
]
// update.sh's own block, verbatim: the helper and the language, read only
const LANG_BLOCK = UPDATE.slice(UPDATE.indexOf('SEED_LANG=hu\nif [ -f "$INSTALL_DIR/scripts/lib/seed-lang.sh" ]'), UPDATE.indexOf('\nrun_seed_refresh\n'))

function refreshNew(install: string, home: string) {
  return bash([...PRELUDE(install, home), NEW_FUNCS, LANG_BLOCK, 'run_seed_refresh'].join('\n') + '\n', join(install, '..', 'probe-new.sh'))
}

describe('the language helper (scripts/lib/seed-lang.sh, src/web/seed-lang.ts)', () => {
  const shell = (install: string, expr: string) =>
    execFileSync('bash', ['-c', `. "${install}/scripts/lib/seed-lang.sh"; ${expr}`], { encoding: 'utf-8' })
  for (const [lang, want] of [['en', 'en'], ['hu', 'hu'], [undefined, 'hu']] as const) {
    it(`AGENT_TEXT_LANG=${lang ?? '(unset)'} -> ${want}, and the shell and TS pick the same file`, () => {
      const f = makeInstall({ lang })
      try {
        expect(shell(f.install, `seed_lang "${f.install}"`)).toBe(want)
        for (const rel of Object.keys(HU2)) {
          const sh = shell(f.install, `seed_src_for "${f.install}" "${rel}" "$(seed_lang "${f.install}")"`)
          const ts = seedSourceFor(f.install, rel, want)
          expect(sh).toBe(ts)
          expect(sh).toBe(want === 'en' ? join(f.install, 'i18n', 'en', rel) : join(f.install, rel))
        }
        // a file with no English version, and a non-Markdown file, read as they are
        expect(shell(f.install, `seed_src_for "${f.install}" "seed-skills/demo/none.md" en`)).toBe(join(f.install, 'seed-skills/demo/none.md'))
        expect(seedEnRel('seed-scheduled-tasks/task1/task-config.json')).toBeNull()
        expect(shell(f.install, 'seed_en_rel "seed-scheduled-tasks/task1/task-config.json"')).toBe('')
      } finally {
        rmSync(f.base, { recursive: true, force: true })
      }
    })
  }
})

describe('the update refresh switches a whole untouched dir to the install language (seed A)', () => {
  it('en: untouched Hungarian copies (one release behind) become the English ones; a second run changes nothing', () => {
    const f = makeInstall({ lang: 'en' })
    try {
      seedInstalled(f.home, HU1)
      const r = refreshNew(f.install, f.home)
      expect(r.code, r.out).toBe(0)
      for (const [rel, text] of Object.entries(EN2)) {
        expect(installedText(f.home, rel)).toBe(rel.startsWith('seed-skills/') ? text : render(text))
      }
      const before = tree(join(f.home, '.claude'))
      const again = refreshNew(f.install, f.home)
      expect(again.code, again.out).toBe(0)
      expect(again.out).not.toMatch(/frissitve: [1-9]/)
      expect(tree(join(f.home, '.claude'))).toEqual(before)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('en: a dir with an edited file keeps its language; its untouched files are refreshed in THAT language', () => {
    const f = makeInstall({ lang: 'en' })
    try {
      seedInstalled(f.home, HU1)
      writeFileSync(target(f.home, 'seed-scheduled-tasks/task1/SKILL.md'), 'my own task text\n')
      expect(refreshNew(f.install, f.home).code).toBe(0)
      expect(installedText(f.home, 'seed-scheduled-tasks/task1/SKILL.md')).toBe('my own task text\n')
      expect(installedText(f.home, 'seed-scheduled-tasks/task1/references/ref.md')).toBe(render(HU2['seed-scheduled-tasks/task1/references/ref.md']))
      // the other dir, all untouched, switches
      expect(installedText(f.home, 'seed-skills/demo/SKILL.md')).toBe(EN2['seed-skills/demo/SKILL.md'])
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('hu: an untouched English copy becomes Hungarian; untouched Hungarian ones are refreshed as before', () => {
    const f = makeInstall({ lang: 'hu' })
    try {
      seedInstalled(f.home, { ...HU1, 'seed-skills/demo/SKILL.md': EN2['seed-skills/demo/SKILL.md'] })
      expect(refreshNew(f.install, f.home).code).toBe(0)
      for (const [rel, text] of Object.entries(HU2)) {
        expect(installedText(f.home, rel)).toBe(rel.startsWith('seed-skills/') ? text : render(text))
      }
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('an install without the key is Hungarian: the result equals a tree without any English version', () => {
    const a = makeInstall({})
    const b = makeInstall({ withI18n: false })
    try {
      seedInstalled(a.home, HU1)
      seedInstalled(b.home, HU1)
      expect(refreshNew(a.install, a.home).code).toBe(0)
      expect(refreshNew(b.install, b.home).code).toBe(0)
      expect(tree(join(a.home, '.claude'))).toEqual(tree(join(b.home, '.claude')))
    } finally {
      rmSync(a.base, { recursive: true, force: true })
      rmSync(b.base, { recursive: true, force: true })
    }
  })

  it('sched_task_all_shipped (the re-register fallback) accepts a dir of the shipped ENGLISH versions, and nothing extra', () => {
    const f = makeInstall({ lang: 'en' })
    try {
      seedInstalled(f.home, Object.fromEntries(Object.entries(EN2).filter(([k]) => k.startsWith('seed-scheduled-tasks/'))))
      const dir = join(f.home, '.claude', 'scheduled-tasks', 'task1')
      const call = [...PRELUDE(f.install, f.home), 'MAIN_AGENT_ID=marveen; BOT_NAME=Marveen; OWNER_NAME=Owner; WEB_PORT=3420', NEW_FUNCS, LANG_BLOCK,
        `sched_task_all_shipped "${dir}" "${f.install}/seed-scheduled-tasks/task1" template && echo SHIPPED || echo NOT`].join('\n') + '\n'
      expect(bash(call, join(f.base, 'p1.sh')).out.trim()).toBe('SHIPPED')
      writeFileSync(join(dir, 'references', 'extra.md'), 'planted\n')
      expect(bash(call, join(f.base, 'p2.sh')).out.trim()).toBe('NOT')
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })
})

describe('the PULL run executes the OLD update.sh: the English tree is invisible to it (Samu 73243)', () => {
  // fixtures/update-sh-pre-seed-a.sh: update.sh's seed functions and initial-seed blocks at 724b356b9, verbatim.
  function runOld(install: string, home: string, reseed: boolean) {
    return bash([...PRELUDE(install, home), `RESEED_FLEET=${reseed ? 1 : 0}`, 'SKILLS_DIR="$HOME/.claude/skills"; SCHED_TARGET_DIR="$HOME/.claude/scheduled-tasks"',
      'MAIN_AGENT_ID=marveen; BOT_NAME=Marveen; OWNER_NAME=Owner', OLD, 'run_seed_refresh'].join('\n') + '\n', join(install, '..', 'probe-old.sh'))
  }
  for (const reseed of [false, true]) {
    it(`a Hungarian install after the old refresh and seed loops${reseed ? ' (--reseed-fleet)' : ''} is byte-identical to one from a tree without i18n/`, () => {
      const a = makeInstall({ lang: 'hu' })
      const b = makeInstall({ lang: 'hu', withI18n: false })
      try {
        for (const f of [a, b]) {
          seedInstalled(f.home, HU1)
          rmSync(target(f.home, 'seed-skills/demo/SKILL.md'), { force: true })   // a missing file, and a missing dir:
          rmSync(join(f.home, '.claude', 'scheduled-tasks', 'task1'), { recursive: true, force: true })
          const r = runOld(f.install, f.home, reseed)
          expect(r.code, r.out).toBe(0)
        }
        const ta = tree(join(a.home, '.claude'))
        expect(ta).toEqual(tree(join(b.home, '.claude')))
        expect(Object.keys(ta).some((k) => k.includes('i18n') || k.includes('.en.'))).toBe(false)
        expect(Object.values(ta).some((v) => / en v2/.test(v))).toBe(false)
      } finally {
        rmSync(a.base, { recursive: true, force: true })
        rmSync(b.base, { recursive: true, force: true })
      }
    })
  }
  it('the English tree lies outside every seed source dir the old loops walk', () => {
    for (const dir of ['seed-skills', 'seed-scheduled-tasks', 'scheduled-tasks', 'templates/scheduled-tasks']) {
      expect(existsSync(join(ROOT, dir, 'i18n'))).toBe(false)
    }
    expect(existsSync(join(ROOT, 'i18n', 'en'))).toBe(true)
  })
})

describe('the initial seed loops pick the English version on en (installers, update.sh)', () => {
  const SKILL_HEAD = 'for skill_dir in "$SEED_SKILLS_DIR"/*/; do'
  const TASK_HEAD = 'for tpl in "$SEED_SCHED_DIR"/*/; do'
  const SCRIPTS: Array<[string, string]> = [['install-macos.sh', MACOS], ['install-linux.sh', LINUX], ['update.sh', UPDATE]]
  for (const [label, src] of SCRIPTS) {
    for (const mode of ['en', 'hu', 'no-helper'] as const) {
      it(`${label}: ${mode}`, () => {
        const f = makeInstall({ lang: mode === 'en' ? 'en' : 'hu', helper: mode !== 'no-helper' })
        try {
          const script = [...PRELUDE(f.install, f.home), 'MAIN_AGENT_ID=marveen; BOT_NAME=Marveen; OWNER_NAME=Owner; WEB_PORT=3420',
            'SKILLS_DIR="$HOME/.claude/skills"; SCHED_TARGET_DIR="$HOME/.claude/scheduled-tasks"',
            'SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"; SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"',
            'SEED_NEW=0; SEED_SKIP=0; SEED_FORCED=0; SCHED_NEW=0; SCHED_SKIP=0; SCHED_FORCED=0; SCHED_TOMBSTONE=/nonexistent',
            mode === 'no-helper' ? '' : LANG_BLOCK,
            sliceLoop(src, SKILL_HEAD), sliceLoop(src, TASK_HEAD)].join('\n') + '\n'
          const r = bash(script, join(f.base, 'seed.sh'))
          expect(r.code, r.out).toBe(0)
          const want = mode === 'en' ? EN2 : HU2
          for (const [rel, text] of Object.entries(want)) {
            expect(installedText(f.home, rel)).toBe(rel.startsWith('seed-skills/') ? text : render(text))
          }
          expect(Object.keys(tree(join(f.home, '.claude'))).some((k) => k.includes('i18n'))).toBe(false)
        } finally {
          rmSync(f.base, { recursive: true, force: true })
        }
      })
    }
  }
})

describe('docker/first-boot.sh', () => {
  it('copy_task reads through seed_src_for; the skills get the English versions over the copy on en only', () => {
    const copyTask = sliceShellFn(FIRSTBOOT, 'copy_task')
    expect(copyTask).toContain('command -v seed_src_for >/dev/null 2>&1 && seed_src="$(seed_src_for "$INSTALL_DIR" "$f" "$SEED_LANG")"')
    expect(copyTask).toContain('"$seed_src" > "$target/$sub$(basename "$f")"')
    expect(FIRSTBOOT).toContain('if [ "$SEED_LANG" = en ] && [ -d "i18n/en/${src%/}" ]; then')
    // read only: the helper is sourced, the language never decided here (the persona render above decides it)
    expect(FIRSTBOOT).toContain('if [ -f scripts/lib/seed-lang.sh ]; then . scripts/lib/seed-lang.sh; SEED_LANG="$(seed_lang "$INSTALL_DIR")"; fi')
  })

  it('runs: copy_task on en and hu, and the skills pass', () => {
    for (const lang of ['en', 'hu'] as const) {
      const f = makeInstall({ lang })
      try {
        copyFileSync(join(f.install, '.env'), join(f.install, '.env.bak'))
        const skillsLoop = FIRSTBOOT.slice(FIRSTBOOT.indexOf('for src in skills/skill-factory seed-skills/*/; do'), FIRSTBOOT.indexOf('\n# The hooks, as update.sh installs them'))
        const script = ['set -u', `INSTALL_DIR="${f.install}"`, `HOME="${f.home}"`, `cd "${f.install}"`, 'say() { :; }',
          'A=marveen; B=Marveen; O=Owner; WEB_PORT=3420; SCHED="$HOME/.claude/scheduled-tasks"; REGISTER=""',
          'SEED_LANG=hu', 'if [ -f scripts/lib/seed-lang.sh ]; then . scripts/lib/seed-lang.sh; SEED_LANG="$(seed_lang "$INSTALL_DIR")"; fi',
          sliceShellFn(FIRSTBOOT, 'copy_task'), 'copy_task seed-scheduled-tasks/task1/ task1', skillsLoop].join('\n') + '\n'
        const r = bash(script, join(f.base, 'fb.sh'))
        expect(r.code, r.out).toBe(0)
        const want = lang === 'en' ? EN2 : HU2
        for (const [rel, text] of Object.entries(want)) {
          expect(installedText(f.home, rel)).toBe(rel.startsWith('seed-skills/') ? text : render(text))
        }
      } finally {
        rmSync(f.base, { recursive: true, force: true })
      }
    }
  })
})

// The shipped English texts (i18n/en): the same skeleton as their Hungarian source, English prose, the contracts kept.
describe('the shipped English seed texts', () => {
  const pairs: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(join(ROOT, d))) {
      const p = join(d, n)
      if (statSync(join(ROOT, p)).isDirectory()) walk(p)
      else if (n.endsWith('.md')) pairs.push(relative('i18n/en', p))
    }
  }
  walk('i18n/en')
  const fences = (s: string) => s.split('\n').filter((l) => l.trimStart().startsWith('```')).length
  const headings = (s: string) => s.split('\n').filter((l) => /^#{1,6} /.test(l)).length
  const front = (s: string, key: string) => (s.match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) ?? [])[1]
  // Where a Hungarian word in an English file is a protocol: the server or a parser uses it (kept on purpose).
  const PROTOCOL_HU = [/\[JÓVÁHAGYÁS KELL\]/g, /cim-kapu \(trigger\)/g, /<a hibás minta>|<kulcsszó>|<rendszer>|<tunet>/g, /GONDOLATJEL-KAPU/g]
  // dream-engine's em-dash gate names the characters it looks for
  const DASH_OK = [/grep -oE '—\|–\|―'/g, /` — ` -> ` -- `/g]

  it('covers the A group (Samu 72774): 10 files', () => {
    expect(pairs.sort()).toEqual([
      'scheduled-tasks/dream-engine/SKILL.md', 'scheduled-tasks/ledger-live-drain/SKILL.md', 'scheduled-tasks/memoria-heartbeat/SKILL.md',
      'scheduled-tasks/reggeli-napindito/SKILL.md', 'seed-scheduled-tasks/kanban-audit/SKILL.md',
      'seed-scheduled-tasks/kanban-audit/references/kanban-audit-buktatok.md', 'seed-scheduled-tasks/kanban-audit/references/kanban-audit-step4b-waiting.md',
      'seed-scheduled-tasks/nap-zaro/SKILL.md', 'seed-skills/approval-request-handling/SKILL.md', 'seed-skills/self-rename/SKILL.md',
    ])
  })

  for (const rel of pairs) {
    it(`${rel}: same skeleton as the Hungarian source, no Hungarian prose, no dash`, () => {
      expect(existsSync(join(ROOT, rel)), 'an English version without its Hungarian source').toBe(true)
      const hu = read(rel)
      const en = read(join('i18n/en', rel))
      expect(headings(en)).toBe(headings(hu))
      expect(fences(en)).toBe(fences(hu))
      expect(front(en, 'name')).toBe(front(hu, 'name'))
      let prose = en
      for (const rx of PROTOCOL_HU) prose = prose.replace(rx, '')
      // identifiers in code spans and blocks (directory names, Hungarian CLI flags) may carry accents; the prose may not
      const outsideCode = prose.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
      expect(outsideCode.match(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g) ?? [], 'Hungarian accents in the English prose').toEqual([])
      let dashes = en
      for (const rx of DASH_OK) dashes = dashes.replace(rx, '')
      expect(dashes.match(/[—–]/g) ?? []).toEqual([])
    })
  }

  it('the morning message names the DREAM.md headings the English dream engine writes', () => {
    const dream = read('i18n/en/scheduled-tasks/dream-engine/SKILL.md')
    const morning = read('i18n/en/scheduled-tasks/reggeli-napindito/SKILL.md')
    for (const h of ['💡 Skill suggestions', '🧹 Memory health', '🎯 Top 3 suggestions for tomorrow', '🌐 External opportunity', '🛠 Skill fleet health']) {
      expect(dream).toContain(`## ${h}`)
      expect(morning).toContain(`\`${h}\``)
    }
  })

  it('kanban-audit: the SKILL points at the step4b labels by their English names, and both report the same way', () => {
    const skill = read('i18n/en/seed-scheduled-tasks/kanban-audit/SKILL.md')
    const step4b = read('i18n/en/seed-scheduled-tasks/kanban-audit/references/kanban-audit-step4b-waiting.md')
    expect(skill).toContain('(CROSSER / NEW ENTRY)')
    expect(step4b).toContain('NEW ENTRY')
    expect(step4b).toContain('CROSSER')
    expect(skill).toContain('Report: examined=N,hits=K,0→notmeasured.')
    expect(step4b).toContain('Report: examined=N,hits=K,0→notmeasured.')
  })
})
