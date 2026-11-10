// DOCKERSEEDREFRESH1108 (Samu 73381, 73384): a Docker volume's untouched seed copies follow a new image. The image has
// no .git, so docker/seed-snapshot.sh keeps the OLD tree's seed sources before code-sync swaps the code, and first-boot
// runs the shared rules (scripts/lib/seed-refresh.sh) with docker/seed-refresh-docker.sh's seams. Driven in temp dirs,
// the scripts' real text, no Docker needed.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const SCHED = 'scheduled' + '-tasks'
const FIRSTBOOT = readFileSync(join(ROOT, 'docker', 'first-boot.sh'), 'utf-8')
const REFRESH_BLOCK = FIRSTBOOT.slice(FIRSTBOOT.indexOf('if [ -d .seed-prev ]; then'), FIRSTBOOT.indexOf('\n# The hooks, as update.sh installs them'))

type Files = Record<string, string>
function put(base: string, files: Files) {
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), body) }
}
const lit = (s: string, id: { owner: string; bot: string }) => s.replaceAll('{{MAIN_AGENT_ID}}', 'marveen').replaceAll('{{OWNER_NAME}}', id.owner).replaceAll('{{BOT_NAME}}', id.bot)
const PRE = { owner: 'Owner', bot: 'Marveen' }                  // first-boot's identity before the wizard
const NOW = { owner: 'Kiss & Társa\\Kft', bot: 'Jarvis/2 & co' }  // the wizard's names, sed metacharacters on purpose

// The tree the volume ran (v1.48.0-shaped: no i18n/en, no seed-lang.sh) and the new image's tree.
const OLD: Files = {
  'seed-skills/alpha/SKILL.md': 'alpha v1\n',
  'seed-skills/beta/SKILL.md': 'beta v1\n', 'seed-skills/beta/references/r.md': 'r v1\n',
  'seed-skills/gamma/SKILL.md': 'gamma v1\n', 'seed-skills/gamma/references/g.md': 'g v1\n',
  [`seed-${SCHED}/taskA/SKILL.md`]: 'A v1 for {{OWNER_NAME}}, by {{BOT_NAME}}\n',
  [`seed-${SCHED}/taskB/SKILL.md`]: 'B v1 {{OWNER_NAME}}\n',
  [`${SCHED}/topC/SKILL.md`]: 'C v1 {{MAIN_AGENT_ID}}\n',
  [`seed-${SCHED}/taskD/SKILL.md`]: 'D v1\n', [`seed-${SCHED}/taskD/references/n.md`]: 'n v1\n',
}
const NEW: Files = {
  'seed-skills/alpha/SKILL.md': 'alpha v2\n', 'i18n/en/seed-skills/alpha/SKILL.md': 'alpha EN v2\n',
  'seed-skills/beta/SKILL.md': 'beta v2\n', 'seed-skills/beta/references/r.md': 'r v2\n',
  'i18n/en/seed-skills/beta/SKILL.md': 'beta EN v2\n', 'i18n/en/seed-skills/beta/references/r.md': 'r EN v2\n',
  'seed-skills/gamma/SKILL.md': 'gamma v2\n', 'seed-skills/gamma/references/g.md': 'g v2\n',
  'i18n/en/seed-skills/gamma/SKILL.md': 'gamma EN v2\n', 'i18n/en/seed-skills/gamma/references/g.md': 'g EN v2\n',
  [`seed-${SCHED}/taskA/SKILL.md`]: 'A v2 for {{OWNER_NAME}}, by {{BOT_NAME}}\n', [`i18n/en/seed-${SCHED}/taskA/SKILL.md`]: 'A EN v2 for {{OWNER_NAME}}, by {{BOT_NAME}}\n',
  [`seed-${SCHED}/taskB/SKILL.md`]: 'B v2 {{OWNER_NAME}}\n',
  [`${SCHED}/topC/SKILL.md`]: 'C v2 {{MAIN_AGENT_ID}}\n',
  [`seed-${SCHED}/taskD/SKILL.md`]: 'D v2\n', [`seed-${SCHED}/taskD/references/n.md`]: 'n v2\n',
}

