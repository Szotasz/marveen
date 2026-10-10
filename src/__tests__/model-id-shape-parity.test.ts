/**
 * LAUNCHQUOTEREST1008: the model-id allowlist exists twice -- MODEL_ID_RE in
 * src/model-id.ts (every TS writer) and MODEL_ID_SHAPE in scripts/channels.sh
 * (resolve_main_model, SECSZIVEK1007). This pin keeps them the SAME set: every
 * ASCII character, a few non-ASCII ones and the length bounds are run through
 * both (the shell pattern under bash's own [[ =~ ]]), and the verdicts must match.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_ID_RE } from '../model-id.js'

const CH = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')
const shape = (CH.match(/^MODEL_ID_SHAPE='([^']+)'$/m) ?? [])[1]

describe('MODEL_ID_RE (TS) and MODEL_ID_SHAPE (channels.sh) accept the same ids', () => {
  it('channels.sh defines MODEL_ID_SHAPE', () => {
    expect(shape).toBeTruthy()
  })

  it('every probe gets the same verdict from both', () => {
    const probes: string[] = []
    for (let c = 32; c < 127; c++) probes.push(`a${String.fromCharCode(c)}b`)
    probes.push('', 'x', 'x'.repeat(128), 'x'.repeat(129), 'claude-opus-5-5[1m]', 'openrouter/qwen/qwen3:free', 'é', 'a\tb')
    // One bash run: each probe on its own NUL-terminated record, verdict per line.
    const input = probes.map((p) => p + '\0').join('')
    const out = execFileSync('bash', ['-c', `re="$1"; while IFS= read -r -d '' p; do if [[ "$p" =~ $re ]]; then echo 1; else echo 0; fi; done`, '_', shape!], { input, encoding: 'utf-8', env: { ...process.env, LC_ALL: 'C' } })
    const shell = out.trim().split('\n').map((v) => v === '1')
    const ts = probes.map((p) => MODEL_ID_RE.test(p))
    const mismatches = probes.filter((_, i) => shell[i] !== ts[i]).map((p) => JSON.stringify(p))
    expect(shell).toHaveLength(probes.length)
    expect(mismatches).toEqual([])
  })
})
