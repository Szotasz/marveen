// RATELIMITFEED1122 follow-up: a prior attempt at the extra raw-payload dump shipped
// a second, install-specific script (scripts/statusline-usage-dump.sh) with hard-coded
// absolute paths and a personal fallback string, configured as a REPLACEMENT statusLine
// command -- which silently stopped the collector's statusline fallback
// (store/.claude-rate-limits.json) from being written at all (see PR #3029 review).
// The fix stays in the one shipped script: scripts/statusline-ratelimit.sh now also
// writes the full raw payload to store/statusline-latest.json, with paths resolved
// from its own install root (INSTALL_DIR), no personal strings, no behavior change
// to the existing store/.claude-rate-limits.json write this test also re-checks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'statusline-ratelimit.sh')

let dir: string
beforeEach(() => {
  // INSTALL_DIR = dirname(script)/.. , so the script must live one level under
  // the fake install root for its own path resolution to land on dir/store/.
  dir = mkdtempSync(join(tmpdir(), 'statusline-ratelimit-'))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'store'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function run(payload: unknown): { stdout: string; status: number | null } {
  const scriptCopy = join(dir, 'scripts', 'statusline-ratelimit.sh')
  // Copy, not symlink the containing dir: a symlinked scripts/ would resolve
  // dirname("$0")/.. back to the real repo root instead of the temp install root.
  require('node:fs').copyFileSync(SCRIPT, scriptCopy)
  require('node:fs').chmodSync(scriptCopy, 0o755)
  const r = spawnSync('bash', [scriptCopy], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  })
  return { stdout: r.stdout, status: r.status }
}

describe('statusline-ratelimit.sh: raw payload dump (store/statusline-latest.json)', () => {
  it('writes the full raw payload verbatim, install-root-resolved, no personal strings', () => {
    const payload = {
      session_id: 'sess-123',
      cwd: '/some/project',
      model: { display_name: 'Sonnet 5' },
      context_window: { used_percentage: 42 },
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 1000 },
        seven_day: { used_percentage: 20, resets_at: 2000 },
      },
    }
    const r = run(payload)
    expect(r.status).toBe(0)

    const latestPath = join(dir, 'store', 'statusline-latest.json')
    expect(existsSync(latestPath)).toBe(true)
    expect(JSON.parse(readFileSync(latestPath, 'utf-8'))).toEqual(payload)

    // Still does its original job: the rate-limit fallback file for usage-collect.py.
    const rlPath = join(dir, 'store', '.claude-rate-limits.json')
    expect(existsSync(rlPath)).toBe(true)
    const rl = JSON.parse(readFileSync(rlPath, 'utf-8'))
    expect(rl.rate_limits).toEqual(payload.rate_limits)

    expect(r.stdout).not.toContain('toni-shark')
  })

  it('writes the raw payload even when rate_limits is absent (fallback file stays untouched)', () => {
    const payload = { session_id: 'sess-456', cwd: '/x', model: { display_name: 'Haiku 5.5' } }
    run(payload)

    const latestPath = join(dir, 'store', 'statusline-latest.json')
    expect(JSON.parse(readFileSync(latestPath, 'utf-8'))).toEqual(payload)
    expect(existsSync(join(dir, 'store', '.claude-rate-limits.json'))).toBe(false)
  })

  it('a broken (unwritable) store/ for the latest dump does not stop the status line', () => {
    const latestPath = join(dir, 'store', 'statusline-latest.json')
    // Make the target path itself a directory: the atomic rename onto it will fail.
    mkdirSync(latestPath)
    const payload = { session_id: 's', model: { display_name: 'M' } }
    const r = run(payload)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('M')
  })
})
