import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMAIL_GATE_MATCHER } from '../web/agent-scaffold.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/email-send-gate.mjs'

// EMAILGATEDRIFT902: the repo exports ONE canonical email-gate matcher
// (EMAIL_GATE_MATCHER, agent-scaffold.ts) and the sub-agent scaffold uses it
// -- but the main agent's hooks in the tracked .claude/settings.json were a
// HAND-COPIED matcher list, and it drifted: the copy-gate list was missing
// .*manage_email.* even though the constant's own comment cites a REAL
// manage_email send that bypassed the gate (2026-08-10). A hand-maintained
// copy of a canonical value will drift again; this test closes the CLASS by
// checking the settings.json matcher coverage against the constant itself.
// If the constant grows a new alternative, this goes red until settings.json
// follows.
const ROOT = join(__dirname, '..', '..')
const SETTINGS = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf-8')) as {
  hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] }
}

// Every '|'-alternative of the canonical matcher. Splitting is safe here: the
// constant is a flat alternation of full-match tokens by construction.
const CANONICAL = EMAIL_GATE_MATCHER.split('|')

// The email-send surfaces of the MAIN agent. The copy gate also audits the
// telegram reply tool -- that is an allowed EXTRA surface, not email drift,
// so the assertion is coverage (every canonical alternative present), not
// set-equality.
const EMAIL_HOOKS = ['outgoing-copy-gate.py', 'email-approval-gate.py']

function matcherAlternativesFor(script: string): string[] {
  const entries = SETTINGS.hooks?.PreToolUse ?? []
  return entries
    .filter((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes(script)))
    .flatMap((e) => (e.matcher ?? '').split('|'))
}

describe('main-agent email hook matchers cover the canonical EMAIL_GATE_MATCHER', () => {
  for (const script of EMAIL_HOOKS) {
    it(`${script} covers every alternative of EMAIL_GATE_MATCHER`, () => {
      const present = matcherAlternativesFor(script)
      expect(present.length, `${script} is not wired in .claude/settings.json PreToolUse at all`).toBeGreaterThan(0)
      const missing = CANONICAL.filter((alt) => !present.includes(alt))
      expect(missing, `${script} matcher list drifted from EMAIL_GATE_MATCHER -- missing: ${missing.join(', ')}`).toEqual([])
    })
  }

  it('the canonical matcher still names the manage_email bypass class (2026-08-10)', () => {
    // If someone narrows the constant itself, the settings coverage above
    // would pass vacuously -- pin the known bypass class in the constant.
    expect(CANONICAL).toContain('.*manage_email.*')
    expect(CANONICAL).toContain('.*send_email.*')
    expect(CANONICAL).toContain('Bash')
  })

  it('the canonical matcher reaches draft_email on the Gmail MCP the fleet runs (MATCHERGMAILSEG920)', () => {
    // The gate's DRAFT_TOOL_RE has always covered draft_email, but a hook that
    // never FIRES cannot deny anything: the old `.*[Gg]mail__.*` needed the
    // literal segment `gmail__`, and this server's segment is
    // `gmail-autoauth-mcp__`. The regression this pins is the whole chain --
    // matcher fires AND the gate denies -- not just the regex.
    const full = new RegExp(`^(${EMAIL_GATE_MATCHER})$`)
    const tool = 'mcp__server-gmail-autoauth-mcp__draft_email'
    expect(full.test(tool), 'matcher must fire for the tool the fleet actually has').toBe(true)
    const verified = (a: string) => a === 'known@vlbbtab.com'
    expect(gateDecision(tool, { to: 'invented@example.com' }, verified).deny).toBe(true)
    expect(gateDecision(tool, { to: 'known@vlbbtab.com' }, verified).deny).toBe(false)
    // A name-keyed matcher goes blind on the next new server name, so the draft
    // surface is pinned by the OPERATION too: a server with no gmail in its name.
    expect(full.test('mcp__whatever_mail_server__draft_email')).toBe(true)
    // Read tools on the same server stay out of the deny path (the hook may
    // fire for them; the gate is what decides, and it must say no-deny).
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__read_email', {}, verified).deny).toBe(false)
  })

  it('the canonical matcher reaches the claude.ai Gmail connector (GMAILCONNECTOR914)', () => {
    // Full-match regex against the qualified tool name, as the harness does.
    // The connector's segment is claude_ai_Gmail (one underscore before Gmail),
    // which neither .*send_email.* nor .*manage_email.* ever matched.
    const full = new RegExp(`^(${EMAIL_GATE_MATCHER})$`)
    for (const tool of ['send_message', 'reply', 'forward', 'create_draft', 'update_draft']) {
      expect(full.test(`mcp__claude_ai_Gmail__${tool}`), tool).toBe(true)
    }
    expect(full.test('mcp__gmail__send_email')).toBe(true)
    expect(full.test('mcp__plugin_telegram_telegram__reply')).toBe(false)
    expect(full.test('Read')).toBe(false)
  })
})
