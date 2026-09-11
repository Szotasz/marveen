import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// VOICEWHISPER910: faster-whisper's `condition_on_previous_text` defaults to
// True, and on a Hungarian voice message with a silent or noisy tail that
// feeds the model its own previous output, so the transcript loops on one
// phrase. The fix (#1268) passes `condition_on_previous_text=False` at BOTH
// call sites in scripts/voice/_vtools.py: the live inbound path (_whisper)
// and the canary self-test. If either site loses the flag, the loop is back
// on that path while the other keeps the "fixed" report honest-looking.
//
// The behavioural test that proves the loop (scripts/voice/test_vtools_repetition.py)
// needs the voice venv, piper and ffmpeg, so nothing runs it automatically
// (measured 2026-09-10: no reference to it anywhere, and its skip exits 0).
// This file is the cheap pin that DOES run under `npm test`: it asserts far
// less (the flag is present, not that the loop is gone), but it runs on every
// PR. Keep the expensive one as the manual proof.
const ROOT = join(__dirname, '..', '..')
const SOURCE = join(ROOT, 'scripts', 'voice', '_vtools.py')

/**
 * Every `<model>.transcribe(...)` call with its full argument text: multi-line
 * safe, and paren-balanced, so an argument like `vad_parameters=dict(...)`
 * placed before the flag does not cut the capture short (a lazy match up to
 * the first `)` would report a false red there, and a false red is how a
 * guard gets deleted). `def transcribe(` and the bare `transcribe(` call are
 * not matched: only the method call on the model carries the leading dot.
 */
function transcribeCalls(body: string): string[] {
  const calls: string[] = []
  const open = '.transcribe('
  let from = 0
  while (true) {
    const at = body.indexOf(open, from)
    if (at < 0) break
    let depth = 1
    let i = at + open.length
    while (i < body.length && depth > 0) {
      if (body[i] === '(') depth++
      else if (body[i] === ')') depth--
      i++
    }
    expect(depth, `${SOURCE}: unbalanced parentheses after offset ${at}`).toBe(0)
    calls.push(body.slice(at + open.length, i - 1))
    from = i
  }
  return calls
}

describe('VOICEWHISPER910: every whisper call site pins condition_on_previous_text=False', () => {
  const body = readFileSync(SOURCE, 'utf-8')
  const calls = transcribeCalls(body)

  it('finds both known call sites (live path and canary), so a silently removed site fails too', () => {
    expect(calls.length, `${SOURCE}: expected the live _whisper call and the canary call`).toBeGreaterThanOrEqual(2)
  })

  it.each(calls.map((args, i) => [i + 1, args] as const))(
    'call site %i carries condition_on_previous_text=False',
    (_i, args) => {
      expect(args.replace(/\s+/g, '')).toContain('condition_on_previous_text=False')
    },
  )

  it('still transcribes Hungarian (the flag was added next to language="hu", not instead of it)', () => {
    for (const args of calls) expect(args).toContain('language="hu"')
  })
})
