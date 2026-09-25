// scripts/patch-telegram-plugin.py (ELSOKOR922 spec D-4): takes /status and
// /help away from the Telegram channel plugin so the command hook can answer
// them. Run for real on a copy of the 0.0.7 plugin excerpt (verbatim blocks,
// fixtures/telegram-plugin-0.0.7/server.ts.txt) in a scratch plugins cache.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'tg-plugin-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[] = []): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...extra, cache], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function readState(file: string): { root: string; files: Array<{ version: string; path: string; status: string }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('patch-telegram-plugin.py', () => {
  it('1st run patches: /help, /status handlers and the plugin menu gone, /start kept, still parses', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*server\.ts/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain("bot.command('help'")
    expect(text).not.toContain("bot.command('status'")
    expect(text).not.toContain('bot.api.setMyCommands(')
    expect(text).not.toContain('Paired as')
    expect(text).toContain("bot.command('start'")
    expect(text.match(/MARVEEN-PATCH\(elsokor922-d4\)/g)).toHaveLength(3)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('2nd run is a no-op: returns `already`, byte-identical, silent', () => {
    const state = join(cache, 'state.json')
    run(['--state', state])
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'patched' }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'already' }])
  })

  it('a changed anchor (plugin update): loud line, file left byte-identical, exit 0', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace("bot.command('status', async ctx => {", "bot.command('status', async (ctx) => {")
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: status handler not found exactly once/)
    expect(readFileSync(server, 'utf-8')).toBe(changed)
    expect(readState(state).files[0].status).toBe('anchor-missing:status handler')
  })

  it('writes exactly one cache: $CLAUDE_CONFIG_DIR when set, the user-level ~/.claude never on top', () => {
    const home = mkdtempSync(join(tmpdir(), 'tg-plugin-home-'))
    try {
      const userDir = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(userDir, { recursive: true })
      const userServer = join(userDir, 'server.ts')
      copyFileSync(FIXTURE, userServer)
      // cache = <cfg>/plugins/cache, so its config dir is two levels up
      const cfg = join(cache, 'cfg')
      const cfgDir = join(cfg, 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(cfgDir, { recursive: true })
      const cfgServer = join(cfgDir, 'server.ts')
      copyFileSync(FIXTURE, cfgServer)
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg }
      const r = spawnSync('python3', [SCRIPT], { encoding: 'utf-8', env })
      expect(r.status).toBe(0)
      expect(readFileSync(cfgServer, 'utf-8')).toContain('MARVEEN-PATCH(elsokor922-d4)')
      expect(readFileSync(userServer, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
      // without CLAUDE_CONFIG_DIR the user-level cache IS the launch cache
      const { CLAUDE_CONFIG_DIR: _unset, ...noCfg } = env
      spawnSync('python3', [SCRIPT], { encoding: 'utf-8', env: noCfg })
      expect(readFileSync(userServer, 'utf-8')).toContain('MARVEEN-PATCH(elsokor922-d4)')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('no plugin cache at all: exit 0, nothing to do', () => {
    const r = spawnSync('python3', [SCRIPT, join(cache, 'does-not-exist')], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })

  it('an unwritable file: named in the log, exit 0 (the channel still starts)', () => {
    const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
    spawnSync('chmod', ['a-w', dir])
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/cannot write .*left unpatched/)
      expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
    } finally {
      spawnSync('chmod', ['u+w', dir])
    }
  })
})

describe('channels.sh wiring (review #1529, point 1)', () => {
  const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  const code = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')

  it('calls the patcher for Telegram, with the state file, before the session (and so the plugin) is spawned', () => {
    const call = code.indexOf('scripts/patch-telegram-plugin.py" --state "$INSTALL_DIR/store/telegram-plugin-patch.json"')
    const spawn = code.indexOf('$TMUX new-session -d -s "$SESSION"')
    expect(call).toBeGreaterThan(0)
    expect(spawn).toBeGreaterThan(call)
    // guarded by the Telegram provider check, directly: no other block in between
    const cond = code.lastIndexOf('if [ "$CHANNEL_PROVIDER" = "telegram" ]; then', call)
    expect(cond).toBeGreaterThan(0)
    expect(code.slice(cond, call).split('\n').length).toBeLessThanOrEqual(3)
    // both branches (own config dir / inherited one) write the state file
    expect(code.split('scripts/patch-telegram-plugin.py" --state "$INSTALL_DIR/store/telegram-plugin-patch.json"').length - 1).toBe(2)
  })

  it('an isolated/explicit config dir is handed to the patcher, so it writes the cache the session launches from', () => {
    expect(code).toMatch(/if \[ -n "\$CFG_ENV" \]; then\n\s*CLAUDE_CONFIG_DIR="\$_cfg_dir" python3 "\$INSTALL_DIR\/scripts\/patch-telegram-plugin\.py"/)
  })
})
