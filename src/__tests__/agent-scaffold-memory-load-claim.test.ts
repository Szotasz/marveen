// HOTMEMHAMIS925 (TASNADIDIAG908 measurement, develop c8c9d7cd = v1.39.0): no
// dashboard-memory tier (hot/warm/cold/shared) reaches an agent's context on its
// own. buildMemoryContext has had no caller since the first release, and no
// shipped hook reads memories. The scaffold's CLAUDE.md prompt nevertheless told
// every new agent that the hot tier is "paid again at EVERY session start", and
// the same false picture reached a customer (09-08).
//
// Two pins, tied together: the scaffold text states what actually loads, and the
// thing it describes stays true. If someone wires a memory-loading hook or calls
// buildMemoryContext, the second group fails and names the sentence to update.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')

function section(src: string, header: string): string {
  const start = src.indexOf(header)
  expect(start, `${header} not found in the scaffold prompt`).toBeGreaterThan(0)
  const end = src.indexOf('\n## ', start)
  return src.slice(start, end > start ? end : undefined)
}

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      srcFiles(p, out)
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

function hookCommands(settingsPath: string): Array<{ event: string; text: string }> {
  const json = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const out: Array<{ event: string; text: string }> = []
  for (const [event, groups] of Object.entries<any>(json.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) out.push({ event, text: String(h.command ?? h.prompt ?? '') })
  }
  return out
}

// Hooks that may name the endpoint because they only PRINT a recipe for the agent
// to run, and load nothing themselves. Each entry carries its reason.
const RECIPE_PRINTERS: Record<string, string> = {
  'scripts/hooks/memory-lookup-nudge.py':
    'on a human message it prints the search recipe; the agent runs it and picks the keyword (TG 16727)',
}
const isExemptPrinter = (rel: string) => rel in RECIPE_PRINTERS

// Each mention of the endpoint, with the curl command it sits in (same line), or
// the bare line when no curl precedes it there.
function memoryMentions(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/api\/memories/g)) {
    const lineStart = text.lastIndexOf('\n', m.index!) + 1
    const lineEnd = text.indexOf('\n', m.index!)
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    const at = m.index! - lineStart
    const curl = line.lastIndexOf('curl', at)
    out.push(curl < 0 ? line : line.slice(curl))
  }
  return out
}

// A write is an explicit mutating method, or a request body without -G/--get
// (curl -G turns --data* into query parameters, i.e. a GET).
function isWrite(cmd: string): boolean {
  if (!/^curl\b/.test(cmd)) return false
  if (/(?:^|\s)-X\s*(?:POST|PATCH|PUT|DELETE)\b/.test(cmd)) return true
  return /(?:^|\s)(?:-d|--data(?:-binary|-raw|-urlencode)?)\b/.test(cmd) && !/(?:^|\s)(?:-G|--get)\b/.test(cmd)
}

describe('scaffold memory section says what actually loads (HOTMEMHAMIS925)', () => {
  const memo = section(SCAFFOLD, '## Memoria rendszer')

  it('does not claim that a tier is loaded at session start', () => {
    expect(memo).not.toMatch(/session-indulás újra kifizeti/i)
    expect(memo).not.toMatch(/BETÖLTÉSÉBŐL/)
  })

  it('states that no tier loads on its own, and what does', () => {
    expect(memo).toContain('EGYIK tierje sem töltődik be magától')
    expect(memo).toContain('csak az kerül be, amit te magad lekérdezel')
    expect(memo).toContain('Magától a CLAUDE.md, a Claude Code saját fájl-memóriája')
    expect(memo).toContain('a SessionStart hookok saját blokkjai')
  })
})

describe('...and that stays true (update the scaffold sentence if one of these fails)', () => {
  it('nothing in src calls buildMemoryContext', () => {
    const callers = srcFiles(join(ROOT, 'src'))
      .filter((f) => /\bbuildMemoryContext\s*\(/.test(readFileSync(f, 'utf-8').replace(/export async function buildMemoryContext\s*\(/g, '')))
      .map((f) => relative(ROOT, f))
    expect(callers).toEqual([])
  })

  it.each(['templates/settings.json.template', '.claude/settings.json'])('no hook in %s reads memories', (file) => {
    const readers = hookCommands(join(ROOT, file))
      // Only the PreCompact save prompt may name the endpoint, and only in writing curls.
      .filter((h) => memoryMentions(h.text).length > 0 && !(h.event === 'PreCompact' && memoryMentions(h.text).every(isWrite)))
    expect(readers).toEqual([])
  })

  it.each(['templates/settings.json.template', '.claude/settings.json'])('no script a hook in %s runs names the memories endpoint', (file) => {
    const scripts = new Set<string>()
    for (const h of hookCommands(join(ROOT, file))) for (const m of h.text.matchAll(/scripts\/[\w./-]+\.(?:py|sh|mjs|js|ts)/g)) scripts.add(m[0])
    expect(scripts.size, 'no script path parsed from the hooks: the parser is blind').toBeGreaterThan(0)
    const hits = [...scripts].filter((rel) => existsSync(join(ROOT, rel)) && !isExemptPrinter(rel) && /api\/memories/.test(readFileSync(join(ROOT, rel), 'utf-8')))
    expect(hits).toEqual([])
  })

  it('no file under scripts/hooks names the memories endpoint', () => {
    const dir = join(ROOT, 'scripts', 'hooks')
    const hits = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile() && !isExemptPrinter(`scripts/hooks/${n}`) && /api\/memories/.test(readFileSync(join(dir, n), 'utf-8')))
    expect(hits).toEqual([])
  })

  // An exemption must not become the loophole: an exempt hook may PRINT the
  // endpoint (a recipe the agent runs itself), but it may not reach it.
  it.each(Object.keys(RECIPE_PRINTERS))('exempt %s only prints: no network, DB, subprocess or dynamic code on any line', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf-8')
    expect(src).toMatch(/api\/memories/) // stale-exemption guard: drop the entry when this stops holding
    expect(src).not.toMatch(/urlopen|urllib|http\.client|HTTPConnection|(?:from|import)\s+http\b|httplib|socket|sqlite3|subprocess|\brequests\b|os\.system|os\.popen|os\.exec|os\.spawn|popen|__import__|importlib|asyncio|open_connection|\b(?:exec|eval|compile)\s*\(/)
  })
})

describe('the write/read classifier the PreCompact exception relies on', () => {
  const one = (cmd: string) => memoryMentions(cmd).every(isWrite)
  it('POST, PATCH and a bare -d are writes', () => {
    expect(one(`curl -s -X POST http://h/api/memories -d '{}'`)).toBe(true)
    expect(one(`curl -s -X PATCH http://h/api/memories/5 -d '{}'`)).toBe(true)
    expect(one(`curl -s http://h/api/memories -d '{}'`)).toBe(true)
  })
  it('a plain GET, a -G --data-urlencode search and a prose mention are reads', () => {
    expect(one(`curl -s "http://h/api/memories?category=hot"`)).toBe(false)
    expect(one(`curl -s -G --data-urlencode "category=hot" "http://h/api/memories"`)).toBe(false)
    expect(one(`Kérd le: GET /api/memories`)).toBe(false)
  })
})
