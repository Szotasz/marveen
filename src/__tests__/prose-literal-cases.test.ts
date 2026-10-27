import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { maskProseLiterals } from '../../scripts/email-send-gate.mjs'

// MAILGATEHEREDOCFP1027: the sub-agent gate's prose-literal masker returns the shared
// expectation byte for byte. The case list is shared with the main agent's python twin
// (scripts/__tests__/prose-literal-cases.test.py), so the two maskers cannot drift apart.

type Case = { name: string; lang: string | null; input: string; expected: string }
const { cases } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'prose-literal-cases.json'), 'utf-8'),
) as { cases: Case[] }

describe('prose-literal masker (MAILGATEHEREDOCFP1027)', () => {
  it('the shared list is long enough to mean something', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
  })

  it.each(cases)('$name', (c) => {
    expect(maskProseLiterals(c.input, c.lang)).toBe(c.expected)
  })
})
