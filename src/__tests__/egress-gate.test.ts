// The WebFetch egress gate: what it blocks, and what it now records about a
// block.
//
// The gate decides on the URL alone, so a main agent and a quarantine-reader
// sub-agent look identical to it -- which is why the sub-agent path the block
// message prescribes is itself blocked (kanban #224). Whether a caller-aware
// tier can be built at all depends on the PreToolUse payload carrying a field
// that identifies the caller, and that question is answered by recording the
// payload's FIELD NAMES on every block. Names only: this log is read casually
// and a value could be a url, a prompt or a secret.
//
// The gate is a .mjs hook script run by Claude Code, not application code. It
// guards its own entry point (isInvokedDirectly), so importing it here runs no
// side effects.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { isEgressBlocked, payloadKeySignature } from '../../scripts/hooks/egress-gate.mjs'

describe('what the gate lets through', () => {
  it('passes a built-in allowed prefix', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://api.github.com/repos/a/b' })).toBe(false)
  })

  it('blocks arbitrary web content', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://hnrss.org/frontpage' })).toBe(true)
  })

  it('ignores every tool that is not WebFetch', () => {
    expect(isEgressBlocked('Bash', { command: 'curl https://hnrss.org/frontpage' })).toBe(false)
  })

  it('does not fall for a prefix-extension lookalike', () => {
    // 'https://api.github.com.evil.com/' does not start with the allowed
    // prefix, because the prefix carries its trailing slash.
    expect(isEgressBlocked('WebFetch', { url: 'https://api.github.com.evil.com/x' })).toBe(true)
  })

  it('matches a runtime domain on the hostname, not on the string', () => {
    const list = { domains: ['api.frankfurter.app'], prefixes: [] }
    expect(isEgressBlocked('WebFetch', { url: 'https://api.frankfurter.app/latest' }, list)).toBe(false)
    // The domain appearing in a query string must not open the gate.
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.com/?x=api.frankfurter.app' }, list)).toBe(true)
  })

  it('allows a subdomain of a runtime domain', () => {
    const list = { domains: ['example.com'], prefixes: [] }
    expect(isEgressBlocked('WebFetch', { url: 'https://docs.example.com/x' }, list)).toBe(false)
  })

  it('blocks an unparseable url instead of throwing', () => {
    expect(isEgressBlocked('WebFetch', { url: 'not a url' }, { domains: ['example.com'], prefixes: [] })).toBe(true)
  })
})

describe('what a block records about the caller', () => {
  it('lists the payload field names, sorted', () => {
    const keys = payloadKeySignature({
      tool_name: 'WebFetch',
      session_id: 's1',
      cwd: '/home/x',
      tool_input: { url: 'https://hnrss.org/frontpage' },
    })
    expect(keys).toBe('cwd,session_id,tool_input,tool_name')
  })

  it('never records a value -- not from the top level, not from a nested object', () => {
    // The whole point: this line goes into a log an operator greps. A url, a
    // prompt or a token must not ride along with the diagnostic.
    const keys = payloadKeySignature({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://secret.example/path?token=SHOULD-NOT-APPEAR' },
      transcript_path: '/home/viktor/.claude/projects/p/SHOULD-NOT-APPEAR.jsonl',
    })
    expect(keys).not.toContain('SHOULD-NOT-APPEAR')
    expect(keys).not.toContain('https://')
    expect(keys).toBe('tool_input,tool_name,transcript_path')
  })

  it('survives a payload that is not an object', () => {
    for (const bad of [null, undefined, 'string', 42, ['a']]) {
      expect(payloadKeySignature(bad as never)).toBe('')
    }
  })
})
