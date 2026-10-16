import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// SLACKATALLAS1006 follow-up (Dani's #1755 review): scripts/notify.sh used to
// exit on a missing TELEGRAM_BOT_TOKEN BEFORE the Slack branch, so on a
// Slack-only install it sent nothing at all. These tests run the real script in
// a throwaway install with a fake Slack helper, so no network is touched: the
// Telegram path is never reached in any case below (no token, or no chat).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let dir: string | null = null

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function install(env: string, slack: { rc: number; out: string }): string {
  dir = mkdtempSync(join(tmpdir(), 'notify-sh-'))
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(dir, 'dist'), { recursive: true })
  copyFileSync(join(ROOT, 'scripts', 'notify.sh'), join(dir, 'scripts', 'notify.sh'))
  for (const lib of ['owner-chat.sh', 'send-telegram.sh']) {
    copyFileSync(join(ROOT, 'scripts', 'lib', lib), join(dir, 'scripts', 'lib', lib))
  }
  chmodSync(join(dir, 'scripts', 'notify.sh'), 0o755)
  // notify.sh only calls the helper when dist/slack-notify.js exists.
  writeFileSync(join(dir, 'dist', 'slack-notify.js'), '')
  writeFileSync(
    join(dir, 'scripts', 'slack-notify.mjs'),
    `process.stdout.write(${JSON.stringify(slack.out)}); process.exit(${slack.rc})\n`,
  )
  writeFileSync(join(dir, '.env'), env)
  return dir
}

function run(root: string) {
  const env = { ...process.env }
  delete env.TMUX
  delete env.VITEST
  // HOME points into the throwaway install so the owner-chat resolver cannot
  // find a real access.json on this host.
  env.HOME = root
  return spawnSync('bash', [join(root, 'scripts', 'notify.sh'), 'proba'], { encoding: 'utf-8', env })
}

describe('notify.sh on an install without Telegram', () => {
  it('a Slack-only install delivers through Slack and exits 0', () => {
    const r = run(install('MAIN_AGENT_ID=marveen\n', { rc: 0, out: '{"slack":"ok","telegram":"send"}' }))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Ertesites elkuldve (Slack')
  })

  it('no Telegram token and no Slack target: still a loud failure, as before', () => {
    const r = run(install('MAIN_AGENT_ID=marveen\n', { rc: 2, out: '' }))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('TELEGRAM_BOT_TOKEN nincs beallitva')
  })

  it('no Telegram token and a failed Slack send: failure, never a false success', () => {
    const r = run(install('MAIN_AGENT_ID=marveen\n', { rc: 1, out: '{"slack":"error"}' }))
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('Ertesites elkuldve')
  })

  it('a token but no owner chat, Slack delivered: success through Slack', () => {
    const r = run(install('TELEGRAM_BOT_TOKEN=123:abc\nALLOWED_CHAT_ID=0\n', { rc: 0, out: '{"slack":"ok","telegram":"send"}' }))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Ertesites elkuldve (Slack')
  })

  it('a token but no owner chat, no Slack: the old ALLOWED_CHAT_ID failure', () => {
    const r = run(install('TELEGRAM_BOT_TOKEN=123:abc\nALLOWED_CHAT_ID=0\n', { rc: 2, out: '' }))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('ALLOWED_CHAT_ID nincs beallitva')
  })
})
