import { describe, it, expect } from 'vitest'
import { classifyAgentResult } from '../agent.js'

// Issue #209: a usage-policy (AUP) block or any API/execution error must NOT be
// propagated as generated content -- otherwise runAgent's caller writes the
// block text into CLAUDE.md / SOUL.md. classifyAgentResult is the pure gate:
// usable ONLY on a clean success; everything else returns text=null + a reason.
describe('classifyAgentResult', () => {
  it('passes through a clean success result as content', () => {
    const c = classifyAgentResult({ subtype: 'success', is_error: false, api_error_status: null, result: '# CLAUDE.md\n...' })
    expect(c.blocked).toBe(false)
    expect(c.text).toBe('# CLAUDE.md\n...')
  })

  it('blocks a success-subtype result flagged is_error (AUP block surfaced on success)', () => {
    const c = classifyAgentResult({ subtype: 'success', is_error: true, api_error_status: 403, result: 'I cannot help with violative cyber content.' })
    expect(c.blocked).toBe(true)
    expect(c.text).toBeNull() // block text must NOT become content
    expect(c.reason).toContain('is_error=true')
    expect(c.reason).toContain('api_error_status=403')
  })

  it('blocks an error_during_execution subtype (no result field on SDKResultError)', () => {
    const c = classifyAgentResult({ subtype: 'error_during_execution', is_error: true, errors: ['Usage policy violation', 'stop'] })
    expect(c.blocked).toBe(true)
    expect(c.text).toBeNull()
    expect(c.reason).toContain('subtype=error_during_execution')
    expect(c.reason).toContain('Usage policy violation')
  })

  it('blocks error_max_turns / error_max_budget_usd', () => {
    expect(classifyAgentResult({ subtype: 'error_max_turns', is_error: true }).blocked).toBe(true)
    expect(classifyAgentResult({ subtype: 'error_max_budget_usd', is_error: true }).blocked).toBe(true)
  })

  it('blocks a success result carrying an api_error_status even if is_error is false', () => {
    const c = classifyAgentResult({ subtype: 'success', is_error: false, api_error_status: 400, result: 'blocked' })
    expect(c.blocked).toBe(true)
    expect(c.text).toBeNull()
  })

  it('includes a result snippet in the reason for diagnosis (but never as content)', () => {
    const c = classifyAgentResult({ subtype: 'error_during_execution', is_error: true, result: 'This request was blocked by the usage policy.' })
    expect(c.text).toBeNull()
    expect(c.reason).toContain('resultSnippet=')
    expect(c.reason).toContain('usage policy')
  })

  it('treats a success with a non-string result as no content (text=null, not blocked)', () => {
    const c = classifyAgentResult({ subtype: 'success', is_error: false, api_error_status: null, result: undefined })
    expect(c.blocked).toBe(false)
    expect(c.text).toBeNull()
  })

  it('never returns the block text as content even when result is a long policy message', () => {
    const policy = 'X'.repeat(5000)
    const c = classifyAgentResult({ subtype: 'success', is_error: true, result: policy })
    expect(c.text).toBeNull()
    // snippet capped, full policy text not leaked into reason
    expect((c.reason ?? '').length).toBeLessThan(400)
  })
})
