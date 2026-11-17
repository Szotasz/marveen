// TYPINGPATHS1114 (2026-11-14). runAgent has two ways to reach a Claude Code session: the worker (the
// prompt is typed through the common sender, which applies the pane mapping) and the SDK `query` path
// (the emergency rollback, and the fallback when the worker cannot recover its login). The SDK path
// handed the prompt over unmapped. The at-sign step of the mapping now runs once at the top of
// runAgent, for both paths. This file pins:
//   - what each path receives;
//   - that the worker path's second pass (the common sender) changes nothing;
//   - that only the at-sign step runs here: the SDK prompt keeps its line breaks.
// The at-sign is built from its code point on purpose: the raw shapes must not be pasted into a
// message, a card or a PR description (see pane-at-neutralize.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { neutralizeAtMentions, paneTyped } from '../web/pane-text.js'

const AT = String.fromCharCode(64)
const BS = '\\'

const sdkPrompts: unknown[] = []
const workerPrompts: string[] = []
let workerAnswer: { text: string | null; error?: string; authFailed?: boolean } = { text: 'worker-ok' }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { prompt: unknown }) => {
    sdkPrompts.push(arg.prompt)
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'sdk-ok' }
    })()
  },
}))

vi.mock('../web/agent-worker.js', () => ({
  runViaWorker: async (message: string) => {
    workerPrompts.push(message)
    return workerAnswer
  },
}))

vi.mock('../web/fleet-freeze.js', () => ({ isFleetFrozen: () => false }))

// at the start, after a space, after a line break, after a tab, after a semicolon; and two that must stay
const RAW = `${AT}first then ${AT}second\n${AT}third\t${AT}fourth;${AT}fifth mail user${AT}example.org (${AT}paren)`
const MAPPED = `${BS}${AT}first then ${BS}${AT}second\n${BS}${AT}third\t${BS}${AT}fourth;${BS}${AT}fifth mail user${AT}example.org (${AT}paren)`

const savedBackend = process.env.MARVEEN_AGENT_BACKEND

beforeEach(() => {
  sdkPrompts.length = 0
  workerPrompts.length = 0
  workerAnswer = { text: 'worker-ok' }
  delete process.env.MARVEEN_AGENT_BACKEND
})
afterEach(() => {
  if (savedBackend === undefined) delete process.env.MARVEEN_AGENT_BACKEND
  else process.env.MARVEEN_AGENT_BACKEND = savedBackend
})

describe('runAgent maps the at-sign once, before either path', () => {
  it('the fixture is what the mapping produces, and it differs from the raw text', () => {
    expect(neutralizeAtMentions(RAW)).toBe(MAPPED)
    expect(MAPPED).not.toBe(RAW)
  })

  it('worker path (the default): the worker receives the mapped prompt, the SDK is not called', async () => {
    const { runAgent } = await import('../agent.js')
    expect(await runAgent(RAW)).toEqual({ text: 'worker-ok', error: undefined })
    expect(workerPrompts).toEqual([MAPPED])
    expect(sdkPrompts).toEqual([])
  })

  it('SDK path (MARVEEN_AGENT_BACKEND=sdk): query receives the mapped prompt, line breaks kept', async () => {
    process.env.MARVEEN_AGENT_BACKEND = 'sdk'
    const { runAgent } = await import('../agent.js')
    expect((await runAgent(RAW)).text).toBe('sdk-ok')
    expect(workerPrompts).toEqual([])
    expect(sdkPrompts).toEqual([MAPPED])
    expect(String(sdkPrompts[0])).toContain('\n')
    expect(String(sdkPrompts[0])).toContain('\t')
  })

  it('fallback (the worker reports authFailed): BOTH receive the same mapped prompt', async () => {
    workerAnswer = { text: null, authFailed: true }
    const { runAgent } = await import('../agent.js')
    expect((await runAgent(RAW)).text).toBe('sdk-ok')
    expect(workerPrompts).toEqual([MAPPED])
    expect(sdkPrompts).toEqual([MAPPED])
  })

  it('a prompt with no expandable at-sign reaches both paths unchanged', async () => {
    const plain = `write to user${AT}example.org\nsecond line (${AT}x) and "${AT}y"`
    workerAnswer = { text: null, authFailed: true }
    const { runAgent } = await import('../agent.js')
    await runAgent(plain)
    expect(workerPrompts).toEqual([plain])
    expect(sdkPrompts).toEqual([plain])
  })
})

describe('the second pass on the worker path changes nothing', () => {
  // The worker hands the prompt to the common sender, which types paneTyped(text). After runAgent's
  // step that is paneTyped(neutralizeAtMentions(text)); before it, it was paneTyped(text).
  const CASES = [
    RAW,
    `${AT}`,
    `${AT}${AT} ${AT}${AT}`,
    `a ;${AT}b ;;;${AT}c`,
    `line one\r\n${AT}two\rthree ${AT}four`,
    `ctl\u0007${AT}x \u001b${AT}y`,
    // form feed and vertical tab are whitespace to the at-sign step AND control characters to the pane
    `ff\u000c${AT}x vt\u000b${AT}y`,
    `nbsp ${AT}x thin ${AT}y wide　${AT}z bom﻿${AT}w`,
    `already ${BS}${AT}escaped and ${BS}${BS}${AT}twice`,
    '',
    'no at-sign at all',
  ]

  it('paneTyped after the runAgent step equals paneTyped alone, for every case', () => {
    for (const c of CASES) expect(paneTyped(neutralizeAtMentions(c)), JSON.stringify(c)).toBe(paneTyped(c))
  })

  it('the runAgent step itself is idempotent', () => {
    for (const c of CASES) expect(neutralizeAtMentions(neutralizeAtMentions(c)), JSON.stringify(c)).toBe(neutralizeAtMentions(c))
  })

  it('the cases are not vacuous: most of them change under the mapping', () => {
    expect(CASES.filter((c) => neutralizeAtMentions(c) !== c).length).toBeGreaterThanOrEqual(7)
  })
})
