/**
 * SECSZIVEKKIADAS1008: the shell rc secret scrub reaches ALREADY INSTALLED Linux
 * machines. #1785 stopped the installer writing `export CLAUDE_CODE_OAUTH_TOKEN=`
 * / `export ANTHROPIC_API_KEY=` into ~/.bashrc and ~/.zshrc, but its cleanup sat
 * inside the auth prompt, which an install that already has auth never reaches,
 * and the customer's update path (the dashboard button -> update.sh) never ran
 * the installer at all. These tests pin the three legs: the shared functions
 * (scripts/lib/rc-secrets.sh, identical to the installer's inline copy), the
 * update.sh maintenance step (Linux only, above the up-to-date exit, never fatal),
 * and the installer's already-has-auth branch.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const linux = readFileSync('install-linux.sh', 'utf-8')
const lib = readFileSync('scripts/lib/rc-secrets.sh', 'utf-8')
const update = readFileSync('update.sh', 'utf-8')
const fnIn = (src: string, name: string): string => {
  const start = src.indexOf(`\n${name}() {`)
  expect(start, `${name} defined`).toBeGreaterThanOrEqual(0)
  return src.slice(start + 1, src.indexOf('\n}\n', start) + 3)
}
const SHARED = ['ensure_in_rc', 'remove_secret_export_from_rc', 'ensure_secret_reader_in_rc', 'rc_has_secret_export', 'scrub_secret_exports_from_rc']
const FAKE_TOKEN = 'sk-ant-oat01-' + 'A'.repeat(48)
const FAKE_KEY = 'sk-ant-api03-' + 'B'.repeat(40)

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function setup(rcText?: string): { home: string; inst: string } {
  const home = mkdtempSync(join(tmpdir(), 'rc-scrub-')); dirs.push(home)
  const inst = join(home, 'inst'); mkdirSync(join(inst, 'store'), { recursive: true }); mkdirSync(join(inst, 'scripts', 'lib'), { recursive: true })
  copyFileSync('scripts/lib/rc-secrets.sh', join(inst, 'scripts', 'lib', 'rc-secrets.sh'))
  const text = rcText ?? `alias ll=ls\nexport CLAUDE_CODE_OAUTH_TOKEN="${FAKE_TOKEN}"\n  export ANTHROPIC_API_KEY="${FAKE_KEY}"\nexport PATH="$HOME/bin:$PATH"\n`
  for (const rc of ['.bashrc', '.zshrc']) { writeFileSync(join(home, rc), text); chmodSync(join(home, rc), 0o644) }
  return { home, inst }
}
// update.sh's own step, cut out of update.sh, run under `set -e` with a faked uname.
function runUpdateStep(home: string, inst: string, os = 'Linux'): string {
  const script = `set -e\nORANGE=''; NC=''\nuname(){ echo ${os}; }\n${fnIn(update, 'scrub_rc_secrets')}\nscrub_rc_secrets\necho UPDATE-CONTINUES\n`
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: home, INSTALL_DIR: inst } })
}
function shellSees(home: string): string {
  return execFileSync('bash', ['-c', '. "$HOME/.bashrc"; printf "oauth=[%s] key=[%s]" "${CLAUDE_CODE_OAUTH_TOKEN-}" "${ANTHROPIC_API_KEY-}"'],
    { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: home } })
}

describe('the rc secret scrub reaches already installed Linux machines', () => {
  it('the library and the installer carry the same functions, byte for byte', () => {
    for (const name of SHARED) expect(fnIn(lib, name), name).toBe(fnIn(linux, name))
  })

  it('update.sh removes the secret exports, keeps the rest, the mode and the inode, and the shell still reads the 0600 files', () => {
    const { home, inst } = setup()
    const before = statSync(join(home, '.bashrc'))
    const out = runUpdateStep(home, inst)
    expect(out).toContain('UPDATE-CONTINUES')
    for (const rc of ['.bashrc', '.zshrc']) {
      const text = readFileSync(join(home, rc), 'utf-8')
      expect(text).not.toContain('sk-ant-')
      expect(text).toContain('alias ll=ls')
      expect(text).toContain('export PATH="$HOME/bin:$PATH"')
    }
    const after = statSync(join(home, '.bashrc'))
    expect(after.mode & 0o777).toBe(0o644)
    expect(after.ino).toBe(before.ino)
    writeFileSync(join(inst, 'store', '.claude-oauth-token'), FAKE_TOKEN, { mode: 0o600 })
    writeFileSync(join(inst, '.env'), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, { mode: 0o600 })
    expect(shellSees(home)).toBe(`oauth=[${FAKE_TOKEN}] key=[${FAKE_KEY}]`)
  })

  it('an rc without a secret export is left byte-identical (no reader line is added)', () => {
    const clean = 'alias ll=ls\nexport PATH="$HOME/bin:$PATH"\n'
    const { home, inst } = setup(clean)
    runUpdateStep(home, inst)
    expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe(clean)
    expect(readFileSync(join(home, '.zshrc'), 'utf-8')).toBe(clean)
  })

  it('a second update run changes nothing more (idempotent)', () => {
    const { home, inst } = setup()
    runUpdateStep(home, inst)
    const once = readFileSync(join(home, '.bashrc'), 'utf-8')
    runUpdateStep(home, inst)
    expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe(once)
  })

  it('macOS is untouched (only the Linux installer ever wrote these lines)', () => {
    const { home, inst } = setup()
    const before = readFileSync(join(home, '.bashrc'), 'utf-8')
    runUpdateStep(home, inst, 'Darwin')
    expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe(before)
  })

  it('a failing scrub never stops the update (set -e): it is reported and the run goes on', () => {
    const { home, inst } = setup()
    writeFileSync(join(inst, 'scripts', 'lib', 'rc-secrets.sh'), 'scrub_secret_exports_from_rc() { false; }\n')
    const r = spawnSync('bash', ['-c', `set -e\nORANGE=''; NC=''\nuname(){ echo Linux; }\n${fnIn(update, 'scrub_rc_secrets')}\nscrub_rc_secrets\necho UPDATE-CONTINUES\n`],
      { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: home, INSTALL_DIR: inst } })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FIGYELEM')
    expect(r.stdout).toContain('UPDATE-CONTINUES')
  })

  it('update.sh runs the step in its unit maintenance, ABOVE the up-to-date exit', () => {
    const maint = fnIn(update, 'run_unit_maintenance')
    expect(maint).toMatch(/\n {2}scrub_rc_secrets\n/)
    const call = update.indexOf('\nrun_unit_maintenance\n')
    const upToDate = update.indexOf('RESULT_PHASE="up-to-date"')
    expect(call).toBeGreaterThan(0)
    expect(upToDate).toBeGreaterThan(call)
  })

  it('the installer scrubs on an install that already has auth (the branch a re-run takes)', () => {
    const branch = linux.indexOf('if service_auth_present; then\n')
    const elseAt = linux.indexOf('\nelse\n', branch)
    expect(branch).toBeGreaterThan(0)
    expect(linux.slice(branch, elseAt + 1)).toContain('\n  scrub_secret_exports_from_rc\n')
  })
})
