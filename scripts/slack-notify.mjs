#!/usr/bin/env node
// slack-notify.mjs -- post a notification to Slack (SLACKATALLAS1006).
//
//   node scripts/slack-notify.mjs --to <dm|channel-name|C...> [--as <agent>] "text"
//   node scripts/slack-notify.mjs --kind owner|alert [--as <agent>] "text"   # target from settings
//   ... "-" reads the text from stdin.
//
// --to: "dm" (the owner's DM, opened from the owner's user id), a name from
// store/slack-channels.json, or a raw C/G/D id. --kind: use NOTIFY_SLACK_TARGET
// (owner) or NOTIFY_SLACK_ALERT_TARGET (alert) from the settings. --as: the
// sending agent (its own Slack bot posts; without its own token, or when the
// bot is not in the channel, the main agent's bot posts with "[<agent>]" in
// front). Default --as: the agent of the current tmux session (agent-<name>),
// else the main agent.
//
// Prints ONE JSON line. Exit 0 = sent; 2 = nothing to do (no target
// configured, --kind only); 1 = delivery failed or bad usage. The same code
// path as the dashboard's notifications (dist/slack-notify.js).
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(code) }

const args = process.argv.slice(2)
let to = null, kind = null, as = null
const rest = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--to') to = args[++i]
  else if (a === '--kind') kind = args[++i]
  else if (a === '--as') as = args[++i]
  else if (a === '--') { rest.push(...args.slice(i + 1)); break }
  else rest.push(a)
}
let text = rest.join(' ')
if (text === '-') text = await new Promise((r) => { let d = ''; process.stdin.setEncoding('utf-8'); process.stdin.on('data', (c) => { d += c }); process.stdin.on('end', () => r(d)) })
if (!text.trim()) out({ ok: false, error: 'usage: empty text' }, 1)
if (!to && !kind) out({ ok: false, error: 'usage: --to or --kind required' }, 1)
if (kind && kind !== 'owner' && kind !== 'alert') out({ ok: false, error: 'usage: --kind owner|alert' }, 1)

if (!as && process.env.TMUX) {
  try {
    const s = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8', timeout: 3000 }).trim()
    if (s.startsWith('agent-')) as = s.slice('agent-'.length)
  } catch { /* no session name -> main agent */ }
}

const { sendSlackNotification } = await import(join(root, 'dist', 'slack-notify.js'))
const { getEffectiveSettingValue } = await import(join(root, 'dist', 'settings-store.js'))
const setting = (k) => { try { return String(getEffectiveSettingValue(k) ?? '').trim() } catch { return '' } }

if (!to) {
  to = kind === 'alert' ? (setting('NOTIFY_SLACK_ALERT_TARGET') || setting('NOTIFY_SLACK_TARGET')) : setting('NOTIFY_SLACK_TARGET')
  if (!to) out({ ok: false, skipped: true, reason: 'no Slack target configured', telegram: setting('NOTIFY_TELEGRAM_FALLBACK') === '0' ? 'skip' : 'send' }, 2)
}
const { markIfTestRun } = await import(join(root, 'dist', 'test-run-marker.js'))
// Same rule as the Telegram funnel: a test run sends a REAL, labelled message.
const r = await sendSlackNotification(to, markIfTestRun(text), { sender: as || undefined, ownerUserId: setting('SLACK_OWNER_USER_ID') })
// For notify.sh: whether Telegram should ALSO go out. On a Slack failure it is the
// fallback, unless NOTIFY_TELEGRAM_FALLBACK=0 (then never, and notify.sh fails loudly).
const telegram = r.ok
  ? (setting('NOTIFY_TELEGRAM') !== '0' ? 'send' : 'skip')
  : (setting('NOTIFY_TELEGRAM_FALLBACK') === '0' ? 'skip' : 'send')
out({ ...r, target: to, sender: as || 'main', telegram }, r.ok ? 0 : 1)
