// DOCKERSEEDREFRESH1108 commit 2 (Samu 73384): render_seed_template puts the identity values in LITERALLY. A name the
// owner typed in the wizard may hold a sed metacharacter; with the former `sed s/{{X}}/$name/g` a `&` wrote the
// placeholder back, a `/` broke the expression (an empty .seedtmp left in the task dir), a `\` acted as an escape.
// The wizard rejects only \n \r \0 = in a name (onboarding.ts), so these characters reach .env.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const LIB = join(ROOT, 'scripts', 'lib', 'seed-refresh.sh')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
const SCHED = 'scheduled' + '-tasks'

function render(input: string, id: Record<string, string>): string {
  const assigns = Object.entries(id).map(([k, v]) => `${k}=${JSON.stringify(v).replace(/\$/g, '\\$').replace(/`/g, '\\`')}`).join('\n')
  return execFileSync('bash', ['-c', `set -u\n. ${JSON.stringify(LIB)}\n${assigns}\nrender_seed_template`], { input, encoding: 'utf-8' })
}

const NASTY = ['A & B', 'a/b/c', 'back\\slash', 'pipe|name', 'amp&&slash/\\', 'dollar $HOME', '{{INSTALL_DIR}}', '\\n literal']

describe('render_seed_template substitutes literally', () => {
  for (const name of NASTY) {
    it(`OWNER_NAME and BOT_NAME ${JSON.stringify(name)} come out byte for byte`, () => {
      const out = render('Owner: {{OWNER_NAME}}; bot: {{BOT_NAME}}; dir {{INSTALL_DIR}}\n', { OWNER_NAME: name, BOT_NAME: name, MAIN_AGENT_ID: 'marveen', INSTALL_DIR: '/opt/m' })
      expect(out).toBe(`Owner: ${name}; bot: ${name}; dir /opt/m\n`)
    })
  }

  it('one pass: a value holding a placeholder is not expanded again', () => {
    expect(render('{{BOT_NAME}} {{OWNER_NAME}}\n', { BOT_NAME: '{{OWNER_NAME}}', OWNER_NAME: 'X', INSTALL_DIR: '/i' })).toBe('{{OWNER_NAME}} X\n')
  })

  it('every placeholder, repeated, the PROJECT_ROOT alias, the default port; unknown ones and a lone {{ stay', () => {
    const out = render('{{MAIN_AGENT_ID}}{{MAIN_AGENT_ID}} {{PROJECT_ROOT}} {{WEB_PORT}} {{FOO}} {{ x }} {{\n', { MAIN_AGENT_ID: 'm', INSTALL_DIR: '/i', BOT_NAME: '', OWNER_NAME: '' })
    expect(out).toBe('mm /i 3420 {{FOO}} {{ x }} {{\n')
    expect(render('{{WEB_PORT}}', { WEB_PORT: '3421', INSTALL_DIR: '/i' })).toBe('3421')
  })

  it('the bytes around the placeholders are kept: no final newline, several, CRLF, tabs, UTF-8', () => {
    for (const s of ['no newline {{BOT_NAME}}', 'two\n\n\n', 'crlf {{BOT_NAME}}\r\n', '\ttab {{BOT_NAME}}\t\n', 'ékezet {{BOT_NAME}} őű\n', '']) {
      expect(render(s, { BOT_NAME: 'B', INSTALL_DIR: '/i' })).toBe(s.replaceAll('{{BOT_NAME}}', 'B'))
    }
  })
})

describe('the refresh with such a name (a templated task)', () => {
  function fixture(owner: string) {
    const base = mkdtempSync(join(tmpdir(), 'seed-literal-'))
    const install = join(base, 'install'); const home = join(base, 'home')
    const task = join(install, `seed-${SCHED}`, 'demo-task', 'SKILL.md')
    mkdirSync(join(install, `seed-${SCHED}`, 'demo-task'), { recursive: true })
    mkdirSync(join(home, '.claude', SCHED, 'demo-task'), { recursive: true })
    writeFileSync(join(install, '.env'), `MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=${owner}\nWEB_PORT=3420\n`)
    const g = (...a: string[]) => execFileSync('git', ['-C', install, ...a], { stdio: 'pipe' })
    g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't')
    writeFileSync(task, 'v1 for {{OWNER_NAME}}\n'); g('add', '-A'); g('commit', '-qm', 'v1')
    writeFileSync(task, 'v2 for {{OWNER_NAME}}\n'); g('add', '-A'); g('commit', '-qm', 'v2')
    return { base, install, home, installed: join(home, '.claude', SCHED, 'demo-task', 'SKILL.md') }
  }
  const FNS = (() => {
    const src = UPDATE + '\n' + readFileSync(LIB, 'utf-8')
    const slice = (n: string) => { const a = src.indexOf(`\n${n}() {`); return src.slice(a + 1, src.indexOf('\n}\n', a) + 3) }
    return ['seed_copy_is_untouched', 'seed_tracked_files', 'sched_task_verified_ok', 'register_seeded_schedules', 'run_seed_refresh'].map(slice).join('\n')
  })()
  function refresh(f: { install: string; home: string }): string {
    return execFileSync('bash', ['-c', `set -u\nGREEN=""; NC=""; ORANGE=""\nINSTALL_DIR=${JSON.stringify(f.install)}\n. ${JSON.stringify(LIB)}\n${FNS}\nrun_seed_refresh`],
      { env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf-8' })
  }

  for (const owner of ['Kiss & Társa', 'A/B Kft', 'back\\slash']) {
    it(`OWNER_NAME=${JSON.stringify(owner)}: the untouched literal copy is refreshed to the new literal text, no .seedtmp left`, () => {
      const f = fixture(owner)
      try {
        writeFileSync(f.installed, `v1 for ${owner}\n`)
        refresh(f)
        expect(readFileSync(f.installed, 'utf-8')).toBe(`v2 for ${owner}\n`)
        expect(readdirSync(join(f.home, '.claude', SCHED, 'demo-task'))).toEqual(['SKILL.md'])
      } finally { rmSync(f.base, { recursive: true, force: true }) }
    })
  }

  it('an edited copy with such a name is kept', () => {
    const f = fixture('Kiss & Társa')
    try {
      writeFileSync(f.installed, 'v1 for Kiss & Társa\n# my note\n')
      refresh(f)
      expect(readFileSync(f.installed, 'utf-8')).toBe('v1 for Kiss & Társa\n# my note\n')
    } finally { rmSync(f.base, { recursive: true, force: true }) }
  })
})
