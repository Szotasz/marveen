#!/usr/bin/env node
// GROMZONOPROVIDER1108 (Samu 73573): the ONE automatic channel-provider migration update.sh runs.
//
// A Bridge (Gromzo) install used to be written as CHANNEL_PROVIDER=telegram with no bot token (the Bridge passed no
// provider, the installer took its default). Its main channels session then started a Telegram plugin that could never
// run, and restarted in a loop. This moves EXACTLY that shape to CHANNEL_PROVIDER=gromzo, and nothing else:
//   - CHANNEL_PROVIDER is explicitly `telegram` in the install's environment file (unset or any other value: untouched);
//   - no Telegram bot token anywhere the main channel reads one (the install file, the install-scoped and the legacy
//     channel state dir): a token means a real Telegram install, untouched;
//   - mxd answers on its dash socket and says it is linked to the owner's Gromzo team (no mxd, not reachable, or not
//     linked: untouched).
// Idempotent: an install already on gromzo is left as it is. Reversible: CHANNEL_PROVIDER_PREV=telegram is written next
// to it. The dashboard tells the owner once, through the main agent (store/gromzo-provider-migrated.json).
//
//   node scripts/gromzo-provider-migrate.mjs <install dir> [--dash-sock <path>] [--dry-run] [--home <dir>]
// Prints one line: `gromzo-provider-migrate: migrated` or `gromzo-provider-migrate: skip <reason>`; exit 0 either way
// (an update must never fail on it), 2 on a bad call.
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import net from 'node:net'

const DASH_SOCK_DEFAULT = process.platform === 'darwin'
  ? '/Library/Application Support/Marveen/mxd-run/dash.sock'
  : '/run/marveen-mxd/dash.sock'

function parseArgs(argv) {
  const out = { installDir: null, dashSock: null, dryRun: false, home: homedir() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--dash-sock') out.dashSock = argv[++i]
    else if (a === '--home') out.home = argv[++i]
    else if (!out.installDir && !a.startsWith('--')) out.installDir = a
    else return null
  }
  return out.installDir ? out : null
}

/** KEY=VALUE lines -> the LAST value per key, quotes stripped (the way the launchers read it). */
function readEnvKeys(path) {
  const keys = {}
  let raw
  try { raw = readFileSync(path, 'utf8') } catch { return null }
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    keys[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return keys
}

function mxdLinked(sockPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); sock.destroy(); resolve(v) } }
    const sock = net.createConnection({ path: sockPath })
    const t = setTimeout(() => finish('timeout'), timeoutMs)
    let buf = ''
    sock.on('connect', () => sock.write(JSON.stringify({ verb: 'status' }) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      if (buf.length > 65536) return finish('oversized')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      try {
        const r = JSON.parse(buf.slice(0, nl))
        finish(r && r.linked === true ? 'linked' : 'not_linked')
      } catch { finish('malformed') }
    })
    sock.on('error', () => finish('not_running'))
    sock.on('close', () => finish('closed'))
  })
}

/** Rewrites the file with CHANNEL_PROVIDER=gromzo and CHANNEL_PROVIDER_PREV=telegram, every other line as it was;
 *  a temp file next to it, its mode kept, then a rename. */
function writeMigrated(path) {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n')
  const out = []
  for (const line of lines) {
    if (/^CHANNEL_PROVIDER_PREV=/.test(line)) continue
    if (/^CHANNEL_PROVIDER=/.test(line)) {
      out.push('CHANNEL_PROVIDER=gromzo')
      out.push('CHANNEL_PROVIDER_PREV=telegram')
      continue
    }
    out.push(line)
  }
  const mode = statSync(path).mode & 0o777
  const tmp = `${path}.gromzo-migrate.${process.pid}`
  writeFileSync(tmp, out.join('\n'), { mode })
  renameSync(tmp, path)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) { console.error('usage: gromzo-provider-migrate.mjs <install dir> [--dash-sock <path>] [--dry-run] [--home <dir>]'); process.exit(2) }
  const say = (m) => console.log(`gromzo-provider-migrate: ${m}`)
  const envPath = join(args.installDir, '.env')
  const env = readEnvKeys(envPath)
  if (!env) return say('skip no-env-file')
  const provider = env.CHANNEL_PROVIDER
  if (provider === 'gromzo') return say('skip already-gromzo')
  if (provider !== 'telegram') return say(`skip provider-${provider === undefined ? 'unset' : 'not-telegram'}`)
  if ((env.TELEGRAM_BOT_TOKEN ?? '') !== '') return say('skip has-token')
  for (const dir of [join(args.installDir, '.claude', 'channels', 'telegram'), join(args.home, '.claude', 'channels', 'telegram')]) {
    const ch = readEnvKeys(join(dir, '.env'))
    if (ch && (ch.TELEGRAM_BOT_TOKEN ?? '') !== '') return say('skip has-token')
  }
  const sock = args.dashSock ?? ((env.MXD_DASH_SOCK ?? '') || DASH_SOCK_DEFAULT)
  const link = await mxdLinked(sock)
  if (link !== 'linked') return say(`skip mxd-${link}`)
  // GROMZOPLUGREG1109 (Samu 73877): a linked mxd is not enough. Without the Gromzo plugin registered for Claude Code
  // (the shared installed_plugins.json the dashboard writes) the migrated session would start --channels with no plugin
  // server and the down cascade would restart it. The same plain key test as main_gromzo_plugin_registered.
  let plugins = ''
  try { plugins = readFileSync(join(args.home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8') } catch { plugins = '' }
  if (!plugins.includes('"gromzo-channel@gromzo-local"')) return say('skip plugin-not-registered')
  if (args.dryRun) return say('would-migrate')
  writeMigrated(envPath)
  const store = join(args.installDir, 'store')
  try {
    if (!existsSync(store)) mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'gromzo-provider-migrated.json'), JSON.stringify({ at: new Date().toISOString(), from: 'telegram' }) + '\n', { mode: 0o600 })
  } catch { /* the notice is best-effort; the migration itself is done */ }
  return say('migrated')
}

main().catch((err) => { console.log(`gromzo-provider-migrate: skip error ${err && err.code ? err.code : 'unknown'}`) })
