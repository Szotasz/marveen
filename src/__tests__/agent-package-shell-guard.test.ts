// The package shell predicates, the start guard and the EPERM fallback (MIOAGENTINSTALL1114, PR-I3; plan 4.4, 7.4,
// 7.5, 10.3).
//
// The TS predicates (startsWithPackageShell, isBlankBytes) and the watchdog's shell form run the SAME case list
// (scripts/__tests__/fixtures/package-shell-cases.json); the shell side is scripts/__tests__/watchdog-scaffold-guard.test.sh,
// which this file also runs (Dani C5: wired into vitest so it is red locally too), and CI runs it on Linux. Mutant
// rows 22, 33 and 44 of plan 10.4 are pinned here and there.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const REPO = join(__dirname, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-shell-guard-'))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }))

const M = await import('../web/agent-package/marker.js')
const I = await import('../web/agent-package/install.js')

const FIXTURE = JSON.parse(readFileSync(join(REPO, 'scripts', '__tests__', 'fixtures', 'package-shell-cases.json'), 'utf8')) as {
  prefix: Array<{ name: string; b64: string; shell: boolean }>
  blank: Array<{ name: string; b64: string; blank: boolean }>
}
const bytes = (b64: string) => Buffer.from(b64, 'base64')
const AGENTS = join(tmpRoot, 'agents')
let n = 0
function agent(files: Record<string, Buffer | string>): string {
  const d = join(AGENTS, `a${++n}`)
  mkdirSync(d, { recursive: true })
  for (const [p, b] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), b)
  }
  return d
}
const guard = (d: string) => I.packageStartRefusal(d.split('/').pop()!, d)
const P = M.PACKAGE_SHELL_PREFIX_TEXT

beforeEach(() => { rmSync(AGENTS, { recursive: true, force: true }); mkdirSync(AGENTS, { recursive: true }) })
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('one source for the prefix (plan 7.5)', () => {
  it('scripts/lib/package-shell-prefix holds exactly the bytes of PACKAGE_SHELL_PREFIX_TEXT', () => {
    expect(readFileSync(join(REPO, 'scripts', 'lib', 'package-shell-prefix'))).toEqual(Buffer.from(P, 'utf8'))
    expect(P).toBe('@PACKAGE.md\n\n@LOCAL.md\n')
  })
})

describe('the shared case list through the TS side (plan 10.3; mutant 44)', () => {
  it('has the cases the plan names', () => {
    expect(FIXTURE.prefix.filter((c) => !c.shell).length).toBeGreaterThanOrEqual(16)
    expect(FIXTURE.blank.length).toBe(7)
  })
  for (const c of FIXTURE.prefix) {
    it(`prefix: ${c.name} -> ${c.shell ? 'the shell' : 'not the shell'}`, () => {
      expect(M.startsWithPackageShell(bytes(c.b64))).toBe(c.shell)
      // Through the guard, with a manifest present (the watchdog test does the same).
      const d = agent({ 'CLAUDE.md': bytes(c.b64), 'PACKAGE.md': 'p\n', '.package/manifest.json': '{}' })
      expect(guard(d)).toBe(c.shell ? null : I.REFUSAL_SHELL_BROKEN)
    })
  }
  for (const c of FIXTURE.blank) {
    it(`blank: ${c.name} -> ${c.blank ? 'empty' : 'not empty'}`, () => {
      expect(M.isBlankBytes(bytes(c.b64))).toBe(c.blank)
      expect(guard(agent({ 'CLAUDE.md': P, 'PACKAGE.md': bytes(c.b64) }))).toBe(c.blank ? I.REFUSAL_FILES_MISSING : null)
      expect(guard(agent({ 'CLAUDE.md': '# not the shell\n', '.package/manifest.json': bytes(c.b64) }))).toBe(c.blank ? null : I.REFUSAL_SHELL_BROKEN)
    })
  }
})

