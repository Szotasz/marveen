import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/email-send-gate.mjs'
import { injectEmailSendGate, agentGetsEmailGate } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

// The PreToolUse gate decision: which tool calls count as outbound email-send.
describe('gateDecision', () => {
  it('blocks any MCP send_email tool (name-agnostic)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__send_email', {}).deny).toBe(true)
    // a differently-named gmail server in a customer install is still gated
    expect(gateDecision('mcp__some_other_gmail__send_email', {}).deny).toBe(true)
  })

  it('allows email READ/draft tools (only sending is gated)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__search_emails', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__read_email', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__draft_email', {}).deny).toBe(false)
  })

  // @aaronsb/google-workspace-mcp multiplexes read/draft/send behind one tool,
  // so the gate has to read the operation + draft flag, not just the name.
  // This replaces the server's draft-only-email policy, which blocks drafting too.
  describe('manage_email (multiplexed google-workspace tool)', () => {
    const call = (input: Record<string, unknown>) =>
      gateDecision('mcp__google-workspace__manage_email', input)

    it('blocks the outbound operations when no draft is asked for', () => {
      for (const operation of ['send', 'reply', 'replyAll', 'forward']) {
        expect(call({ operation }).deny).toBe(true)
        expect(call({ operation }).kind).toBe('draft-required')
        expect(call({ operation, draft: false }).deny).toBe(true)
      }
    })

    it('allows the same operations when they only create a draft', () => {
      for (const operation of ['send', 'reply', 'replyAll', 'forward']) {
        expect(call({ operation, draft: true }).deny).toBe(false)
      }
    })

    it('allows read-shaped operations', () => {
      for (const operation of ['search', 'read', 'triage', 'labels', 'threads', 'modify']) {
        expect(call({ operation }).deny).toBe(false)
      }
    })

    it('fails safe on a missing or non-boolean draft flag', () => {
      expect(call({ operation: 'send', draft: 'yes' }).deny).toBe(true)
      expect(call({ operation: 'send', draft: 1 }).deny).toBe(true)
      expect(call({}).deny).toBe(false) // no operation at all is not send-shaped
      // the string 'true' survives a JSON round-trip that stringified the flag
      expect(call({ operation: 'send', draft: 'true' }).deny).toBe(false)
    })

    it('is name-agnostic across server prefixes but does not match look-alikes', () => {
      expect(gateDecision('manage_email', { operation: 'send' }).deny).toBe(true)
      expect(gateDecision('mcp__other__manage_email', { operation: 'send' }).deny).toBe(true)
      expect(gateDecision('manage_emails_bulk', { operation: 'send' }).deny).toBe(false)
    })
  })

  it('blocks Bash mail-send commands', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('python3 scripts/support-mail/send.py --to x@y.hu').deny).toBe(true)
    expect(bash('curl -s -X POST https://api.resend.com/emails -d @body.json').deny).toBe(true)
    expect(bash('echo hi | sendmail user@host').deny).toBe(true)
    expect(bash('swaks --to a@b.c --server smtp').deny).toBe(true)
  })

  it('blocks the graph-mail.ts CLI send path (PR #668) and direct sendMail() calls', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash('npx tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash(`node -e "require('./src/graph-mail.js').sendMail({to:'a@b.hu'})"`).deny).toBe(true)
    // read-only graph-mail subcommands are NOT send-shaped, so they pass through
    // this gate untouched (they still can't do anything a sub-agent shouldn't:
    // verify/list only read the scoped mailbox)
    expect(bash('tsx scripts/graph-mail.ts verify').deny).toBe(false)
    expect(bash('tsx scripts/graph-mail.ts list --unread').deny).toBe(false)
  })

  it('allows ordinary Bash that does not send mail', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('git status').deny).toBe(false)
    expect(bash('npm run build').deny).toBe(false)
    expect(bash('curl -s http://localhost:3420/api/messages').deny).toBe(false)
    // mentioning "resend" without an email/send verb nearby is not gated
    expect(bash('grep resend src/foo.ts').deny).toBe(false)
  })
})

// The main-exempt guard: every sub-agent is gated, the main agent never is.
// Mirrors security-profile-resolution.test.ts -- pure, keyed on the configured
// MAIN_AGENT_ID (not a hardcoded name), so a customer install exempts its own owner.
describe('agentGetsEmailGate', () => {
  it('gates every sub-agent', () => {
    expect(agentGetsEmailGate('samu')).toBe(true)
    expect(agentGetsEmailGate('boni')).toBe(true)
    expect(agentGetsEmailGate('zara')).toBe(true)
  })

  it('NEVER gates the main agent (it retains email-send)', () => {
    expect(agentGetsEmailGate(MAIN_AGENT_ID)).toBe(false)
  })
})

// The settings.json wiring that installs the hook for a sub-agent.
describe('injectEmailSendGate', () => {
  it('adds the PreToolUse email-gate hook', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(hooks).toHaveLength(1)
    expect(hooks[0].matcher).toBe('Bash|.*send_email.*|.*manage_email.*')
    const inner = (hooks[0].hooks as Array<{ command: string }>)[0]
    expect(inner.command).toContain('email-send-gate.mjs')
  })

  // Regression (2026-08-10): the matcher is full-matched against the tool name,
  // and MCP tools arrive qualified as `mcp__<server>__<tool>` -- with the old
  // bare `send_email|manage_email` alternatives the hook never fired for ANY MCP
  // mail tool, so both the sub-agent governance gate and the draft-kapu were
  // silently open. Assert against the real qualified names.
  it('matcher full-matches qualified MCP tool names', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    const re = new RegExp(`^(?:${hooks[0].matcher as string})$`)
    expect(re.test('mcp__google-workspace__manage_email')).toBe(true)
    expect(re.test('mcp__server-gmail-autoauth-mcp__send_email')).toBe(true)
    expect(re.test('manage_email')).toBe(true)
    expect(re.test('send_email')).toBe(true)
    expect(re.test('Bash')).toBe(true)
    expect(re.test('Read')).toBe(false)
    expect(re.test('mcp__google-workspace__manage_calendar')).toBe(false)
  })

  it('is idempotent (no duplicate entries on re-apply / respawn)', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(hooks).toHaveLength(1)
  })

  it('preserves existing hooks (e.g. PreCompact) and other PreToolUse entries', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
        PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'other.sh' }] }],
      },
    }
    injectEmailSendGate(s)
    const hooks = s.hooks as Record<string, unknown>
    expect((hooks.PreCompact as unknown[]).length).toBe(1)
    const pre = hooks.PreToolUse as Array<Record<string, unknown>>
    // the unrelated WebFetch entry is kept, the email-gate is appended
    expect(pre).toHaveLength(2)
    expect(pre.some((e) => JSON.stringify(e).includes('email-send-gate.mjs'))).toBe(true)
    expect(pre.some((e) => e.matcher === 'WebFetch')).toBe(true)
  })
})
