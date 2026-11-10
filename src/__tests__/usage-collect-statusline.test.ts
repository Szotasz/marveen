import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/usage-collect.py, Claude part when the official endpoint gives
// nothing: (1) the statusLine side file (store/.claude-rate-limits.json) fills
// claude.windows with source "statusline", only when fresh; (2) the token
// estimate scans every transcript root and counts claude-* models only.
// The script has a hyphen in its name, so the helpers are called through a
// tiny python harness (importlib) with explicit paths: no repo store is read
// or written.

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'usage-collect.py')
const NOW_S = 1_794_300_000 // fixed "now" handed to the reader

const HARNESS = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("uc", sys.argv[1])
uc = importlib.util.module_from_spec(spec); spec.loader.exec_module(uc)
mode = sys.argv[2]
if mode == "statusline":
    now = datetime.fromtimestamp(float(sys.argv[4]), timezone.utc)
    w, age = uc._read_claude_statusline(float(sys.argv[5]), now_utc=now, path=sys.argv[3])
    print(json.dumps({"windows": w, "age": age}))
elif mode == "estimate":
    print(json.dumps(uc._collect_claude_estimate(patterns=sys.argv[3:])))
elif mode == "globs":
    print(json.dumps(uc._claude_transcript_globs()))
`

function py(...args: string[]) {
  const r = spawnSync('python3', ['-I', '-c', HARNESS, SCRIPT, ...args], { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'usage-collect-sl-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function sideFile(name: string, body: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(body))
  return p
}

const GOOD = (over: Record<string, unknown> = {}) => ({
  written_at: NOW_S - 120,
  rate_limits: {
    five_hour: { used_percentage: 19, resets_at: NOW_S + 3600 },
    seven_day: { used_percentage: 2, resets_at: NOW_S + 86400 },
  },
  ...over,
})

describe('usage-collect: statusLine side file', () => {
  it('maps used_percentage/resets_at onto the collector window shape', () => {
    const r = py('statusline', sideFile('good.json', GOOD()), String(NOW_S), '10')
    expect(r.windows).toEqual({
      five_hour: { used_percent: 19, resets_at: NOW_S + 3600 },
      seven_day: { used_percent: 2, resets_at: NOW_S + 86400 },
    })
    expect(r.age).toBeCloseTo(2, 5)
  })

  it('refuses a reading older than the freshness limit', () => {
    const p = sideFile('old.json', GOOD({ written_at: NOW_S - 11 * 60 }))
    expect(py('statusline', p, String(NOW_S), '10').windows).toBeNull()
  })

  it('accepts a reading just inside the limit', () => {
    const p = sideFile('edge.json', GOOD({ written_at: NOW_S - 9 * 60 }))
    expect(py('statusline', p, String(NOW_S), '10').windows).not.toBeNull()
  })

  it('refuses a written_at in the future and a missing written_at', () => {
    expect(py('statusline', sideFile('fut.json', GOOD({ written_at: NOW_S + 600 })), String(NOW_S), '10').windows).toBeNull()
    const { written_at: _omit, ...noTs } = GOOD()
    expect(py('statusline', sideFile('nots.json', noTs), String(NOW_S), '10').windows).toBeNull()
  })

  it('drops a window whose reset time has already passed, keeps the other', () => {
    const p = sideFile('rolled.json', GOOD({
      rate_limits: {
        five_hour: { used_percentage: 97, resets_at: NOW_S - 60 },
        seven_day: { used_percentage: 2, resets_at: NOW_S + 86400 },
      },
    }))
    const r = py('statusline', p, String(NOW_S), '10')
    expect(Object.keys(r.windows)).toEqual(['seven_day'])
  })

  it('returns nothing when no window survives, and for a missing or broken file', () => {
    const p = sideFile('none.json', GOOD({ rate_limits: {} }))
    expect(py('statusline', p, String(NOW_S), '10').windows).toBeNull()
    expect(py('statusline', join(dir, 'missing.json'), String(NOW_S), '10').windows).toBeNull()
    writeFileSync(join(dir, 'broken.json'), '{not json')
    expect(py('statusline', join(dir, 'broken.json'), String(NOW_S), '10').windows).toBeNull()
  })
})

describe('usage-collect: transcript estimate', () => {
  const line = (model: string, ts: string, out: number) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage: { output_tokens: out } } })

  it('counts claude-* models only, across several roots, without double counting a symlinked root', () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const a = join(dir, 'rootA', 'projects', 'p1')
    const b = join(dir, 'rootB', 'projects', 'p2')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 's.jsonl'), [
      line('claude-sonnet-5-5', recent, 100),
      line('deepseek-v4-pro', recent, 5000),
      line('<synthetic>', recent, 7),
    ].join('\n') + '\n')
    writeFileSync(join(b, 's.jsonl'), line('claude-opus-5-5', recent, 40) + '\n')
    // a third pattern that resolves to the same files as rootA
    const r = py(
      'estimate',
      join(dir, 'rootA', 'projects', '*', '*.jsonl'),
      join(dir, 'rootB', 'projects', '*', '*.jsonl'),
      join(dir, 'rootA', 'projects', 'p1', '*.jsonl'),
    )
    expect(r.seven_day_est_tokens).toBe(140)
    expect(r.five_hour_est_tokens).toBe(140)
    expect(r.seven_day_opus_est_tokens).toBe(40)
    expect(r.files_scanned).toBe(2)
  })

  it('searches the config-dir, home, channels-config and sub-agent roots', () => {
    const globs: string[] = py('globs')
    expect(globs.some((g) => g.endsWith('/.channels-config/projects/*/*.jsonl'))).toBe(true)
    expect(globs.some((g) => g.endsWith('/agents/*/.claude-config/projects/*/*.jsonl'))).toBe(true)
    expect(globs.some((g) => g.endsWith('/.claude/projects/*/*.jsonl'))).toBe(true)
  })
})
