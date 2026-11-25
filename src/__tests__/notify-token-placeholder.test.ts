import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// BOTTOKEN1124: the install .env held the installer placeholder in
// TELEGRAM_BOT_TOKEN (and ALLOWED_CHAT_ID), the Bot API answered 404 and every
// notify.sh alert was silent, while the channel state dir
// (.claude/channels/telegram/.env) held the working token. Contract pinned here:
// the channel state dir token FIRST (like channel-outage-alarm.sh); the install
// .env only as a fallback and only when token-shaped; a placeholder is never sent;
// no token value ever reaches stdout/stderr. The curl stub records argv AND stdin
// (the send library passes the URL with the token on stdin via "-K -").
const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'notify.sh')
const CHAN_TOKEN = '987654321:CHANNELTOKENCHANNELTOKEN_abc'
const ENV_TOKEN = '1234567890:ENVTOKENENVTOKENENVTOKEN'
const PLACEHOLDER = 'your_telegram_bot_token_here'
const REAL_CHAT = '1268077055'

let stage: string

function run(envToken: string | null, chanToken: string | null, chatId = '42', access?: unknown,
  opts: { provider?: string; legacyToken?: string } = {}) {
  const scriptsDir = join(stage, 'scripts')
  mkdirSync(join(scriptsDir, 'lib'), { recursive: true })
  const scriptCopy = join(scriptsDir, 'notify.sh')
  execFileSync('/bin/cp', [SCRIPT, scriptCopy])
  execFileSync('/bin/cp', [join(ROOT, 'scripts', 'lib', 'send-telegram.sh'), join(scriptsDir, 'lib', 'send-telegram.sh')])
  execFileSync('/bin/cp', [join(ROOT, 'scripts', 'lib', 'owner-chat.sh'), join(scriptsDir, 'lib', 'owner-chat.sh')])
  writeFileSync(join(stage, '.env'),
    (envToken === null ? '' : `TELEGRAM_BOT_TOKEN=${envToken}\n`) + `ALLOWED_CHAT_ID=${chatId}\nMAIN_AGENT_ID=mainbot\n`
    + (opts.provider ? `CHANNEL_PROVIDER=${opts.provider}\n` : ''))
  if (opts.legacyToken) {
    const legacy = join(stage, 'home', '.claude', 'channels', 'telegram')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '.env'), `TELEGRAM_BOT_TOKEN=${opts.legacyToken}\n`)
  }
  const chanDir = join(stage, '.claude', 'channels', 'telegram')
  if (chanToken !== null || access !== undefined) mkdirSync(chanDir, { recursive: true })
  if (chanToken !== null) writeFileSync(join(chanDir, '.env'), `TELEGRAM_BOT_TOKEN=${chanToken}\n`)
  if (access !== undefined) writeFileSync(join(chanDir, 'access.json'), JSON.stringify(access))
  const binDir = join(stage, 'bin')
  mkdirSync(binDir, { recursive: true })
  const argsFile = join(stage, 'curl-args')
  rmSync(argsFile, { force: true })  // several runs per test share the stage
  writeFileSync(join(binDir, 'curl'),
    `#!/bin/bash\nprintf '%s\\n' "$@" >> "${argsFile}"\ncat >> "${argsFile}"\nprintf '%s' '{"ok":true,"result":{"message_id":1}}'\n`)
  chmodSync(join(binDir, 'curl'), 0o755)
  const r = spawnSync('/bin/bash', [scriptCopy, 'probe'], {
    // node's own directory: notify.sh reads access.json with `node -e`, and on the CI runner
    // and on macOS node is not in /usr/bin (review on #3100: 41/42 there).
    env: { PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, VITEST: '1', HOME: join(stage, 'home') },
    encoding: 'utf-8',
  })
  const sent = existsSync(argsFile) ? readFileSync(argsFile, 'utf-8') : ''
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), sent }
}

beforeEach(() => { stage = mkdtempSync(join(tmpdir(), 'notify-token-')) })
afterEach(() => { rmSync(stage, { recursive: true, force: true }) })

describe('notify.sh bot token resolution (BOTTOKEN1124)', () => {
  it('the live case: placeholder in .env, working token in the channel dir -> channel token, sent', () => {
    const r = run(PLACEHOLDER, CHAN_TOKEN)
    expect(r.status).toBe(0)
    expect(r.sent).toContain(`bot${CHAN_TOKEN}/`)
    expect(r.sent).not.toContain(PLACEHOLDER)
    expect(r.out).not.toContain(CHAN_TOKEN)
  })

  it('the channel dir token wins even over a token-shaped .env value (same source as channel-outage-alarm.sh)', () => {
    const r = run(ENV_TOKEN, CHAN_TOKEN)
    expect(r.status).toBe(0)
    expect(r.sent).toContain(`bot${CHAN_TOKEN}/`)
    expect(r.sent).not.toContain(ENV_TOKEN)
  })

  it('no channel token: a token-shaped .env value is the fallback', () => {
    const r = run(ENV_TOKEN, null)
    expect(r.status).toBe(0)
    expect(r.sent).toContain(`bot${ENV_TOKEN}/`)
    expect(r.out).not.toContain(ENV_TOKEN)
  })

  it('POSITIVE CONTROL: placeholder and no channel token -> nothing is sent, loud failure, no placeholder on the wire', () => {
    const r = run(PLACEHOLDER, null)
    expect(r.sent).toBe('')
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('nem token alaku')
  })

  it('a placeholder in the channel dir is not taken either', () => {
    const r = run(PLACEHOLDER, 'another_placeholder')
    expect(r.sent).toBe('')
    expect(r.status).not.toBe(0)
  })

  it('no token anywhere (Slack-only install): unchanged, no Telegram call', () => {
    const r = run(null, null)
    expect(r.sent).toBe('')
    expect(r.out).toContain('TELEGRAM_BOT_TOKEN nincs beallitva')
  })

  it('the legacy shared ~/.claude/channels/telegram token (another install on the same user) is never taken', () => {
    const LEGACY = '555:LEGACYTOKENLEGACYTOKEN'
    const viaEnv = run(ENV_TOKEN, null, '42', undefined, { legacyToken: LEGACY })
    expect(viaEnv.sent).toContain(`bot${ENV_TOKEN}/`)
    expect(viaEnv.sent).not.toContain(LEGACY)
    const placeholder = run(PLACEHOLDER, null, '42', undefined, { legacyToken: LEGACY })
    expect(placeholder.sent).toBe('')
  })

  it('a non-Telegram install does not revive a leftover Telegram channel dir', () => {
    const r = run(null, CHAN_TOKEN, '42', undefined, { provider: 'slack' })
    expect(r.sent).not.toContain(CHAN_TOKEN)
    const tg = run(null, CHAN_TOKEN, '42', undefined, { provider: 'telegram' })
    expect(tg.sent).toContain(`bot${CHAN_TOKEN}/`)
  })

  it('placeholder ALLOWED_CHAT_ID falls back to the single DM in access.json (was "chat not found")', () => {
    const r = run(PLACEHOLDER, CHAN_TOKEN, 'your_telegram_chat_id', { allowFrom: [REAL_CHAT] })
    expect(r.status).toBe(0)
    expect(r.sent).toContain(`chat_id=${REAL_CHAT}`)
    expect(r.sent).not.toContain('your_telegram_chat_id')
  })
})
