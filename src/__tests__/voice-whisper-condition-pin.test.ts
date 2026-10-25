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

/**
 * whisper.cpp CLI invocations (argv arrays containing WHISPER_CLI). This install
 * cannot run faster-whisper -- no wheel for macOS 12 x86_64 -- so the live
 * transcriber is the whisper.cpp CLI, and the SAME previous-text conditioning
 * bug applies to it. This build has no -nc; its equivalent is `-mc 0` (store
 * zero text-context tokens). Upstream #1268 fixed only the faster-whisper
 * sites, so the pin has to cover both mechanisms or it reports a green that
 * says nothing about the path actually in use here.
 */
function whisperCliCalls(body: string): string[] {
  const calls: string[] = []
  const open = 'subprocess.run(['
  let from = 0
  while (true) {
    const at = body.indexOf(open, from)
    if (at < 0) break
    let depth = 1
    let i = at + open.length
    while (i < body.length && depth > 0) {
      if (body[i] === '[') depth++
      else if (body[i] === ']') depth--
      i++
    }
    const args = body.slice(at + open.length, i - 1)
    if (args.includes('WHISPER_CLI')) calls.push(args)
    from = i
  }
  return calls
}

describe('VOICEWHISPER910: every whisper call site disables previous-text conditioning', () => {
  const body = readFileSync(SOURCE, 'utf-8')
  const calls = transcribeCalls(body)
  const cliCalls = whisperCliCalls(body)

  it('finds at least one transcriber call site, so a silently removed site fails too', () => {
    expect(
      calls.length + cliCalls.length,
      `${SOURCE}: expected a faster-whisper .transcribe() call or a whisper.cpp CLI invocation`,
    ).toBeGreaterThanOrEqual(1)
  })

  it.each(cliCalls.map((args, i) => [i + 1, args] as const))(
    'whisper.cpp call site %i carries -mc 0 (the -nc equivalent in this build)',
    (_i, args) => {
      expect(args.replace(/\s+/g, '')).toContain('"-mc","0"')
    },
  )

  it('whisper.cpp still transcribes Hungarian', () => {
    for (const args of cliCalls) expect(args.replace(/\s+/g, '')).toContain('"-l","hu"')
  })

  it.each(calls.map((args, i) => [i + 1, args] as const))(
    'call site %i carries condition_on_previous_text=False',
    (_i, args) => {
      expect(args.replace(/\s+/g, '')).toContain('condition_on_previous_text=False')
    },
  )

  it('faster-whisper sites, if any, still transcribe Hungarian', () => {
    for (const args of calls) expect(args).toContain('language="hu"')
  })
})
