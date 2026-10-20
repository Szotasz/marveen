import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The AVX-less fallback pin lives in THREE shipped scripts: install-linux.sh
// (fresh installs), scripts/channels.sh (the self-heal reinstall spec, where
// "latest" must never win on such a host) and scripts/fix-avx.sh (remediation
// of older installs). Each says "keep in sync" in a comment; nothing measured
// it. A drifted pin is silent: the install still succeeds, with a different
// version than the remediation, and only an AVX-less customer sees the
// difference. These tests bind the three together and pin the SHAPE the
// fallback depends on (CLIPINLINUX922, measured 2026-09-23 on the AVX-less
// pilot VPS with a real `claude -p` probe: 2.1.112 is the last version whose
// npm package ships the Node cli.js entrypoint; 2.1.113+ downloads a Bun ELF
// in postinstall, which SIGILLs or spins without AVX).

const ROOT = join(__dirname, '..', '..')
const FILES = ['install-linux.sh', 'scripts/channels.sh', 'scripts/fix-avx.sh']

function pinOf(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf-8')
  const m = src.match(/^CLAUDE_PIN="([^"]+)"/m)
  if (!m) throw new Error(`${rel}: CLAUDE_PIN not found`)
  return m[1]
}

describe('the AVX-less CLAUDE_PIN is one value across the three shipped scripts', () => {
  it('every script declares exactly one CLAUDE_PIN assignment', () => {
    for (const rel of FILES) {
      const src = readFileSync(join(ROOT, rel), 'utf-8')
      expect(src.match(/^CLAUDE_PIN="[^"]+"/gm)?.length, rel).toBe(1)
    }
  })
  it('the three pins are identical', () => {
    const pins = FILES.map(pinOf)
    expect(new Set(pins).size, pins.join(' / ')).toBe(1)
  })
  it('the pin is a version whose npm package ships the Node cli.js entrypoint (<= 2.1.112, the measured last one)', () => {
    const [maj, min, pat] = pinOf('install-linux.sh').split('.').map(Number)
    expect([maj, min]).toEqual([2, 1])
    expect(pat).toBeGreaterThanOrEqual(110)
    expect(pat).toBeLessThanOrEqual(112)
  })
})