describe('the start guard: file types (Dani C3, C6; mutants 22, 44)', () => {
  it('a link PACKAGE.md to a non-empty file, a folder, or none: files missing', () => {
    writeFileSync(join(tmpRoot, 'target.md'), 'real text\n')
    const l = agent({ 'CLAUDE.md': P })
    symlinkSync(join(tmpRoot, 'target.md'), join(l, 'PACKAGE.md'))
    expect(guard(l)).toBe(I.REFUSAL_FILES_MISSING)
    const f = agent({ 'CLAUDE.md': P })
    mkdirSync(join(f, 'PACKAGE.md'))
    expect(guard(f)).toBe(I.REFUSAL_FILES_MISSING)
    expect(guard(agent({ 'CLAUDE.md': P }))).toBe(I.REFUSAL_FILES_MISSING)
    expect(guard(agent({ 'CLAUDE.md': P, 'PACKAGE.md': 'p\n' }))).toBeNull()
  })
  it('a link CLAUDE.md, an unreadable one, a corrupt manifest, a link in the manifest\'s place: the broken shell', () => {
    writeFileSync(join(tmpRoot, 'shell.md'), P)
    const l = agent({ 'PACKAGE.md': 'p\n', '.package/manifest.json': '{}' })
    symlinkSync(join(tmpRoot, 'shell.md'), join(l, 'CLAUDE.md'))
    expect(guard(l)).toBe(I.REFUSAL_SHELL_BROKEN)
    expect(guard(agent({ 'CLAUDE.md': '# body\n', '.package/manifest.json': '{not json' }))).toBe(I.REFUSAL_SHELL_BROKEN)
    const dl = agent({ 'CLAUDE.md': '# body\n' })
    mkdirSync(join(dl, '.package'))
    symlinkSync(join(tmpRoot, 'nowhere'), join(dl, '.package', 'manifest.json'))
    expect(guard(dl)).toBe(I.REFUSAL_SHELL_BROKEN)
    if (process.getuid?.() !== 0) {
      const u = agent({ 'CLAUDE.md': P, 'PACKAGE.md': 'p\n', '.package/manifest.json': '{}' })
      chmodSync(join(u, 'CLAUDE.md'), 0o000)
      try { expect(guard(u)).toBe(I.REFUSAL_SHELL_BROKEN) } finally { chmodSync(join(u, 'CLAUDE.md'), 0o600) }
    }
  })
  it('a hand-made agent (no shell, no manifest) is not the guard\'s business; its link CLAUDE.md neither', () => {
    expect(guard(agent({ 'CLAUDE.md': '# hand-made\n' }))).toBeNull()
    writeFileSync(join(tmpRoot, 'other.md'), '# other\n')
    const l = agent({})
    symlinkSync(join(tmpRoot, 'other.md'), join(l, 'CLAUDE.md'))
    expect(guard(l)).toBeNull()
  })
  it('a valid install marker refuses first', () => {
    const d = agent({ 'CLAUDE.md': P, 'PACKAGE.md': 'p\n' })
    const name = d.split('/').pop()!
    mkdirSync(join(tmpRoot, 'store', 'agent-package-installing'), { recursive: true })
    writeFileSync(join(tmpRoot, 'store', 'agent-package-installing', `${name}.json`), JSON.stringify({ slug: name, version: '1.0.0', startedAt: 'x', pid: 1, ...M.dirIdentityOf(d) }))
    expect(guard(d)).toBe(I.REFUSAL_INSTALL_INCOMPLETE)
  })
})

