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
import { readFileSync, readdirSync, statSync } from 'node:fs'
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

describe('scaffold memory section says what actually loads (HOTMEMHAMIS925)', () => {
  const memo = section(SCAFFOLD, '## Memoria rendszer')

  it('does not claim that a tier is loaded at session start', () => {
    expect(memo).not.toMatch(/session-indulás újra kifizeti/i)
    expect(memo).not.toMatch(/BETÖLTÉSÉBŐL/)
  })

  it('states that no tier loads on its own, and what does', () => {
    expect(memo).toContain('EGYIK tierje sem töltődik be magától')
    expect(memo).toContain('csak az kerül be, amit te magad lekérdezel')
    expect(memo).toContain('Magától csak a CLAUDE.md és a Claude Code saját fájl-memóriája')
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
      // The PreCompact agent prompt POSTs memories (a save before compaction): a write, not a load.
      .filter((h) => /api\/memories/.test(h.text) && !(h.event === 'PreCompact' && !/-X\s+GET|api\/memories\?/.test(h.text)))
    expect(readers).toEqual([])
  })
})
