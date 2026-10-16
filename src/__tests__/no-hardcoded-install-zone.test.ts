import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

// ISSUE1895 (#1895): src/config.ts promises ONE zone for the install (APP_TZ /
// SCHEDULER_TZ, falling back to the host zone), "and an update that
// re-introduces a hardcoded literal is caught by a single grep". Nothing ran
// that grep, so live Europe/Budapest literals survived in the macOS helper
// plists, the heartbeat header, the approval text, the dashboard, two scripts
// and the agent template. This is that grep: a CODE line (not a comment) that
// names Europe/Budapest fails, unless it is on the allow-list below with its
// reason.

const ROOT = join(__dirname, '..', '..')
const LITERAL = 'Europe/Budapest'

// path (or path prefix ending in '/') -> why a literal is allowed there
const ALLOWED: Record<string, string> = {
  'src/config-registry.ts': 'SCHEDULER_TZ: the settings valueSet and the help text example',
  'web/lang/en.js': 'SCHEDULER_TZ help text example',
  'web/lang/hu.js': 'SCHEDULER_TZ help text example',
  'src/web/schedule-runner.ts': 'an example zone in the "invalid SCHEDULER_TZ" error message',
  'scripts/systemd/': 'placeholder unit templates; install-linux.sh writes its own units with the host zone (#118)',
}

const SCAN_DIRS = ['src', 'scripts', 'web', 'templates']
const SCAN_FILES = ['install-macos.sh', 'install-linux.sh', 'install.sh', 'update.sh']
const EXT = /\.(ts|js|mjs|cjs|sh|py|template|json|plist)$/

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXT.test(name)) out.push(p)
  }
}

// The code part of a line: whole-line comments are skipped, and a trailing
// `//` comment is cut off in JS/TS (a shell/Python `#` comment is whole-line only
// here, since `#` is also legitimate inside strings and URLs).
function codePart(line: string, file: string): string {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) return ''
  if (/\.(ts|js|mjs|cjs)$/.test(file)) {
    const i = line.indexOf(' //')
    return i >= 0 ? line.slice(0, i) : line
  }
  return line
}

function offenders(): string[] {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files)
  for (const f of SCAN_FILES) if (existsSync(join(ROOT, f))) files.push(join(ROOT, f))
  const out: string[] = []
  for (const f of files) {
    const rel = relative(ROOT, f)
    if (Object.keys(ALLOWED).some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a))) continue
    readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
      if (codePart(line, rel).includes(LITERAL)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return out
}

describe('no hardcoded Europe/Budapest outside the allow-list (ISSUE1895)', () => {
  it('every human-facing time and instruction uses the install zone', () => {
    expect(offenders()).toEqual([])
  })

  it('the scan is not vacuous: it sees the allowed literals it skips', () => {
    expect(readFileSync(join(ROOT, 'src', 'config-registry.ts'), 'utf-8')).toContain(LITERAL)
    expect(readdirSync(join(ROOT, 'scripts', 'systemd')).length).toBeGreaterThan(0)
  })

  it('the agent template carries the {{TIMEZONE}} placeholder, and every renderer fills it', () => {
    expect(readFileSync(join(ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')).toContain('{{TIMEZONE}}')
    for (const f of ['install-macos.sh', 'install-linux.sh', 'update.sh']) {
      expect(readFileSync(join(ROOT, f), 'utf-8'), f).toContain('s|{{TIMEZONE}}|')
    }
    expect(readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')).toContain(".replaceAll('{{TIMEZONE}}'")
  })
})
