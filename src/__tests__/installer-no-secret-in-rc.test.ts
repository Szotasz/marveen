/**
 * SECSZIVEK1007: the Linux installer never writes a credential into a shell rc
 * file. An rc file is typically 0644 and the services never read it (they use
 * <install>/.env and <install>/store/.claude-oauth-token, both 0600). A re-run
 * removes the export lines earlier installer versions wrote; an interactive
 * shell can still get the value through one line that READS the 0600 file.
 *
 * The functions are cut out of install-linux.sh and run under bash with a
 * throwaway HOME (the same approach as installer-windows-wsl.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const linux = readFileSync('install-linux.sh', 'utf-8')
const fnOf = (name: string): string => {
  const start = linux.indexOf(`${name}() {`)
  expect(start).toBeGreaterThan(0)
  return linux.slice(start, linux.indexOf('\n}\n', start) + 3)
}
const FNS = ['ensure_in_rc', 'remove_secret_export_from_rc', 'ensure_secret_reader_in_rc'].map(fnOf).join('\n')
const FAKE_TOKEN = 'sk-ant-oat01-' + 'A'.repeat(48)
const FAKE_KEY = 'sk-ant-api03-' + 'B'.repeat(40)

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function setup(installName = 'inst'): { home: string; inst: string } {
  const home = mkdtempSync(join(tmpdir(), 'rc-sec-')); dirs.push(home)
  const inst = join(home, installName); mkdirSync(join(inst, 'store'), { recursive: true })
  const old = `alias ll=ls\nexport CLAUDE_CODE_OAUTH_TOKEN="${FAKE_TOKEN}"\n  export ANTHROPIC_API_KEY="${FAKE_KEY}"\nexport PATH="$HOME/bin:$PATH"\n`
  writeFileSync(join(home, '.bashrc'), old); chmodSync(join(home, '.bashrc'), 0o644)
  writeFileSync(join(home, '.zshrc'), old); chmodSync(join(home, '.zshrc'), 0o644)
  return { home, inst }
}
function runInstallerSteps(home: string, inst: string): void {
  const script = `warn(){ :; }\n${FNS}\n` +
    `remove_secret_export_from_rc CLAUDE_CODE_OAUTH_TOKEN\n` +
    `ensure_secret_reader_in_rc CLAUDE_CODE_OAUTH_TOKEN "$INST/store/.claude-oauth-token" file\n` +
    `remove_secret_export_from_rc ANTHROPIC_API_KEY\n` +
    `ensure_secret_reader_in_rc ANTHROPIC_API_KEY "$INST/.env" env\n`
  execFileSync('bash', ['-c', script], { env: { ...process.env, HOME: home, INST: inst } })
}
// What an interactive shell sees after sourcing the rc.
function shellSees(home: string): string {
  return execFileSync('bash', ['-c', '. "$HOME/.bashrc"; printf "oauth=[%s] key=[%s] set=[%s]" "${CLAUDE_CODE_OAUTH_TOKEN-}" "${ANTHROPIC_API_KEY-}" "${CLAUDE_CODE_OAUTH_TOKEN+y}${ANTHROPIC_API_KEY+y}"'],
    { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: home } })
}

describe('install-linux.sh keeps secrets out of shell rc files', () => {
  it('a re-run removes the old secret export lines from .bashrc and .zshrc, keeps the rest, the mode and the inode', () => {
    const { home, inst } = setup()
    const before = statSync(join(home, '.bashrc'))
    runInstallerSteps(home, inst)
    for (const rc of ['.bashrc', '.zshrc']) {
      const text = readFileSync(join(home, rc), 'utf-8')
      expect(text).not.toContain('sk-ant-')
      expect(text).toContain('alias ll=ls')
      expect(text).toContain('export PATH="$HOME/bin:$PATH"')
    }
    const after = statSync(join(home, '.bashrc'))
    expect(after.mode & 0o777).toBe(0o644)
    expect(after.ino).toBe(before.ino)
  })

  it('a second run adds nothing and removes nothing more (idempotent)', () => {
    const { home, inst } = setup()
    runInstallerSteps(home, inst)
    const once = readFileSync(join(home, '.bashrc'), 'utf-8')
    runInstallerSteps(home, inst)
    expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe(once)
  })

  it('an interactive shell reads the token from the 0600 store file and the key from .env', () => {
    const { home, inst } = setup()
    runInstallerSteps(home, inst)
    writeFileSync(join(inst, 'store', '.claude-oauth-token'), FAKE_TOKEN, { mode: 0o600 })
    writeFileSync(join(inst, '.env'), `FOO=1\nANTHROPIC_API_KEY=${FAKE_KEY}\n`, { mode: 0o600 })
    expect(shellSees(home)).toBe(`oauth=[${FAKE_TOKEN}] key=[${FAKE_KEY}] set=[yy]`)
  })

  it.skipIf(!(() => { try { execFileSync('zsh', ['-c', 'true']); return true } catch { return false } })())('zsh reads the same line the same way (.zshrc)', () => {
    const { home, inst } = setup()
    runInstallerSteps(home, inst)
    writeFileSync(join(inst, 'store', '.claude-oauth-token'), FAKE_TOKEN, { mode: 0o600 })
    const out = execFileSync('zsh', ['-f', '-c', '. "$HOME/.zshrc"; printf "oauth=[%s]" "${CLAUDE_CODE_OAUTH_TOKEN-}"'], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', HOME: home } })
    expect(out).toBe(`oauth=[${FAKE_TOKEN}]`)
  })

  it('without the files nothing is exported (no empty value that would shadow a login)', () => {
    const { home, inst } = setup()
    runInstallerSteps(home, inst)
    expect(shellSees(home)).toBe('oauth=[] key=[] set=[]')
  })

  it('an install path with an apostrophe still reads the right file', () => {
    const { home, inst } = setup("it's inst")
    runInstallerSteps(home, inst)
    writeFileSync(join(inst, 'store', '.claude-oauth-token'), FAKE_TOKEN, { mode: 0o600 })
    expect(shellSees(home)).toContain(`oauth=[${FAKE_TOKEN}]`)
  })

  it('no installer step writes a captured secret into an rc file (call sites)', () => {
    expect(linux).not.toContain('set_export_in_rc')
    for (const line of linux.split('\n')) {
      if (/(ensure_in_rc|>>\s*"?\$rc|bashrc|zshrc)/.test(line)) {
        expect(line).not.toMatch(/OAUTH_TOKEN_INPUT|ANTHROPIC_API_KEY_INPUT/)
      }
    }
    const oauth = linux.indexOf('export CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN_INPUT"')
    expect(linux.indexOf('remove_secret_export_from_rc CLAUDE_CODE_OAUTH_TOKEN', oauth)).toBeGreaterThan(oauth)
    const key = linux.indexOf('export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY_INPUT"')
    expect(linux.indexOf('remove_secret_export_from_rc ANTHROPIC_API_KEY', key)).toBeGreaterThan(key)
  })
})
