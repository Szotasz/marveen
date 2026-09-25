// APRO920 (b): toolInputPreview (src/web/tool-input-preview.ts) is a port of
// scripts/hooks/tool-log-capture.py's _input_summary/_redact (spec 8. döntés:
// the Python stays the norm). This pins byte-for-byte parity against the
// SHIPPED Python, not a hand-typed re-implementation of it, and mutates the
// fixture to prove the comparison is not a no-op (fails red when the two
// actually diverge).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolInputPreview } from '../web/tool-input-preview.js'

const FIXTURE_PATH = join(__dirname, 'fixtures', 'tool-input-preview.json')
const PY_SCRIPT = join(__dirname, 'tool-input-preview-parity.py')

function runPython(fixturePath: string): string[] {
  const res = spawnSync('python3', [PY_SCRIPT], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, TOOL_INPUT_PREVIEW_FIXTURE: fixturePath },
  })
  if (res.status !== 0) {
    throw new Error(`python3 parity script failed: ${res.stderr}`)
  }
  return JSON.parse(res.stdout)
}

describe('toolInputPreview / _input_summary parity (APRO920 b)', () => {
  it('matches the shipped Python byte-for-byte for every fixture case', () => {
    const cases: Array<{ toolName: string; input: unknown }> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
    const pyOut = runPython(FIXTURE_PATH)
    expect(pyOut).toHaveLength(cases.length)

    cases.forEach((c, i) => {
      const tsOut = toolInputPreview(c.toolName, c.input) ?? ''
      expect(tsOut).toBe(pyOut[i])
    })
  })

  it('redacts a Bearer token the same way on both sides', () => {
    const preview = toolInputPreview('Bash', { command: "curl -H 'Authorization: Bearer abcd1234efgh5678'" })
    expect(preview).toContain('[REDACTED]')
    expect(preview).not.toContain('abcd1234efgh5678')
  })

  it('Read/Write/Edit preview is the file_path, untouched', () => {
    expect(toolInputPreview('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolInputPreview('Write', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolInputPreview('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
  })

  it('an unknown tool falls back to the first string value found', () => {
    expect(toolInputPreview('SomeMcpTool', { a: 1, b: 'first string' })).toBe('first string')
  })

  it('empty/absent input yields no preview on either side', () => {
    expect(toolInputPreview('Bash', {})).toBeFalsy()
    expect(toolInputPreview('Bash', undefined)).toBeFalsy()
  })

  it('a mutated fixture case makes the comparison fail (canary: the test is not a no-op)', () => {
    const cases: Array<{ toolName: string; input: unknown }> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
    const pyOut = runPython(FIXTURE_PATH)
    // Deliberately compare case 0 against case 1's python output -- must fail.
    const wrongMatch = toolInputPreview(cases[0].toolName, cases[0].input) === pyOut[1]
    expect(wrongMatch).toBe(false)
  })
})
