// DOCKERUX1118 (Samu 80891): the seeds' part of the install language switch (docker/lang-switch-seeds.sh, the image
// update's seed refresh with the install's new language), and the report hook it uses in scripts/lib/seed-refresh.sh.
// The REAL scripts run in a temp install with the repo's docker/ seams; no Docker needed.
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const LIB = readFileSync(join(ROOT, 'scripts', 'lib', 'seed-refresh.sh'), 'utf-8')

let base: string | null = null
afterEach(() => {
  if (base !== null) rmSync(base, { recursive: true, force: true })
  base = null
})

function put(dir: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body) }
}
/** An en install whose skills were seeded in Hungarian: alpha untouched, beta edited, gamma has no English version. */
function install(lib = LIB) {
  base = mkdtempSync(join(tmpdir(), 'lsseeds-'))
  const inst = join(base, 'opt-marveen'); const home = join(base, 'home')
  mkdirSync(join(inst, 'scripts', 'lib'), { recursive: true })
  for (const f of ['seed-lang.sh', 'persona-template.sh']) cpSync(join(ROOT, 'scripts', 'lib', f), join(inst, 'scripts', 'lib', f))
  writeFileSync(join(inst, 'scripts', 'lib', 'seed-refresh.sh'), lib)
  put(inst, {
    'seed-skills/alpha/SKILL.md': 'alpha hu\n', 'i18n/en/seed-skills/alpha/SKILL.md': 'alpha en\n',
    'seed-skills/beta/SKILL.md': 'beta hu\n', 'i18n/en/seed-skills/beta/SKILL.md': 'beta en\n',
    'seed-skills/gamma/SKILL.md': 'gamma\n',
    '.env': 'MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=Owner\nAGENT_TEXT_LANG=en\n',
  })
  put(home, {
    '.claude/skills/alpha/SKILL.md': 'alpha hu\n',
    '.claude/skills/beta/SKILL.md': 'beta hu\n# my note\n',
    '.claude/skills/gamma/SKILL.md': 'gamma\n',
  })
  return { inst, home }
}
const ENV = (inst: string, home: string) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, MARVEEN_INSTALL_DIR: inst, MARVEEN_DOCKER_DIR: join(ROOT, 'docker') })
const skill = (home: string, n: string) => readFileSync(join(home, '.claude', 'skills', n, 'SKILL.md'), 'utf-8')

describe('docker/lang-switch-seeds.sh', () => {
  it('an untouched copy follows the new language, an edited one is kept, one line per file; the snapshot dir is gone', () => {
    const { inst, home } = install()
    const r = spawnSync('bash', [join(ROOT, 'docker', 'lang-switch-seeds.sh')], { env: ENV(inst, home), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('seed ')).sort()
    expect(lines).toEqual([
      'seed current .claude/skills/gamma/SKILL.md',
      'seed kept .claude/skills/beta/SKILL.md',
      'seed updated .claude/skills/alpha/SKILL.md',
    ])
    expect([skill(home, 'alpha'), skill(home, 'beta'), skill(home, 'gamma')]).toEqual(['alpha en\n', 'beta hu\n# my note\n', 'gamma\n'])
    expect(existsSync(join(inst, '.seed-prev'))).toBe(false)
  })

  it('back to hu: the copy it wrote in English follows again', () => {
    const { inst, home } = install()
    spawnSync('bash', [join(ROOT, 'docker', 'lang-switch-seeds.sh')], { env: ENV(inst, home), encoding: 'utf-8' })
    writeFileSync(join(inst, '.env'), readFileSync(join(inst, '.env'), 'utf-8').replace('AGENT_TEXT_LANG=en', 'AGENT_TEXT_LANG=hu'))
    const r = spawnSync('bash', [join(ROOT, 'docker', 'lang-switch-seeds.sh')], { env: ENV(inst, home), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('seed updated .claude/skills/alpha/SKILL.md')
    expect(skill(home, 'alpha')).toBe('alpha hu\n')
  })
})

describe('the report hook in scripts/lib/seed-refresh.sh', () => {
  // The lib as it was before the hook: the hook's definition and its four calls taken out.
  const withoutHook = LIB
    .replace(/# DOCKERUX1118: the per-file report hook\.[\s\S]*?\n_seed_report\(\) \{[\s\S]*?\n\}\n\n/, '')
    .replace('if [ "$want" = "$have" ]; then _seed_report "$installed" current; return 0; fi', '[ "$want" = "$have" ] && return 0')
    .split('\n').filter((l) => !/^\s*_seed_report "\$installed" (updated|kept|added)$/.test(l)).join('\n')

  it('the stripped copy really has no trace of the hook', () => {
    expect(withoutHook).not.toContain('_seed_report')
    expect(withoutHook).not.toContain('seed_refresh_report')
    expect(LIB.split('_seed_report').length - 1).toBe(5)
  })

  // A run of the lib with the Docker seams, no hook defined: stdout and every file afterwards.
  function refresh(lib: string): { out: string; files: Record<string, string> } {
    const { inst, home } = install(lib)
    const script = [
      'cd "$MARVEEN_INSTALL_DIR"', '. scripts/lib/seed-lang.sh', '. scripts/lib/seed-refresh.sh', '. "$MARVEEN_DOCKER_DIR/seed-refresh-docker.sh"',
      'INSTALL_DIR="$MARVEEN_INSTALL_DIR"; MAIN_AGENT_ID=marveen; SEED_LANG="$(seed_lang "$INSTALL_DIR")"', 'mkdir -p .seed-prev',
      'docker_seed_refresh; echo "rc=$? updated=$SEED_REFRESH_UPDATED kept=$SEED_REFRESH_KEPT"',
    ].join('\n')
    const r = spawnSync('bash', ['-c', script], { env: ENV(inst, home), encoding: 'utf-8' })
    const files: Record<string, string> = {}
    for (const n of readdirSync(join(home, '.claude', 'skills'))) files[n] = skill(home, n)
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), files }
  }

  it('without a hook, the output and the files are the same as without the hook calls', () => {
    const now = refresh(LIB)
    rmSync(base as string, { recursive: true, force: true }); base = null
    const before = refresh(withoutHook)
    expect(now).toEqual(before)
    expect(now.out).toContain('rc=0 updated=1 kept=1')
    expect(now.out).not.toContain('seed ')
  })
})
