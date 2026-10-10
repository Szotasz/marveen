// SLACKATALLAS1006 (owner, 2026-10-10: the owner moved to Slack, and an alert
// that still reached Telegram was the complaint). NOTIFY_TELEGRAM_FALLBACK=0
// means Telegram never gets a notification as a FALLBACK: not without a Slack
// target, not when the Slack module fails to load, not when the send fails.
// The default (1) keeps "nothing is lost" -- those cases stay pinned in
// slack-notify.test.ts and slack-notify-import-failure.test.ts.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

const { deliverWithSlack } = await import('../notify.js')
const { deliveryFallbackClause } = await import('../web/schedule-runner.js')

describe('deliverWithSlack with NOTIFY_TELEGRAM_FALLBACK=0', () => {
  beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })
  const run = async (slackOk: boolean) => {
    const telegram = vi.fn(async () => {})
    const send = vi.fn(async () => (slackOk ? { ok: true } : { ok: false, error: 'boom' }))
    await deliverWithSlack('alert', 'hello', telegram, send as never)
    return { telegram, send }
  }

  it('Slack FAILS -> Telegram is NOT called', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'dm', NOTIFY_TELEGRAM_FALLBACK: '0' })
    const { telegram, send } = await run(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(telegram).not.toHaveBeenCalled()
  })

  it('no Slack target -> Telegram is NOT called either', async () => {
    settings.NOTIFY_TELEGRAM_FALLBACK = '0'
    const { telegram, send } = await run(true)
    expect(send).not.toHaveBeenCalled()
    expect(telegram).not.toHaveBeenCalled()
  })

  it('Slack OK: the switch leaves NOTIFY_TELEGRAM alone (it decides "beside", this one "instead")', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'dm', NOTIFY_TELEGRAM_FALLBACK: '0', NOTIFY_TELEGRAM: '1' })
    expect((await run(true)).telegram).toHaveBeenCalledTimes(1)
    settings.NOTIFY_TELEGRAM = '0'
    expect((await run(true)).telegram).not.toHaveBeenCalled()
  })

  it('control: the same failure with the default setting still falls back to Telegram', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const { telegram } = await run(false)
    expect(telegram).toHaveBeenCalledTimes(1)
  })
})

describe('deliveryFallbackClause with the Telegram fallback off', () => {
  it('names notify.sh instead of the owner Telegram chat', () => {
    const c = deliveryFallbackClause('slack', true, '1268077055', true)
    expect(c).toContain('scripts/notify.sh')
    expect(c).toContain('Telegramra NE')
    expect(c).not.toContain('chat_id: 1268077055')
    expect(c).toContain('Outbound gate')
  })
  it('control: with the fallback on, the Telegram clause is unchanged', () => {
    expect(deliveryFallbackClause('slack', true, '1268077055', false)).toContain('Telegramon (chat_id: 1268077055, reply tool)')
  })
  it('still nothing for a sub-agent or for Telegram itself', () => {
    expect(deliveryFallbackClause('slack', false, '1268077055', true)).toBe('')
    expect(deliveryFallbackClause('telegram', true, '1268077055', true)).toBe('')
  })
})

// notify.sh: the real script in a throwaway install, a fake Slack helper and a
// fake curl first on PATH, so a Telegram attempt is recorded, never sent.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let dir: string | null = null
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

function install(slack: { rc: number; out: string }): string {
  dir = mkdtempSync(join(tmpdir(), 'notify-tgoff-'))
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  copyFileSync(join(ROOT, 'scripts', 'notify.sh'), join(dir, 'scripts', 'notify.sh'))
  for (const lib of ['owner-chat.sh', 'send-telegram.sh']) copyFileSync(join(ROOT, 'scripts', 'lib', lib), join(dir, 'scripts', 'lib', lib))
  chmodSync(join(dir, 'scripts', 'notify.sh'), 0o755)
  writeFileSync(join(dir, 'dist', 'slack-notify.js'), '')
  writeFileSync(join(dir, 'scripts', 'slack-notify.mjs'), `process.stdout.write(${JSON.stringify(slack.out)}); process.exit(${slack.rc})\n`)
  // A configured Telegram: token AND owner chat, so only the fallback rule can stop it.
  writeFileSync(join(dir, '.env'), 'MAIN_AGENT_ID=marveen\nTELEGRAM_BOT_TOKEN=123:abc\nALLOWED_CHAT_ID=1268077055\n')
  writeFileSync(join(dir, 'bin', 'curl'), `#!/bin/bash\ntouch "${join(dir, 'TELEGRAM_ATTEMPTED')}"\necho '{"ok":true}'\n`)
  chmodSync(join(dir, 'bin', 'curl'), 0o755)
  return dir
}
function run(root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PATH: `${join(root, 'bin')}:${process.env.PATH}` }
  delete env.TMUX; delete env.VITEST
  return spawnSync('bash', [join(root, 'scripts', 'notify.sh'), 'proba'], { encoding: 'utf-8', env })
}

describe('notify.sh with the Telegram fallback off', () => {
  it('Slack failed + "telegram":"skip": exits 1, says so, and never tries Telegram', () => {
    const root = install({ rc: 1, out: '{"ok":false,"error":"boom","telegram":"skip"}' })
    const r = run(root)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('NOTIFY_TELEGRAM_FALLBACK=0')
    expect(r.stdout).not.toContain('Ertesites elkuldve')
    expect(existsSync(join(root, 'TELEGRAM_ATTEMPTED'))).toBe(false)
  })
  it('no Slack target + "telegram":"skip": the same loud failure, no Telegram', () => {
    const root = install({ rc: 2, out: '{"ok":false,"skipped":true,"telegram":"skip"}' })
    const r = run(root)
    expect(r.status).toBe(1)
    expect(existsSync(join(root, 'TELEGRAM_ATTEMPTED'))).toBe(false)
  })
  it('Slack delivered + "telegram":"skip": success through Slack, no Telegram', () => {
    const root = install({ rc: 0, out: '{"ok":true,"telegram":"skip"}' })
    const r = run(root)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Ertesites elkuldve (Slack).')
    expect(existsSync(join(root, 'TELEGRAM_ATTEMPTED'))).toBe(false)
  })
  it('control: Slack failed + "telegram":"send" still reaches the (fake) Telegram', () => {
    const root = install({ rc: 1, out: '{"ok":false,"error":"boom","telegram":"send"}' })
    run(root)
    expect(existsSync(join(root, 'TELEGRAM_ATTEMPTED'))).toBe(true)
  })
})
