import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// ISOLDESC1029: the Settings description of MAIN_AGENT_ISOLATED_CONFIG said "macOS only / no
// effect on non-macOS", while the code isolates the main agent on any platform
// (ensureMainAgentIsolatedConfigDir gates on the setting and the fleet token only; channels.sh:
// "MAIN_AGENT_ISOLATED_CONFIG=1 (any platform)"). A Linux VPS owner read the label and skipped
// the setting, which is also the key rotation's prerequisite. The label follows the code.

const read = (rel: string) => readFileSync(join(PROJECT_ROOT, rel), 'utf-8')
function descLine(src: string): string {
  const line = src.split('\n').find((l) => l.includes("'settings.desc.MAIN_AGENT_ISOLATED_CONFIG'"))
  if (!line) throw new Error('settings.desc.MAIN_AGENT_ISOLATED_CONFIG not found')
  return line
}

describe('MAIN_AGENT_ISOLATED_CONFIG description matches the platform-independent code', () => {
  it('the code has no platform gate', () => {
    const ap = read('src/web/agent-process.ts')
    const fn = ap.slice(ap.indexOf('export function ensureMainAgentIsolatedConfigDir('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).not.toMatch(/darwin|platform\s*[!=]==/)
    expect(read('scripts/channels.sh')).toContain('MAIN_AGENT_ISOLATED_CONFIG=1 (any platform)')
  })

  it('hu.js does not say macOS only, and names Linux', () => {
    const l = descLine(read('web/lang/hu.js'))
    expect(l).not.toMatch(/CSAK macOS|nem-macOS/i)
    expect(l).toContain('Bármely platformon')
    expect(l).toContain('Linux')
  })

  it('en.js does not say macOS only, and names Linux', () => {
    const l = descLine(read('web/lang/en.js'))
    expect(l).not.toMatch(/macOS only|non-macOS/i)
    expect(l).toContain('Any platform')
    expect(l).toContain('Linux')
  })
})
