// DCPLUGIN006 (1123): Marveen's Discord overlay ported onto the official plugin 0.0.6. Before this, a 0.0.6
// cache was "not a plugin version this install knows": left as shipped, every DCEXT1111 addition off.
// The port is the 0.0.4 overlay three-way merged onto 0.0.6 (base: 0.0.4 upstream). One conflict: 0.0.6
// ships its own create_thread tool, and the overlay already had one (DCEXT1111 F5), so the overlay's stays
// and upstream's definition and case are dropped (a MARVEEN-PATCH(dc006) line marks the spot).
// The patcher itself is version-agnostic and covered for 0.0.4 in patch-discord-plugin.test.ts; this file
// runs it for real on a verbatim 0.0.6 server.ts in a scratch plugins cache.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-discord-plugin.py')
const V4 = join(ROOT, 'vendor', 'discord-plugin', '0.0.4')
const V6 = join(ROOT, 'vendor', 'discord-plugin', '0.0.6')
const UPSTREAM = join(V6, 'upstream', 'server.ts')
const OVERLAY = join(V6, 'overlay')
const UPSTREAM_SHA = '400387f4dd86ca1fea85a15a545ff8a486efaccffc7ee46c67b29f889904a515'
const MARK = /MARVEEN-(PATCH|EXT)/

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const read = (p: string) => readFileSync(p, 'utf-8')

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('the vendored 0.0.6 plugin', () => {
  it('upstream/server.ts is the verbatim 0.0.6 file (pinned sha256), with upstream\'s LICENSE', () => {
    expect(sha(readFileSync(UPSTREAM))).toBe(UPSTREAM_SHA)
    expect(read(join(V6, 'LICENSE'))).toBe(read(join(V4, 'LICENSE')))
  })

  it('the overlay parses, and every line it adds or changes is marked', () => {
    const ov = read(join(OVERLAY, 'server.ts'))
    expect(syntaxErrors(ov)).toEqual([])
    const upSet = new Set(read(UPSTREAM).split('\n'))
    expect(ov.split('\n').filter(l => !upSet.has(l) && !MARK.test(l))).toEqual([])
  })

  it('nothing of the 0.0.4 overlay is lost: every marked line is still there', () => {
    const ov6 = new Set(read(join(OVERLAY, 'server.ts')).split('\n'))
    const lost = read(join(V4, 'overlay', 'server.ts')).split('\n').filter(l => MARK.test(l) && !ov6.has(l))
    expect(lost).toEqual([])
  })

  it('marveen-ext.ts is the 0.0.4 one, so its tests (discord-plugin-ext, patch-discord-plugin) cover it', () => {
    expect(readdirSync(OVERLAY).sort()).toEqual(['marveen-ext.ts', 'server.ts'])
    expect(read(join(OVERLAY, 'marveen-ext.ts'))).toBe(read(join(V4, 'overlay', 'marveen-ext.ts')))
  })

  it('0.0.6\'s own additions are kept: list_emojis, and the thread-starter message is skipped', () => {
    const ov = read(join(OVERLAY, 'server.ts'))
    expect(ov).toContain("name: 'list_emojis'")
    expect(ov).toContain("case 'list_emojis': {")
    expect(ov).toContain('if (msg.type === MessageType.ThreadStarterMessage) return')
  })

  it('one create_thread tool and one handler: the overlay\'s, upstream\'s dropped where marked', () => {
    const ov = read(join(OVERLAY, 'server.ts'))
    expect(ov.match(/name: 'create_thread'/g)).toHaveLength(1)
    expect(ov.match(/case 'create_thread'/g)).toHaveLength(1)
    expect(ov).toContain("name: 'create_thread', // MARVEEN-EXT")
    expect(ov).toContain("case 'create_thread': { // MARVEEN-EXT")
    expect(ov).toContain('MARVEEN-PATCH(dc006)')
  })
})

describe('patch-discord-plugin.py on a 0.0.6 cache', () => {
  let cache = ''
  let dir = ''
  let server = ''
  let install = ''
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'dc6-plugin-cache-'))
    dir = join(cache, 'claude-plugins-official', 'discord', '0.0.6')
    mkdirSync(dir, { recursive: true })
    server = join(dir, 'server.ts')
    copyFileSync(UPSTREAM, server)
    install = mkdtempSync(join(tmpdir(), 'dc6-install-'))
    mkdirSync(join(install, 'store'))
  })
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true })
    rmSync(install, { recursive: true, force: true })
  })
  const run = () => spawnSync('python3', [SCRIPT, '--install', install, cache], { encoding: 'utf-8', timeout: 30_000 })

  it('the verbatim 0.0.6 file gets the 0.0.6 overlay, byte-identical, no "unknown version" line', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/overlaid .*server\.ts \(Marveen's Discord plugin 0\.0\.6, from upstream\)/)
    expect(r.stderr).not.toContain('not a plugin version this install knows')
    for (const n of readdirSync(OVERLAY)) expect(read(join(dir, n))).toBe(read(join(OVERLAY, n)))
    expect(JSON.parse(read(join(dir, '.marveen-overlay.json'))).upstream).toBe(UPSTREAM_SHA)
  })

  it('2nd run: already, nothing rewritten', () => {
    run()
    const before = read(server)
    const r = run()
    expect(r.status).toBe(0)
    expect(read(server)).toBe(before)
  })

  it('the off switch puts the verbatim 0.0.6 file back, everything we wrote removed', () => {
    run()
    writeFileSync(join(install, 'store', 'config-overrides.json'), JSON.stringify({ DISCORD_PLUGIN_EXT: '0' }))
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/restored .*server\.ts to the official plugin 0\.0\.6/)
    expect(sha(readFileSync(server))).toBe(UPSTREAM_SHA)
    expect(readdirSync(dir)).toEqual(['server.ts'])
  })
})
