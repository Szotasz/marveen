// PERSONARENDERLITERAL1108 (Dani 73463, Samu 73467): the CLAUDE.md / SOUL.md renders (both installers, update.sh
// --regen-claudemd, the Docker first boot) were `sed s/{{OWNER_NAME}}/$OWNER_NAME/g ... > CLAUDE.md`: the redirect
// truncated the target BEFORE sed ran, so a / in the owner's or the bot's name (sed: bad flag) left an EMPTY CLAUDE.md,
// the main agent's instructions. Now every path renders through scripts/lib/seed-refresh.sh render_persona_file: the
// literal render_seed_template, into a temp file that replaces the target only on success. Each path is run with its
// real text, on the real templates.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
const LIB = join(ROOT, 'scripts', 'lib', 'seed-refresh.sh')
// /, &, \ and a newline in both names (the wizard and the installers let them through to .env / the prompt)
const OWNER = 'Kiss & Társa/Kft \\ x\nsecond line'
const BOT = 'B&B/2 \\n'
const TZ = 'Europe/Budapest'
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function lit(tpl: string, v: Record<string, string>): string {
  let out = tpl
  for (const [k, val] of Object.entries(v)) out = out.split(`{{${k}}}`).join(val)
  return out
}
function install() {
  const base = mkdtempSync(join(tmpdir(), 'persona-literal-'))
  const dir = join(base, 'install')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true })
  cpSync(join(ROOT, 'templates'), join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, '.env'), `CHAT_ID=4242\nSCHEDULER_TZ=${TZ}\n`)
  return { base, dir }
}
function bash(script: string, cwd: string): { code: number; out: string } {
  const r = spawnSync('bash', ['-c', script], { cwd, encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8' } })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const between = (src: string, a: string, b: string) => {
  const i = src.indexOf(a); const j = src.indexOf(b, i)
  if (i < 0 || j < 0) throw new Error(`slice ${a} .. ${b} not found`)
  return src.slice(i, j)
}
const tempLeft = (dir: string) => readdirSync(dir).filter((f) => f.includes('.render.'))

const HU_CLAUDE = read('templates/CLAUDE.md.template')
const HU_SOUL = read('templates/SOUL.md.template')

describe('render_persona_file', () => {
  it('renders the real CLAUDE.md template literally with /, &, \\ and a newline in both names', () => {
    const f = install()
    try {
      const r = bash([`. ${q(LIB)}`, `OWNER_NAME=${q(OWNER)}; BOT_NAME=${q(BOT)}; MAIN_AGENT_ID=marveen; INSTALL_DIR=${q(f.dir)}; WEB_PORT=3421`,
        `RENDER_CHAT_ID=4242 RENDER_TIMEZONE=${TZ} render_persona_file templates/CLAUDE.md.template CLAUDE.md; echo rc=$?`].join('\n'), f.dir)
      expect(r.out).toBe('rc=0\n')
      expect(readFileSync(join(f.dir, 'CLAUDE.md'), 'utf-8')).toBe(lit(HU_CLAUDE,
        { OWNER_NAME: OWNER, BOT_NAME: BOT, MAIN_AGENT_ID: 'marveen', INSTALL_DIR: f.dir, WEB_PORT: '3421', CHAT_ID: '4242', TIMEZONE: TZ }))
      expect(tempLeft(f.dir)).toEqual([])
    } finally { rmSync(f.base, { recursive: true, force: true }) }
  })

  it('a render that fails (unreadable or empty template) keeps the old file, removes its temp file, returns 1', () => {
    const f = install()
    try {
      writeFileSync(join(f.dir, 'CLAUDE.md'), 'OLD instructions\n')
      writeFileSync(join(f.dir, 'empty.tpl'), '')
      const r = bash([`. ${q(LIB)}`, `INSTALL_DIR=${q(f.dir)}`,
        'render_persona_file templates/missing.template CLAUDE.md; echo "missing rc=$?"', 'render_persona_file empty.tpl CLAUDE.md; echo "empty rc=$?"'].join('\n'), f.dir)
      expect(r.out).toContain('missing rc=1\n')
      expect(r.out).toContain('empty rc=1\n')
      expect(readFileSync(join(f.dir, 'CLAUDE.md'), 'utf-8')).toBe('OLD instructions\n')
      expect(tempLeft(f.dir)).toEqual([])
    } finally { rmSync(f.base, { recursive: true, force: true }) }
  })

  it('without RENDER_CHAT_ID / RENDER_TIMEZONE the seed render keeps those two placeholders as before', () => {
    const r = bash(`. ${q(LIB)}\nINSTALL_DIR=/i; printf '{{CHAT_ID}} {{TIMEZONE}}' | render_seed_template`, tmpdir())
    expect(r.out).toBe('{{CHAT_ID}} {{TIMEZONE}}')
  })
})

// Each path, its real text, the real templates; the shared prelude gives what the script has set by then.
const PATHS: Array<{ name: string; block: () => string; prelude: (d: string) => string; chat: string; soul: boolean }> = [
  { name: 'install-linux.sh', soul: true, chat: '4242',
    block: () => between(read('install-linux.sh'), '# SEEDRENDERLITERAL1108 / PERSONARENDERLITERAL1108', '\n# Default scheduled tasks scaffoldolasa'),
    prelude: () => 'ok() { echo "ok: $*"; }; warn() { echo "warn: $*"; }; fail() { echo "FAIL: $*"; exit 1; }; CHAT_ID=4242' },
  { name: 'install-macos.sh', soul: true, chat: '4242',
    block: () => between(read('install-macos.sh'), '# SEEDRENDERLITERAL1108 / PERSONARENDERLITERAL1108', '\n# Scaffold default scheduled tasks'),
    prelude: () => 'GREEN=""; NC=""; ORANGE=""; _t() { printf \'%s\' "$1"; }; fail() { echo "FAIL: $*"; exit 1; }; CHAT_ID=4242' },
  { name: 'update.sh --regen-claudemd', soul: false, chat: '4242',
    block: () => between(read('update.sh'), '  if [ "$REGEN_CLAUDEMD" = "1" ] && [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then', '\n  elif [ -f "$CLAUDE_MD" ]; then') + '\n  fi\n',
    prelude: (d) => `GREEN=""; NC=""; RED=""; REGEN_CLAUDEMD=1; CLAUDE_MD=${q(join(d, 'CLAUDE.md'))}; . ${q(LIB)}` },
  { name: 'docker/first-boot.sh', soul: true, chat: '0',
    block: () => between(read('docker/first-boot.sh'), '# DOCKERSEEDREFRESH1108 / PERSONARENDERLITERAL1108', '\n# PERSONAESC1107 seed A: the seeds'),
    prelude: () => 'say() { echo "first-boot: $*"; }; AGENT_ID=marveen' },
]

describe('every persona render path writes the names literally and never leaves CLAUDE.md empty', () => {
  for (const p of PATHS) {
    it(`${p.name}: /, &, \\ and a newline in the owner's and the bot's name`, () => {
      const f = install()
      try {
        const script = ['set -u', `cd ${q(f.dir)}`, `INSTALL_DIR=${q(f.dir)}`, `OWNER_NAME=${q(OWNER)}; BOT_NAME=${q(BOT)}; MAIN_AGENT_ID=marveen; WEB_PORT=3421`,
          p.prelude(f.dir), p.block(), 'echo "end rc=$?"'].join('\n')
        const r = bash(script, f.dir)
        expect(r.out, r.out).toContain('end rc=0')
        expect(readFileSync(join(f.dir, 'CLAUDE.md'), 'utf-8')).toBe(lit(HU_CLAUDE,
          { OWNER_NAME: OWNER, BOT_NAME: BOT, MAIN_AGENT_ID: 'marveen', INSTALL_DIR: f.dir, WEB_PORT: '3421', CHAT_ID: p.chat, TIMEZONE: TZ }))
        if (p.soul) expect(readFileSync(join(f.dir, 'SOUL.md'), 'utf-8')).toBe(lit(HU_SOUL, { OWNER_NAME: OWNER, BOT_NAME: BOT }))
        expect(tempLeft(f.dir)).toEqual([])
      } finally { rmSync(f.base, { recursive: true, force: true }) }
    })

    it(`${p.name}: a render that fails is loud and leaves no empty CLAUDE.md`, () => {
      const f = install()
      try {
        if (p.name.startsWith('update.sh')) writeFileSync(join(f.dir, 'CLAUDE.md'), 'OLD instructions\n')
        chmodSync(join(f.dir, 'templates', 'CLAUDE.md.template'), 0o000)
        const script = ['set -u', `cd ${q(f.dir)}`, `INSTALL_DIR=${q(f.dir)}`, `OWNER_NAME=${q(OWNER)}; BOT_NAME=${q(BOT)}; MAIN_AGENT_ID=marveen; WEB_PORT=3421`,
          p.prelude(f.dir), p.block(), 'echo "end rc=$?"'].join('\n')
        const r = bash(script, f.dir)
        chmodSync(join(f.dir, 'templates', 'CLAUDE.md.template'), 0o644)
        expect(r.out).toMatch(/could not be rendered|nem renderelhető/)
        if (p.name.startsWith('update.sh')) expect(readFileSync(join(f.dir, 'CLAUDE.md'), 'utf-8')).toBe('OLD instructions\n')
        else expect(existsSync(join(f.dir, 'CLAUDE.md'))).toBe(false)
        expect(tempLeft(f.dir)).toEqual([])
      } finally { rmSync(f.base, { recursive: true, force: true }) }
    })
  }

  it('no persona render keeps a sed of the identity', () => {
    for (const p of PATHS) expect(p.block(), p.name).not.toMatch(/s\/\{\{(OWNER_NAME|BOT_NAME|MAIN_AGENT_ID|CHAT_ID)\}\}/)
  })
})
