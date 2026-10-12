import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { findDuplicateJsonKeys } from '../web/json-dup-keys.js'

// Duplicate-key lint. JSON.parse keeps only the LAST occurrence of a
// duplicated key, so a settings.json with two hook-event keys of the same
// name silently drops every hook in the earlier block: no parse error, no
// warning, the guards just stop running. Measured cost of this class on a
// customized install: two guards dead for eight days behind a green-looking
// config. The evidence exists only in the raw text, so both the detector and
// this repo lint operate before parsing.

describe('findDuplicateJsonKeys (detector)', () => {
  it('finds the incident shape: two hook-event keys in the same hooks object', () => {
    const raw = `{
      "hooks": {
        "PreToolUse": [ { "hooks": [ { "command": "guard-a" } ] } ],
        "Stop":       [ { "hooks": [ { "command": "guard-b" } ] } ],
        "PreToolUse": [ { "hooks": [ { "command": "guard-c" } ] } ]
      }
    }`
    expect(findDuplicateJsonKeys(raw)).toEqual(['hooks.PreToolUse'])
    // ...and this is exactly what JSON.parse hides: guard-a is gone.
    const parsed = JSON.parse(raw) as { hooks: { PreToolUse: unknown[] } }
    expect(JSON.stringify(parsed.hooks.PreToolUse)).not.toContain('guard-a')
  })

  it('does not flag the same key name in DIFFERENT objects', () => {
    const raw = `{"a": {"command": "x"}, "b": {"command": "y"}}`
    expect(findDuplicateJsonKeys(raw)).toEqual([])
  })

  it('does not flag repeated keys across sibling array elements', () => {
    const raw = `{"hooks": [{"type": "command"}, {"type": "command"}]}`
    expect(findDuplicateJsonKeys(raw)).toEqual([])
  })

  it('reports array-indexed paths for duplicates inside array elements', () => {
    const raw = `{"entries": [{"k": 1}, {"k": 1, "k": 2}]}`
    expect(findDuplicateJsonKeys(raw)).toEqual(['entries[1].k'])
  })

  it('is not fooled by key-lookalike strings in VALUES or escaped quotes', () => {
    const raw = `{"cmd": "echo \\"PreToolUse\\": 1", "note": "PreToolUse", "cmd2": "x"}`
    expect(findDuplicateJsonKeys(raw)).toEqual([])
  })

  it('handles top-level duplicates and nested duplicates together', () => {
    const raw = `{"env": {}, "env": {}, "hooks": {"Stop": [], "Stop": []}}`
    expect(findDuplicateJsonKeys(raw)).toEqual(['env', 'hooks.Stop'])
  })
})

describe('shipped JSON settings artifacts carry no duplicate keys', () => {
  const ROOT = join(__dirname, '..', '..')
  const ARTIFACTS = [
    '.claude/settings.json',
    'templates/settings.json.template',
  ]
  for (const rel of ARTIFACTS) {
    it(rel, () => {
      const p = join(ROOT, rel)
      if (!existsSync(p)) return
      expect(findDuplicateJsonKeys(readFileSync(p, 'utf-8'))).toEqual([])
    })
  }
})