function volume(opts: { installed: Files; verify?: Record<string, number>; registerFails?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'dseed-'))
  const install = join(base, 'opt-marveen'); const meta = join(base, 'opt-marveen-docker'); const home = join(base, 'home'); const log = join(base, 'cli.log')
  mkdirSync(install, { recursive: true }); mkdirSync(meta, { recursive: true }); mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  put(install, OLD)
  writeFileSync(join(install, '.image-id'), 'old-image\n'); writeFileSync(join(meta, 'image.id'), 'new-image\n')
  cpSync(join(ROOT, 'docker', 'seed-snapshot.sh'), join(meta, 'seed-snapshot.sh')); cpSync(join(ROOT, 'docker', 'seed-refresh-docker.sh'), join(meta, 'seed-refresh-docker.sh'))
  writeFileSync(join(install, '.env'), `MAIN_AGENT_ID=marveen\nOWNER_NAME=${NOW.owner}\nBOT_NAME=${NOW.bot}\nAGENT_TEXT_LANG=en\n`)
  put(home, Object.fromEntries(Object.entries(opts.installed).map(([k, v]) => [join('.claude', k), v])))
  const verify = opts.verify ?? { taskA: 0, taskB: 1, topC: 0 }
  put(install, { 'dist/package.json': '{"type":"commonjs"}\n', 'dist/web/schedule-registry-cli.js': `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')+'\\n');
const [c,...a]=process.argv.slice(2);const v=${JSON.stringify(verify)};
if(c==='verify'){const n=a[0]; if(v[n]===0){console.log('ok '+n);process.exit(0)} console.log('unregistered '+n);process.exit(1)}
if(c==='register'){process.exit(${opts.registerFails ? 1 : 0})} process.exit(0)\n` })
  return { base, install, meta, home, log }
}
type Vol = ReturnType<typeof volume>

function snapshot(v: Vol): string {
  return execFileSync('bash', [join(v.meta, 'seed-snapshot.sh')], { env: { PATH: process.env.PATH, MARVEEN_INSTALL_DIR: v.install, MARVEEN_DOCKER_DIR: v.meta }, encoding: 'utf-8' })
}
/** What code-sync does to the seed dirs: the old tree's code out, the new image's in (state such as .seed-prev stays). */
function swap(v: Vol) {
  for (const d of ['seed-skills', `seed-${SCHED}`, SCHED, 'i18n']) rmSync(join(v.install, d), { recursive: true, force: true })
  put(v.install, NEW)
  for (const f of ['seed-refresh.sh', 'seed-lang.sh', 'persona-template.sh']) cpSync(join(ROOT, 'scripts', 'lib', f), join(v.install, 'scripts', 'lib', f))
  writeFileSync(join(v.install, '.image-id'), 'new-image\n')
}
/** first-boot's refresh block, its real text, under first-boot's own prelude (set -u, the identity from .env). */
function firstBootRefresh(v: Vol, extra = ''): { out: string; code: number } {
  const script = ['set -u', `INSTALL_DIR=${JSON.stringify(v.install)}`, 'cd "$INSTALL_DIR"', "say() { printf 'first-boot: %s\\n' \"$*\"; }",
    'env_val() { grep -m1 "^$1=" .env | cut -d= -f2-; }', 'OWNER_NAME="$(env_val OWNER_NAME)"; BOT_NAME="$(env_val BOT_NAME)"; AGENT_ID="$(env_val MAIN_AGENT_ID)"; WEB_PORT=3420',
    'SEED_LANG=hu', 'if [ -f scripts/lib/seed-lang.sh ]; then . scripts/lib/seed-lang.sh; SEED_LANG="$(seed_lang "$INSTALL_DIR")"; fi',
    '. scripts/lib/seed-refresh.sh', extra, REFRESH_BLOCK, 'echo "first-boot rc=$?"'].join('\n')
  const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: v.home, MARVEEN_DOCKER_DIR: v.meta, LANG: 'C.UTF-8' }, encoding: 'utf-8' })
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status ?? -1 }
}
const read = (v: Vol, rel: string) => readFileSync(join(v.home, '.claude', rel), 'utf-8')
const cli = (v: Vol) => (existsSync(v.log) ? readFileSync(v.log, 'utf-8') : '')

