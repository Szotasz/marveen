// GROMZONOPROVIDER1108 (Samu 73573): update.sh's ONE automatic provider migration. Only CHANNEL_PROVIDER=telegram with
// no bot token anywhere AND a linked mxd becomes gromzo; every other shape is untouched; it is idempotent and leaves
// CHANNEL_PROVIDER_PREV=telegram. The real script runs against a temp install dir and a fake mxd dash socket.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'gromzo-provider-migrate.mjs')
const servers: net.Server[] = []
afterAll(() => { for (const s of servers) s.close() })

/** A fake mxd dash socket answering `status` with the given `linked`. */
async function fakeMxd(linked: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'gpm-sock-'))
  const path = join(dir, 'dash.sock')
  const srv = net.createServer((c) => {
    c.on('data', (d) => {
      const req = JSON.parse(d.toString().split('\n')[0])
      c.write(JSON.stringify(req.verb === 'status' ? { ok: true, running: true, linked } : { ok: false }) + '\n')
    })
  })
  await new Promise<void>((r) => srv.listen(path, () => r()))
  servers.push(srv)
  return path
}

function install(envText: string, opts: { stateToken?: string; legacyToken?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gpm-inst-'))
  const home = mkdtempSync(join(tmpdir(), 'gpm-home-'))
  writeFileSync(join(root, '.env'), envText, { mode: 0o600 })
  if (opts.stateToken !== undefined) {
    mkdirSync(join(root, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(root, '.claude', 'channels', 'telegram', '.env'), `TELEGRAM_BOT_TOKEN=${opts.stateToken}\n`)
  }
  if (opts.legacyToken !== undefined) {
    mkdirSync(join(home, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(join(home, '.claude', 'channels', 'telegram', '.env'), `TELEGRAM_BOT_TOKEN=${opts.legacyToken}\n`)
  }
  return { root, home }
}

async function run(i: { root: string; home: string }, sock: string, extra: string[] = []): Promise<string> {
  // spawnSync would block this event loop, and the fake socket answers from it: the child runs async.
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, i.root, '--dash-sock', sock, '--home', i.home, ...extra])
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', () => resolve(out.trim()))
  })
}

const BRIDGE_ENV = 'MAIN_AGENT_ID=marveen\nCHANNEL_PROVIDER=telegram\nTELEGRAM_BOT_TOKEN=\nALLOWED_CHAT_ID=0\nCHANNEL_PLUGINS_EXTRA=gromzo-channel@gromzo-local\n'

describe('gromzo-provider-migrate: only the exact Bridge shape moves (GROMZONOPROVIDER1108)', () => {
  it('telegram + no token + linked mxd: migrated, PREV written, every other line kept, the mode kept, a marker', async () => {
    const i = install(BRIDGE_ENV)
    expect(await run(i, await fakeMxd(true))).toBe('gromzo-provider-migrate: migrated')
    const env = readFileSync(join(i.root, '.env'), 'utf8')
    expect(env).toBe('MAIN_AGENT_ID=marveen\nCHANNEL_PROVIDER=gromzo\nCHANNEL_PROVIDER_PREV=telegram\nTELEGRAM_BOT_TOKEN=\nALLOWED_CHAT_ID=0\nCHANNEL_PLUGINS_EXTRA=gromzo-channel@gromzo-local\n')
    expect(statSync(join(i.root, '.env')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(i.root, 'store', 'gromzo-provider-migrated.json'), 'utf8')).from).toBe('telegram')
  })

  it('idempotent: a second run leaves it exactly as it is', async () => {
    const i = install(BRIDGE_ENV)
    const sock = await fakeMxd(true)
    await run(i, sock)
    const after1 = readFileSync(join(i.root, '.env'), 'utf8')
    expect(await run(i, sock)).toBe('gromzo-provider-migrate: skip already-gromzo')
    expect(readFileSync(join(i.root, '.env'), 'utf8')).toBe(after1)
  })

  it('EXCLUDED: a Telegram bot token in the install file', async () => {
    const i = install(BRIDGE_ENV.replace('TELEGRAM_BOT_TOKEN=\n', 'TELEGRAM_BOT_TOKEN=123:abc\n'))
    expect(await run(i, await fakeMxd(true))).toBe('gromzo-provider-migrate: skip has-token')
    expect(readFileSync(join(i.root, '.env'), 'utf8')).toContain('CHANNEL_PROVIDER=telegram\n')
  })

  it('EXCLUDED: a token in the install-scoped or the legacy channel state dir', async () => {
    for (const opt of [{ stateToken: '123:abc' }, { legacyToken: '123:abc' }]) {
      const i = install(BRIDGE_ENV, opt)
      expect(await run(i, await fakeMxd(true))).toBe('gromzo-provider-migrate: skip has-token')
      expect(readFileSync(join(i.root, '.env'), 'utf8')).toBe(BRIDGE_ENV)
    }
  })

  it('EXCLUDED: mxd not linked, and no mxd at all', async () => {
    const i = install(BRIDGE_ENV)
    expect(await run(i, await fakeMxd(false))).toBe('gromzo-provider-migrate: skip mxd-not_linked')
    expect(await run(i, join(mkdtempSync(join(tmpdir(), 'gpm-none-')), 'dash.sock'))).toBe('gromzo-provider-migrate: skip mxd-not_running')
    expect(readFileSync(join(i.root, '.env'), 'utf8')).toBe(BRIDGE_ENV)
    expect(existsSync(join(i.root, 'store', 'gromzo-provider-migrated.json'))).toBe(false)
  })

  it('EXCLUDED: another provider, or no CHANNEL_PROVIDER line (a hand-edited file)', async () => {
    const sock = await fakeMxd(true)
    const slack = install(BRIDGE_ENV.replace('CHANNEL_PROVIDER=telegram', 'CHANNEL_PROVIDER=slack'))
    expect(await run(slack, sock)).toBe('gromzo-provider-migrate: skip provider-not-telegram')
    const unset = install(BRIDGE_ENV.replace('CHANNEL_PROVIDER=telegram\n', ''))
    expect(await run(unset, sock)).toBe('gromzo-provider-migrate: skip provider-unset')
  })

  it('--dry-run says it would, and writes nothing', async () => {
    const i = install(BRIDGE_ENV)
    expect(await run(i, await fakeMxd(true), ['--dry-run'])).toBe('gromzo-provider-migrate: would-migrate')
    expect(readFileSync(join(i.root, '.env'), 'utf8')).toBe(BRIDGE_ENV)
  })

  it('update.sh runs it in its unit maintenance, after the secret scrub', () => {
    const u = readFileSync(join(__dirname, '..', '..', 'update.sh'), 'utf8')
    expect(u).toMatch(/run_unit_maintenance\(\) \{[\s\S]*?scrub_rc_secrets\n  migrate_gromzo_provider\n  return 0\n\}/)
    expect(u).toContain('node "$INSTALL_DIR/scripts/gromzo-provider-migrate.mjs" "$INSTALL_DIR" 2>/dev/null || true')
  })
})

