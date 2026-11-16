import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

// On tmux 3.2a (the Ubuntu 22.04 package) `display-message -t <missing
// session>` with a time-key format (#{session_created}, #{session_activity},
// ...) dereferences a NULL session and segfaults the tmux SERVER, so every
// agent session on the host goes down at once (fixed in tmux 3.3).
// getAgentRunningSince() made exactly that call; the roster only asks it for
// agents whose cached run state is "running", so a session that vanished in
// between took the whole fleet down. These tests pin (a) the list-sessions read
// that replaced it and (b) the whole of src: no tmux call pairs a -t target
// with a time key.
//
// Harness as in send-prompt-chunk-binding.test.ts: captureTmux goes through
// node:child_process execFileSync, which is mocked with argument recording.

const h = vi.hoisted(() => ({ calls: [] as string[][], out: '' }))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) h.calls.push(args)
    return h.out
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { getAgentRunningSince } from '../web/agent-process.js'

const TIME_KEY = /#\{[^}]*\b(session_created|session_activity|session_last_attached|window_activity|client_activity|client_created|buffer_created)\b/

beforeEach(() => {
  h.calls.length = 0
  h.out = ''
})

describe('getAgentRunningSince reads the creation time without a -t target', () => {
  it('returns the creation time of the named session from list-sessions', () => {
    h.out = '1763280000 agent-other\n1763283600 agent-since-probe\n'
    expect(getAgentRunningSince('since-probe', 'agent-since-probe')).toBe(1763283600)
  })

  it('returns null for a session that is gone', () => {
    h.out = '1763280000 agent-other\n'
    expect(getAgentRunningSince('since-probe', 'agent-since-probe')).toBeNull()
  })

  it('matches the whole name, not a prefix', () => {
    h.out = '1763280000 agent-since-probe-2\n'
    expect(getAgentRunningSince('since-probe', 'agent-since-probe')).toBeNull()
  })

  it('never passes -t together with a time-key format', () => {
    h.out = '1763283600 agent-since-probe\n'
    getAgentRunningSince('since-probe', 'agent-since-probe')
    const timeKeyCalls = h.calls.filter(a => a.some(x => TIME_KEY.test(x)))
    expect(timeKeyCalls.length).toBeGreaterThan(0)
    for (const a of timeKeyCalls) expect(a).not.toContain('-t')
  })
})

describe('no tmux call in src pairs a -t target with a time key', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const SRC = join(ROOT, 'src')

  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name !== '__tests__' && name !== 'node_modules') out.push(...tsFiles(p))
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        out.push(p)
      }
    }
    return out
  }

  // The argument array a time-key format sits in: from the nearest '[' before
  // it to the nearest ']' after it (an args literal is one array), but only
  // within a short reach -- a format string outside any args literal (a label,
  // a comment) must not pull in a distant bracket.
  const REACH = 300
  function offenders(text: string): string[] {
    const found: string[] = []
    const re = new RegExp(TIME_KEY.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const open = text.lastIndexOf('[', m.index)
      const close = text.indexOf(']', m.index)
      const inArgs = open >= 0 && m.index - open <= REACH && close > m.index && close - m.index <= REACH
      const lineStart = text.lastIndexOf('\n', m.index) + 1
      const lineEnd = text.indexOf('\n', m.index)
      const args = inArgs ? text.slice(open, close + 1) : text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
      if (/['"`]-t['"`]/.test(args)) found.push(args.replace(/\s+/g, ' ').slice(0, 160))
    }
    return found
  }

  it('the census catches the call it exists for (control)', () => {
    expect(offenders("captureTmux(target, ['display-message', '-p', '-t', exactTmuxTarget(session), '#{session_created}']).trim()")).toHaveLength(1)
    expect(offenders("captureTmux(target, ['list-sessions', '-F', '#{session_created} #{session_name}'])")).toHaveLength(0)
  })

  it('finds no such call anywhere in src', () => {
    const files = tsFiles(SRC)
    expect(files.length).toBeGreaterThan(50)
    const bad: string[] = []
    for (const f of files) {
      for (const args of offenders(readFileSync(f, 'utf-8'))) bad.push(`${relative(ROOT, f)}: ${args}`)
    }
    expect(bad).toEqual([])
  })
})