// A v1.48.0 volume after the wizard: every copy as the old tree seeded it (the templated ones with the pre-wizard
// identity, one with the wizard's), beta's references file edited by the operator.
const SEEDED: Files = {
  'skills/alpha/SKILL.md': 'alpha v1\n',
  'skills/beta/SKILL.md': 'beta v1\n', 'skills/beta/references/r.md': 'r v1\n# my note\n',
  'skills/gamma/SKILL.md': 'gamma v1\n', 'skills/gamma/references/g.md': 'g v1\n',
  [`${SCHED}/taskA/SKILL.md`]: lit(OLD[`seed-${SCHED}/taskA/SKILL.md`], PRE),
  [`${SCHED}/taskB/SKILL.md`]: lit(OLD[`seed-${SCHED}/taskB/SKILL.md`], NOW),
  [`${SCHED}/topC/SKILL.md`]: lit(OLD[`${SCHED}/topC/SKILL.md`], NOW),
}

describe('a v1.48.0 volume on the new image (snapshot -> swap -> first-boot)', () => {
  it('untouched copies follow the new English texts with the wizard names, literally; an edited dir stays Hungarian whole', () => {
    const v = volume({ installed: SEEDED })
    try {
      expect(snapshot(v)).toContain('seed sources of old-image kept')
      expect(readFileSync(join(v.install, '.seed-prev', 'seed-skills', 'alpha', 'SKILL.md'), 'utf-8')).toBe('alpha v1\n')
      swap(v)
      const r = firstBootRefresh(v)
      expect(r.out).toContain('first-boot rc=0')
      expect(read(v, 'skills/alpha/SKILL.md')).toBe('alpha EN v2\n')
      // beta: one file edited -> the dir keeps its language (Hungarian), the untouched sibling still gets the fix
      expect(read(v, 'skills/beta/SKILL.md')).toBe('beta v2\n')
      expect(read(v, 'skills/beta/references/r.md')).toBe('r v1\n# my note\n')
      expect(read(v, 'skills/gamma/SKILL.md')).toBe('gamma EN v2\n')
      expect(read(v, 'skills/gamma/references/g.md')).toBe('g EN v2\n')
      // taskA was rendered with the PRE-wizard identity; refreshed with the CURRENT .env names, literally
      expect(read(v, `${SCHED}/taskA/SKILL.md`)).toBe(lit(NEW[`i18n/en/seed-${SCHED}/taskA/SKILL.md`], NOW))
      // taskB was rendered with the CURRENT identity: untouched as well
      expect(read(v, `${SCHED}/taskB/SKILL.md`)).toBe(lit(NEW[`seed-${SCHED}/taskB/SKILL.md`], NOW))
      expect(read(v, `${SCHED}/topC/SKILL.md`)).toBe('C v2 marveen\n')
      // trusted tasks re-registered with the installer source; taskB (not trusted, extra-free) is all shipped -> registered
      expect(cli(v)).toContain('register --source installer taskA')
      expect(cli(v)).toContain('register --source installer topC')
      expect(existsSync(join(v.install, '.seed-prev'))).toBe(false)
      // nothing but the shipped files under ~/.claude (no .seedtmp)
      expect(readdirSync(join(v.home, '.claude', SCHED, 'taskA'))).toEqual(['SKILL.md'])
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })

  it('a second start changes nothing (idempotent) and takes no snapshot', () => {
    const v = volume({ installed: SEEDED })
    try {
      snapshot(v); swap(v); firstBootRefresh(v)
      const before = JSON.stringify(Object.keys(SEEDED).map((k) => read(v, k)))
      expect(snapshot(v)).toBe('')
      expect(firstBootRefresh(v).out).toBe('first-boot rc=0\n')
      expect(JSON.stringify(Object.keys(SEEDED).map((k) => read(v, k)))).toBe(before)
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })
})

describe('the snapshot is taken only when it describes the tree that seeded the copies', () => {
  it('no tree run yet (no .image-id), the same image, or an interrupted code sync: no snapshot', () => {
    for (const setup of ['no-id', 'same', 'pending'] as const) {
      const v = volume({ installed: {} })
      try {
        if (setup === 'no-id') rmSync(join(v.install, '.image-id'))
        if (setup === 'same') writeFileSync(join(v.meta, 'image.id'), 'old-image\n')
        if (setup === 'pending') writeFileSync(join(v.install, '.code-sync-pending'), '')
        const out = snapshot(v)
        expect(existsSync(join(v.install, '.seed-prev')), setup).toBe(false)
        if (setup === 'pending') expect(out).toContain('half-swapped')
      } finally { rmSync(v.base, { recursive: true, force: true }) }
    }
  })

  it('an unapplied snapshot is never overwritten (v1 -> failed v2 -> v3 still compares against v1)', () => {
    const v = volume({ installed: {} })
    try {
      put(v.install, { '.seed-prev/seed-skills/alpha/SKILL.md': 'alpha v0 (the tree that seeded)\n' })
      expect(snapshot(v)).toContain('unapplied snapshot is kept')
      expect(readFileSync(join(v.install, '.seed-prev', 'seed-skills', 'alpha', 'SKILL.md'), 'utf-8')).toBe('alpha v0 (the tree that seeded)\n')
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })
})

describe('a retry after a run that stopped half way', () => {
  it('a dir already partly rewritten to the new English text is finished in English, not turned half Hungarian', () => {
    const v = volume({ installed: { 'skills/gamma/SKILL.md': 'gamma EN v2\n', 'skills/gamma/references/g.md': 'g v1\n' } })
    try {
      snapshot(v); swap(v)
      expect(firstBootRefresh(v).out).toContain('first-boot rc=0')
      expect(read(v, 'skills/gamma/references/g.md')).toBe('g EN v2\n')
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })

  it('a task rewritten before the crash but not registered gets registered, with the verdict recorded before the write', () => {
    const v = volume({ installed: { [`${SCHED}/taskA/SKILL.md`]: lit(NEW[`i18n/en/seed-${SCHED}/taskA/SKILL.md`], NOW) }, verify: { taskA: 1 } })
    try {
      snapshot(v); swap(v)
      // the first run had asked the registry before its write (trusted then) and crashed before registering
      put(v.install, { '.seed-prev/.verdicts/taskA': '0' })
      expect(firstBootRefresh(v).out).toContain('first-boot rc=0')
      expect(cli(v)).toBe('register --source installer taskA\n')   // no fresh verify: the recorded verdict is used
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })

  it('a retry that still writes uses the verdict from BEFORE the first write (rule a: trusted, an operator file kept)', () => {
    // taskD: the crashed run rewrote SKILL.md, its references file is still old, and the operator keeps an own file
    // there (so the dir is not all shipped: only the recorded "trusted before" verdict may register it).
    const v = volume({ installed: { [`${SCHED}/taskD/SKILL.md`]: 'D v2\n', [`${SCHED}/taskD/references/n.md`]: 'n v1\n', [`${SCHED}/taskD/mine.md`]: 'operator\n' },
      verify: { taskD: 1 } })
    try {
      snapshot(v); swap(v)
      put(v.install, { '.seed-prev/.verdicts/taskD': '0' })
      expect(firstBootRefresh(v).out).toContain('first-boot rc=0')
      expect(read(v, `${SCHED}/taskD/references/n.md`)).toBe('n v2\n')
      expect(read(v, `${SCHED}/taskD/mine.md`)).toBe('operator\n')
      expect(cli(v)).toBe('register --source installer taskD\n')
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })
})

describe('the recorded registry verdict', () => {
  it('only 0 and 1 are verdicts; anything else in the record is unknown (2), never a return error', () => {
    const v = volume({ installed: {} })
    try {
      const probe = (content: string) => {
        put(v.install, { '.seed-prev/.verdicts/t': content })
        const r = spawnSync('bash', ['-c', `set -u\nINSTALL_DIR=${JSON.stringify(v.install)}\n. ${JSON.stringify(join(v.meta, 'seed-refresh-docker.sh'))}\nsched_task_verified_ok t; echo "rc=$?"`], { encoding: 'utf-8' })
        return (r.stdout ?? '') + (r.stderr ?? '')
      }
      expect(probe('0')).toBe('rc=0\n')
      expect(probe('1')).toBe('rc=1\n')
      for (const junk of ['2', 'x', '', '300', '-1']) expect(probe(junk), JSON.stringify(junk)).toBe('rc=2\n')
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })
})

describe('the start is never blocked by the refresh', () => {
  it('without the Docker seams file the block says WARN, first-boot goes on, the snapshot stays', () => {
    const v = volume({ installed: SEEDED })
    try {
      snapshot(v); swap(v); rmSync(join(v.meta, 'seed-refresh-docker.sh'))
      const r = firstBootRefresh(v)
      expect(r.out).toContain('first-boot: WARN: the seed refresh did not finish')
      expect(r.out).toContain('first-boot rc=0')
      expect(existsSync(join(v.install, '.seed-prev'))).toBe(true)
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })

  it('a write that does not finish (a .seedtmp left) keeps the snapshot for the next start', () => {
    const v = volume({ installed: SEEDED })
    try {
      snapshot(v); swap(v)
      // next to a file this run keeps (beta's edited references file), so no write of this run consumes it
      put(v.home, { [join('.claude', 'skills', 'beta', 'references', 'r.md.seedtmp')]: '' })
      const r = firstBootRefresh(v)
      expect(r.out).toContain('a .seedtmp is left')
      expect(r.out).toContain('first-boot rc=0')
      expect(existsSync(join(v.install, '.seed-prev'))).toBe(true)
    } finally { rmSync(v.base, { recursive: true, force: true }) }
  })
})

describe('no gitignored file of the seed dirs ships in the image (Dockerfile)', () => {
  const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8')
  const STEP = 'RUN cd /src && g="$(mktemp -d)"'
  const run = DOCKERFILE.slice(DOCKERFILE.indexOf(STEP) + 4, DOCKERFILE.indexOf('rm -rf "$g" "$g.list"') + 'rm -rf "$g" "$g.list"'.length)
    .replace(/\\\n\s*/g, ' ')

  it('the cleanup runs in the BUILD stage right after COPY . . (a later runtime RUN would only hide the bytes in an upper layer)', () => {
    const at = DOCKERFILE.indexOf(STEP)
    const copyCtx = DOCKERFILE.indexOf('\nCOPY . .\n')
    const runtime = DOCKERFILE.indexOf('FROM ${NODE_IMAGE} AS runtime')
    expect(at).toBeGreaterThan(copyCtx)
    expect(copyCtx).toBeGreaterThan(0)
    expect(at).toBeLessThan(runtime)
    // nothing between COPY . . and the cleanup (no layer holds the files first), and no cleanup in the runtime stage
    expect(DOCKERFILE.slice(copyCtx + '\nCOPY . .\n'.length, at).split('\n').every((l) => l === '' || l.startsWith('#'))).toBe(true)
    expect(DOCKERFILE.slice(runtime)).not.toContain('--ignored --exclude-standard')
    // git is in the build stage's packages
    expect(DOCKERFILE.slice(0, runtime)).toMatch(/apt-get install -y --no-install-recommends python3 make g\+\+ ca-certificates git\b/)
  })

  it('the known seed secrets never enter the build context (.dockerignore)', () => {
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8').split('\n')
    expect(ignore).toContain('**/mail_rules.json')
    expect(ignore).toContain('**/.dashboard-token')
  })

  it('the cleanup step (its real text) removes an ignored file under a skill, keeps the tracked ones, leaves no .git', () => {
    const base = mkdtempSync(join(tmpdir(), 'dseed-img-'))
    try {
      put(base, { 'seed-skills/fleet-helper/scripts/.gitignore': 'mail_rules.json\n.dashboard-token\n', 'seed-skills/fleet-helper/scripts/mail_rules.json': '{"secret":1}\n',
        'seed-skills/fleet-helper/scripts/.dashboard-token': 'tok\n', 'seed-skills/fleet-helper/SKILL.md': 'x\n', 'seed-skills/fleet-helper/scripts/run.sh': 'echo\n', 'other/mail_rules.json': 'outside the seed dirs\n' })
      execFileSync('sh', ['-c', run.replace('cd /src', `cd ${JSON.stringify(base)}`)], { stdio: 'pipe' })
      expect(existsSync(join(base, 'seed-skills/fleet-helper/scripts/mail_rules.json'))).toBe(false)
      expect(existsSync(join(base, 'seed-skills/fleet-helper/scripts/.dashboard-token'))).toBe(false)
      expect(existsSync(join(base, 'seed-skills/fleet-helper/scripts/run.sh'))).toBe(true)
      expect(existsSync(join(base, 'seed-skills/fleet-helper/scripts/.gitignore'))).toBe(true)
      expect(existsSync(join(base, 'other/mail_rules.json'))).toBe(true)
      expect(existsSync(join(base, '.git'))).toBe(false)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('no TRACKED file of the seed dirs matches an ignore rule (the cleanup would remove a shipped file)', () => {
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-ci', '--exclude-standard', '--', 'seed-skills', 'skills', `seed-${SCHED}`, SCHED, 'templates', 'i18n'], { encoding: 'utf-8' })
    expect(out).toBe('')
  })
})