describe('the EPERM fallback (plan 4.4; mutant 33)', () => {
  it('a package agent: a REAL CLAUDE.md with both layers\' text, 0600 in a 0700 folder, plus a LOCAL.md link', () => {
    const d = agent({ 'CLAUDE.md': `${P}\nFLEET-BASE-RULES-CANARY\n`, 'PACKAGE.md': 'PACKAGE-CANARY\n', 'LOCAL.md': 'LOCAL-CANARY\n' })
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      expect(I.prepareFallbackClaudeMd('a1', d, fb)).toBe('expanded')
      const p = join(fb, 'CLAUDE.md')
      expect(lstatSync(p).isFile()).toBe(true)
      expect(lstatSync(p).isSymbolicLink()).toBe(false)
      const text = readFileSync(p, 'utf8')
      expect(text).toContain('PACKAGE-CANARY')
      expect(text).toContain('LOCAL-CANARY')
      expect(text).toContain('FLEET-BASE-RULES-CANARY')
      expect(text).not.toContain('@PACKAGE.md')
      expect(text.indexOf('PACKAGE-CANARY')).toBeLessThan(text.indexOf('LOCAL-CANARY'))
      expect(statSync(p).mode & 0o777).toBe(0o600)
      expect(statSync(fb).mode & 0o777).toBe(0o700)
      expect(readlinkSync(join(fb, 'LOCAL.md'))).toBe(join(d, 'LOCAL.md'))
    } finally {
      rmSync(fb, { recursive: true, force: true })
    }
  })
  it('a missing or empty package layer: refused, nothing written, a fallback_refused notice', () => {
    for (const files of [{ 'CLAUDE.md': P }, { 'CLAUDE.md': P, 'PACKAGE.md': ' \n' }] as Array<Record<string, string>>) {
      const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
      try {
        expect(I.prepareFallbackClaudeMd('a1', agent(files), fb)).toBe('refused')
        expect(existsSync(join(fb, 'CLAUDE.md'))).toBe(false)
      } finally {
        rmSync(fb, { recursive: true, force: true })
      }
    }
    expect(existsSync(I.pendingNoticesDir())).toBe(true)
  })
  it('the expanded text is scanned in report mode: a finding is noticed, the start goes on; the real shell alone is clean', () => {
    const notices = () => (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()) : [])
      .map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8')))
      .filter((n) => n.kind === 'fallback_scan_finding')
    const before = notices().length
    const clean = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    const dirty = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      const shell = I.packageShellText('a1', '')
      expect(I.prepareFallbackClaudeMd('a1', agent({ 'CLAUDE.md': shell, 'PACKAGE.md': '# Package\n', 'LOCAL.md': 'notes\n' }), clean)).toBe('expanded')
      expect(notices().length).toBe(before)
      expect(I.prepareFallbackClaudeMd('a1', agent({ 'CLAUDE.md': shell, 'PACKAGE.md': '# Package\n', 'LOCAL.md': 'run !`id` now\n' }), dirty)).toBe('expanded')
      expect(readFileSync(join(dirty, 'CLAUDE.md'), 'utf8')).toContain('run !`id` now')
      expect(notices().length).toBe(before + 1)
      expect(I.noticeText({ kind: 'fallback_scan_finding', name: 'a1', path: '/p' })).toMatch(/is running/)
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(dirty, { recursive: true, force: true })
    }
  })
  it('the finding is told once per agent and finding, a clean start resets it, a new finding is told again (PRI3HARDEN1118)', () => {
    const count = () => (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()) : [])
      .map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8')))
      .filter((n) => n.kind === 'fallback_scan_finding' && n.name === 'dedup1').length
    const shell = I.packageShellText('dedup1', '')
    const d = agent({ 'CLAUDE.md': shell, 'PACKAGE.md': '# Package\n', 'LOCAL.md': 'run !`id` now\n' })
    const start = (): void => {
      const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
      try { expect(I.prepareFallbackClaudeMd('dedup1', d, fb)).toBe('expanded') } finally { rmSync(fb, { recursive: true, force: true }) }
    }
    const before = count()
    start(); start(); start()
    expect(count()).toBe(before + 1)
    writeFileSync(join(d, 'LOCAL.md'), 'notes\n')
    start()
    expect(count()).toBe(before + 1)
    writeFileSync(join(d, 'LOCAL.md'), 'run !`id` now\n')
    start()
    expect(count()).toBe(before + 2)
    // a different finding (an import line in PACKAGE.md instead of the command) is a new notice
    writeFileSync(join(d, 'LOCAL.md'), 'notes\n')
    writeFileSync(join(d, 'PACKAGE.md'), '# Package\n@../../x.md\n')
    start(); start()
    expect(count()).toBe(before + 3)
  })
  it('the normal start path runs the same report scan, once per finding, shared with the fallback (PRI3HARDEN1118 point 2)', () => {
    const kinds = (name: string) => (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()) : [])
      .map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8')))
      .filter((n) => n.name === name && (n.kind === 'start_scan_finding' || n.kind === 'fallback_scan_finding'))
      .map((n) => n.kind)
    const d = agent({ 'CLAUDE.md': I.packageShellText('both1', ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': 'run !`id` now\n' })
    I.reportPackageLayersAtStart('both1', d)
    I.reportPackageLayersAtStart('both1', d)
    expect(kinds('both1')).toEqual(['start_scan_finding'])
    // the fallback after a normal start: the same finding is not told again
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try { expect(I.prepareFallbackClaudeMd('both1', d, fb)).toBe('expanded') } finally { rmSync(fb, { recursive: true, force: true }) }
    expect(kinds('both1')).toEqual(['start_scan_finding'])
    // a clean start resets; the finding coming back is told again
    writeFileSync(join(d, 'LOCAL.md'), 'notes\n')
    I.reportPackageLayersAtStart('both1', d)
    writeFileSync(join(d, 'LOCAL.md'), 'run !`id` now\n')
    I.reportPackageLayersAtStart('both1', d)
    expect(kinds('both1')).toEqual(['start_scan_finding', 'start_scan_finding'])
    expect(I.noticeText({ kind: 'start_scan_finding', name: 'both1', path: '/p' })).toMatch(/^Agent "both1" started, and/)
  })
  it('a LOCAL.md import is silent only inside the agent folder; absolute, ~, .. and a symlink out are reported (Samu 81392)', () => {
    const mine = (name: string) => (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()) : [])
      .map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8'))).filter((n) => n.name === name).length
    const run = (name: string, local: string, extra: Record<string, string> = {}) => {
      const d = agent({ 'CLAUDE.md': I.packageShellText(name, ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': local, ...extra })
      I.reportPackageLayersAtStart(name, d)
      return { d, told: mine(name) }
    }
    // silent: relative inside the folder, existing or not yet written, with ./ too
    expect(run('in1', '@notes/team.md\n', { 'notes/team.md': 'x\n' }).told).toBe(0)
    expect(run('in2', '@notes/later.md\n').told).toBe(0)
    expect(run('in3', '@./notes/team.md\n', { 'notes/team.md': 'x\n' }).told).toBe(0)
    // reported: absolute, ~, .. (also in the middle), and a bare at-sign (nothing to tell)
    expect(run('out1', '@/etc/hosts\n').told).toBe(1)
    expect(run('out2', '@~/notes/team.md\n').told).toBe(1)
    expect(run('out3', '@../other-agent/LOCAL.md\n').told).toBe(1)
    expect(run('out4', '@notes/../../x.md\n').told).toBe(1)
    expect(run('out5', 'see @ here\n').told).toBe(1)
    // .. is reported even when it resolves back inside the folder (the rule is on the path, not only where it lands)
    expect(run('out6', '@notes/../team.md\n', { 'team.md': 'x\n' }).told).toBe(1)
    // reported: a symlink inside the folder that points out, to a file and through a folder
    const outside = mkdtempSync(join(tmpdir(), 'marveen-local-import-out-'))
    try {
      writeFileSync(join(outside, 'secret.md'), 'x\n')
      const f = agent({ 'CLAUDE.md': I.packageShellText('lnk1', ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': '@notes.md\n' })
      symlinkSync(join(outside, 'secret.md'), join(f, 'notes.md'))
      I.reportPackageLayersAtStart('lnk1', f)
      expect(mine('lnk1')).toBe(1)
      const g = agent({ 'CLAUDE.md': I.packageShellText('lnk2', ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': '@shared/secret.md\n' })
      symlinkSync(outside, join(g, 'shared'))
      I.reportPackageLayersAtStart('lnk2', g)
      expect(mine('lnk2')).toBe(1)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    // reported: a symlink into a sibling folder whose name starts with this folder's name (agents/a1 -> agents/a1-sib)
    const h = agent({ 'CLAUDE.md': I.packageShellText('lnk3', ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': '@peer/x.md\n' })
    const sib = `${h}-sib`
    try {
      mkdirSync(sib, { recursive: true })
      writeFileSync(join(sib, 'x.md'), 'x\n')
      symlinkSync(sib, join(h, 'peer'))
      I.reportPackageLayersAtStart('lnk3', h)
      expect(mine('lnk3')).toBe(1)
    } finally {
      rmSync(sib, { recursive: true, force: true })
    }
    // a silent import does not hide a command after it, on the next line or the same line
    expect(run('cmd1', '@notes/team.md\nrun !`id` now\n').told).toBe(1)
    expect(run('cmd2', '@notes/team.md then !`id`\n').told).toBe(1)
    // an import in PACKAGE.md is reported even when relative
    const p = agent({ 'CLAUDE.md': I.packageShellText('pkg1', ''), 'PACKAGE.md': '# Package\n@notes/team.md\n', 'LOCAL.md': 'notes\n' })
    I.reportPackageLayersAtStart('pkg1', p)
    expect(mine('pkg1')).toBe(1)
  })
  it('a hand-made agent (no package shell) is not scanned at start, even with a stray PACKAGE.md', () => {
    const d = agent({ 'CLAUDE.md': '# hand-made\nrun !`id` now\n', 'PACKAGE.md': 'run !`id` now\n', 'LOCAL.md': 'run !`id` now\n' })
    const name = d.split('/').pop()!
    I.reportPackageLayersAtStart(name, d)
    const mine = (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()) : [])
      .map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8'))).filter((n) => n.name === name)
    expect(mine).toEqual([])
  })
  it('startAgentProcess runs the report scan right after the package guard', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf8')
    const start = src.slice(src.indexOf('export async function startAgentProcess'))
    const guard = start.indexOf('packageStartRefusal(name, dir)')
    const report = start.indexOf('reportPackageLayersAtStart(name, dir)')
    expect(guard).toBeGreaterThan(0)
    expect(report).toBeGreaterThan(guard)
    expect(report).toBeLessThan(start.indexOf('readAgentRemoteConfig(name)'))
  })
  it('the report scan ignores the product-generated sections of the started CLAUDE.md, but still sees a forbidden token in PACKAGE.md', async () => {
    const S = await import('../web/agent-scaffold.js')
    const notices = () => (existsSync(I.pendingNoticesDir()) ? readdirSync(I.pendingNoticesDir()) : [])
      .map((f) => JSON.parse(readFileSync(join(I.pendingNoticesDir(), f), 'utf8')))
      .filter((n) => n.kind === 'fallback_scan_finding').length
    const started = agent({ 'CLAUDE.md': I.packageShellText('a1', ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': 'notes\n' })
    const name = started.split('/').pop()!
    // The real start-time writers append their generated sections (the system-directive one carries "[Uzenet @...").
    S.ensureSystemDirectiveAuthSection(name)
    S.ensureMessageCloseSection(name)
    const claude = readFileSync(join(started, 'CLAUDE.md'), 'utf8')
    expect(claude).toMatch(/\s@/)
    expect(M.startsWithPackageShell(Buffer.from(claude))).toBe(true)
    const before = notices()
    const fb1 = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    const fb2 = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      expect(I.prepareFallbackClaudeMd(name, started, fb1)).toBe('expanded')
      expect(notices()).toBe(before)
      const bad = agent({ 'CLAUDE.md': claude, 'PACKAGE.md': '# Package\n@../../secret.md\n', 'LOCAL.md': 'notes\n' })
      expect(I.prepareFallbackClaudeMd(bad.split('/').pop()!, bad, fb2)).toBe('expanded')
      expect(notices()).toBe(before + 1)
    } finally {
      rmSync(fb1, { recursive: true, force: true })
      rmSync(fb2, { recursive: true, force: true })
    }
  })
  it('every fallback (package and hand-made) links the agent project settings, hooks and skills under .claude, 0700, no dangling link', () => {
    const SET = '{"hooks":{}}\n'
    const files = { '.claude/settings.json': SET, '.claude/settings.local.json': '{}\n', '.claude/hooks/gate.sh': '#!/bin/sh\n', '.claude/skills/canary/SKILL.md': '# canary\n' }
    const pkgAgent = agent({ 'CLAUDE.md': I.packageShellText('a1', ''), 'PACKAGE.md': '# Package\n', 'LOCAL.md': 'notes\n', ...files })
    const plain = agent({ 'CLAUDE.md': '# hand-made\n', ...files })
    const partial = agent({ 'CLAUDE.md': '# hand-made\n', '.claude/settings.json': SET })
    for (const [d, want] of [[pkgAgent, 'expanded'], [plain, 'linked']] as const) {
      const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
      try {
        expect(I.prepareFallbackClaudeMd(d.split('/').pop()!, d, fb)).toBe(want)
        expect(statSync(join(fb, '.claude')).mode & 0o777).toBe(0o700)
        for (const n of I.FALLBACK_PROJECT_LINKS) {
          expect(lstatSync(join(fb, '.claude', n)).isSymbolicLink()).toBe(true)
          expect(readlinkSync(join(fb, '.claude', n))).toBe(join(d, '.claude', n))
        }
        // a project hook written as "$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh" resolves from the fallback folder
        expect(readFileSync(join(fb, '.claude', 'hooks', 'gate.sh'), 'utf8')).toBe('#!/bin/sh\n')
      } finally {
        rmSync(fb, { recursive: true, force: true })
      }
      // removing the fallback folder leaves the targets alone
      expect(readFileSync(join(d, '.claude', 'settings.json'), 'utf8')).toBe(SET)
      expect(existsSync(join(d, '.claude', 'skills', 'canary', 'SKILL.md'))).toBe(true)
    }
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      expect(I.prepareFallbackClaudeMd(partial.split('/').pop()!, partial, fb)).toBe('linked')
      expect(lstatSync(join(fb, '.claude', 'settings.json')).isSymbolicLink()).toBe(true)
      expect(existsSync(join(fb, '.claude', 'settings.local.json'))).toBe(false)
      expect(() => lstatSync(join(fb, '.claude', 'hooks'))).toThrow()
      expect(() => lstatSync(join(fb, '.claude', 'skills'))).toThrow()
    } finally {
      rmSync(fb, { recursive: true, force: true })
    }
  })
  it('a settings file that exists but cannot be linked refuses the fallback start (fail closed)', () => {
    const d = agent({ 'CLAUDE.md': '# hand-made\n', '.claude/settings.json': '{"hooks":{}}\n' })
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      mkdirSync(join(fb, '.claude'), { mode: 0o700 })
      writeFileSync(join(fb, '.claude', 'settings.json'), 'squatter')
      expect(I.prepareFallbackClaudeMd(d.split('/').pop()!, d, fb)).toBe('refused')
    } finally {
      rmSync(fb, { recursive: true, force: true })
    }
  })
  it('FALLBACKPROJDIR1118: a project hook naming another path under $CLAUDE_PROJECT_DIR refuses the fallback start', () => {
    const hookSet = (cmd: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }] } })
    const cases: Array<[string, Record<string, string>, string, string[]]> = [
      // [label, files, command, unresolved paths expected]
      ['plain form, script exists in the agent dir', { 'scripts/gate.sh': '#!/bin/sh\n' }, '$CLAUDE_PROJECT_DIR/scripts/gate.sh', ['/scripts/gate.sh']],
      ['quoted form', { 'scripts/gate.sh': '#!/bin/sh\n' }, '"$CLAUDE_PROJECT_DIR"/scripts/gate.sh --strict', ['/scripts/gate.sh']],
      ['braced form, in settings.local.json', { 'scripts/gate.sh': '#!/bin/sh\n' }, 'bash ${CLAUDE_PROJECT_DIR}/scripts/gate.sh', ['/scripts/gate.sh']],
      ['a path under the linked .claude/hooks resolves', { '.claude/hooks/gate.sh': '#!/bin/sh\n' }, '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gate.sh', []],
      ['a path missing from the agent dir too is not counted', {}, '$CLAUDE_PROJECT_DIR/scripts/nowhere.sh', []],
      ['an absolute hook path is not counted', { 'scripts/gate.sh': '#!/bin/sh\n' }, '/usr/bin/true', []],
    ]
    for (const [label, files, cmd, want] of cases) {
      const settingsFile = label.includes('settings.local.json') ? '.claude/settings.local.json' : '.claude/settings.json'
      const d = agent({ 'CLAUDE.md': '# hand-made\n', ...files, [settingsFile]: hookSet(cmd) })
      const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
      try {
        expect(I.prepareFallbackClaudeMd(d.split('/').pop()!, d, fb), label).toBe(want.length > 0 ? 'refused' : 'linked')
        expect(I.unresolvedProjectDirHookPaths(d, fb), label).toEqual(want)
      } finally {
        rmSync(fb, { recursive: true, force: true })
      }
    }
  })
  it('a hooks folder that exists but cannot be linked refuses the fallback start (fail closed)', () => {
    const d = agent({ 'CLAUDE.md': '# hand-made\n', '.claude/hooks/gate.sh': '#!/bin/sh\n' })
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      mkdirSync(join(fb, '.claude', 'hooks'), { recursive: true, mode: 0o700 })
      expect(I.prepareFallbackClaudeMd(d.split('/').pop()!, d, fb)).toBe('refused')
    } finally {
      rmSync(fb, { recursive: true, force: true })
    }
  })
  it('a missing LOCAL.md is an empty local layer, not a refusal', () => {
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      expect(I.prepareFallbackClaudeMd('a1', agent({ 'CLAUDE.md': P, 'PACKAGE.md': 'PACKAGE-CANARY\n' }), fb)).toBe('expanded')
      expect(readFileSync(join(fb, 'CLAUDE.md'), 'utf8')).toContain('PACKAGE-CANARY')
    } finally {
      rmSync(fb, { recursive: true, force: true })
    }
  })
  it('a hand-made agent: the link it always got (N13), byte for byte the old branch', () => {
    const d = agent({ 'CLAUDE.md': '# hand-made\n' })
    const fb = mkdtempSync(join(tmpdir(), 'marveen-fallback-test-'))
    try {
      expect(I.prepareFallbackClaudeMd('a1', d, fb)).toBe('linked')
      expect(readlinkSync(join(fb, 'CLAUDE.md'))).toBe(join(d, 'CLAUDE.md'))
      expect(existsSync(join(fb, 'LOCAL.md'))).toBe(false)
    } finally {
      rmSync(fb, { recursive: true, force: true })
    }
  })
})

describe('the watchdog shell test is wired (Dani C5; mutant 44)', () => {
  it('runs green from vitest', () => {
    const r = spawnSync('bash', [join(REPO, 'scripts', '__tests__', 'watchdog-scaffold-guard.test.sh')], { encoding: 'utf8', timeout: 120_000 })
    expect(r.stdout).toMatch(/ [1-9][0-9]* passed, 0 failed/)
    expect(r.status).toBe(0)
  }, 130_000)
  it('CI runs it', () => {
    expect(readFileSync(join(REPO, '.github', 'workflows', 'test.yml'), 'utf8')).toContain('- run: bash scripts/__tests__/watchdog-scaffold-guard.test.sh')
  })
})
