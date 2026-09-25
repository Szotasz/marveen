import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  gateDecision,
  extractAddress,
  threadReplyRequest,
  threadMembershipDecision,
  extractParticipants,
  fetchThreadParticipants,
  buildThreadDenyMsg,
  // @ts-expect-error -- plain .mjs hook script, no types
} from '../../scripts/email-send-gate.mjs'
import {
  injectEmailSendGate,
  hasThreadReplyCapability,
  emailGateCommandStale,
  EMAIL_THREAD_REPLY_CAPABILITY,
  EMAIL_THREAD_REPLY_FLAG,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'email-send-gate.mjs')

// Thread-scoped reply narrowing (BONIMAIL910, owner decision 2026-09-10):
// ONE capability-holding agent may send, but only into an existing thread and
// only to addresses already in it. Everything here proves BOTH arms -- the
// in-thread allow AND the out-of-thread deny -- plus the fail-closed edges.

describe('extractAddress', () => {
  it('parses bare addresses and Name <addr> forms, lowercased', () => {
    expect(extractAddress('Sara@Example.COM')).toBe('sara@example.com')
    expect(extractAddress('Kiss Sara <sara@example.com>')).toBe('sara@example.com')
    expect(extractAddress('  x@y.hu  ')).toBe('x@y.hu')
  })

  it('returns empty on anything that is not a single clean address', () => {
    expect(extractAddress('not-an-address')).toBe('')
    expect(extractAddress('a@b.hu, c@d.hu')).toBe('')
    expect(extractAddress('')).toBe('')
    expect(extractAddress(null)).toBe('')
    expect(extractAddress({})).toBe('')
  })
})

describe('threadReplyRequest', () => {
  it('accepts a well-formed reply into an existing thread', () => {
    const r = threadReplyRequest({
      threadId: '198f2b4c7d3e1a09',
      to: ['partner@ceg.hu'],
      cc: ['Masik Fel <masik@ceg.hu>'],
    })
    expect(r.ok).toBe(true)
    expect(r.threadId).toBe('198f2b4c7d3e1a09')
    expect(r.recipients).toEqual(['partner@ceg.hu', 'masik@ceg.hu'])
  })

  it('denies without a threadId (a new thread can never be opened)', () => {
    expect(threadReplyRequest({ to: ['partner@ceg.hu'] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: '', to: ['x@y.hu'] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: '   ', to: ['x@y.hu'] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: 42, to: ['x@y.hu'] }).ok).toBe(false)
  })

  it('denies with no recipients or an unparseable recipient (fail-closed)', () => {
    expect(threadReplyRequest({ threadId: 't1' }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: 't1', to: [] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: 't1', to: ['jo@cim.hu', 'nem cim'] }).ok).toBe(false)
  })

  it('counts bcc as recipients too (no hidden new address)', () => {
    const r = threadReplyRequest({ threadId: 't1', to: ['a@b.hu'], bcc: ['rejtett@uj.hu'] })
    expect(r.ok).toBe(true)
    expect(r.recipients).toContain('rejtett@uj.hu')
  })
})

describe('threadMembershipDecision (the two control arms)', () => {
  const participants = ['szota.szabolcs.ai@gmail.com', 'partner@ceg.hu']

  it('ALLOWS a recipient already in the thread (control 1: the open arm)', () => {
    expect(threadMembershipDecision(['partner@ceg.hu'], participants).allow).toBe(true)
  })

  it('DENIES a recipient outside the thread (control 2: the closed arm)', () => {
    const v = threadMembershipDecision(['idegen@masik.hu'], participants)
    expect(v.allow).toBe(false)
    expect(v.reason).toContain('idegen@masik.hu')
  })

  it('denies when ANY recipient is outside, even if others are inside', () => {
    expect(threadMembershipDecision(['partner@ceg.hu', 'idegen@masik.hu'], participants).allow).toBe(false)
  })

  it('is case-insensitive on the participant side', () => {
    expect(threadMembershipDecision(['partner@ceg.hu'], ['Partner@Ceg.HU']).allow).toBe(true)
  })

  it('denies on an empty participant list (fail-closed)', () => {
    expect(threadMembershipDecision(['partner@ceg.hu'], []).allow).toBe(false)
    expect(threadMembershipDecision(['partner@ceg.hu'], undefined).allow).toBe(false)
  })
})

describe('extractParticipants', () => {
  it('collects From/To/Cc/Reply-To addresses across the thread, deduped', () => {
    const thread = {
      messages: [
        { payload: { headers: [
          { name: 'From', value: 'Kiss Sara <sara@ceg.hu>' },
          { name: 'To', value: 'szota.szabolcs.ai@gmail.com, Masik <masik@ceg.hu>' },
          { name: 'Subject', value: 'nem cim, nem szamit' },
        ] } },
        { payload: { headers: [
          { name: 'from', value: 'szota.szabolcs.ai@gmail.com' },
          { name: 'Cc', value: 'SARA@CEG.HU' },
        ] } },
      ],
    }
    const got = extractParticipants(thread)
    expect(got.sort()).toEqual(['masik@ceg.hu', 'sara@ceg.hu', 'szota.szabolcs.ai@gmail.com'].sort())
  })

  it('returns [] on an empty or malformed payload', () => {
    expect(extractParticipants({})).toEqual([])
    expect(extractParticipants(null)).toEqual([])
    expect(extractParticipants({ messages: [{}] })).toEqual([])
  })
})

describe('fetchThreadParticipants (injected I/O, no network)', () => {
  const keys = JSON.stringify({ installed: {
    client_id: 'cid', client_secret: 'cs', token_uri: 'https://oauth2.googleapis.com/token',
  } })
  const thread = {
    messages: [{ payload: { headers: [{ name: 'From', value: 'partner@ceg.hu' }] } }],
  }

  it('uses the stored access token while it is fresh', async () => {
    const creds = JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expiry_date: Date.now() + 3_600_000 })
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(url)
      expect(init?.headers?.Authorization).toBe('Bearer AT')
      return { ok: true, json: async () => thread }
    }
    const got = await fetchThreadParticipants('t1', {
      fetchImpl,
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })
    expect(got).toEqual(['partner@ceg.hu'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/threads/t1?format=metadata')
  })

  it('refreshes an expired token first', async () => {
    const creds = JSON.stringify({ access_token: 'OLD', refresh_token: 'RT', expiry_date: Date.now() - 1000 })
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(url)
      if (url.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'NEW' }) }
      expect(init?.headers?.Authorization).toBe('Bearer NEW')
      return { ok: true, json: async () => thread }
    }
    const got = await fetchThreadParticipants('t1', {
      fetchImpl,
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })
    expect(got).toEqual(['partner@ceg.hu'])
    expect(calls).toHaveLength(2)
  })

  it('throws on refresh failure, thread-fetch failure, or unreadable creds', async () => {
    const creds = JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expiry_date: 0 })
    await expect(fetchThreadParticipants('t1', {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })).rejects.toThrow()
    await expect(fetchThreadParticipants('t1', {
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      readFile: () => { throw new Error('ENOENT') },
    })).rejects.toThrow()
  })

  it('URL-encodes the threadId (no path escape into another API route)', async () => {
    const creds = JSON.stringify({ access_token: 'AT', expiry_date: Date.now() + 3_600_000 })
    let seen = ''
    await fetchThreadParticipants('a/../b?x=1', {
      fetchImpl: async (url: string) => { seen = url; return { ok: true, json: async () => thread } },
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })
    expect(seen).toContain('/threads/a%2F..%2Fb%3Fx%3D1?')
  })
})

// gateDecision itself must be unchanged in effect: send_email still denies for
// everyone; only the entrypoint's flagged path can narrow it.
describe('gateDecision regression (kind tag added, behavior unchanged)', () => {
  it('still denies every send_email, now tagged for the entrypoint', () => {
    const d = gateDecision('mcp__server-gmail-autoauth-mcp__send_email', { threadId: 't1', to: ['a@b.hu'] })
    expect(d.deny).toBe(true)
    expect(d.kind).toBe('send_email')
  })
})

describe('hasThreadReplyCapability', () => {
  it('grants only a sub-agent that carries the capability', () => {
    expect(hasThreadReplyCapability('boni', [EMAIL_THREAD_REPLY_CAPABILITY])).toBe(true)
    expect(hasThreadReplyCapability('boni', [])).toBe(false)
    expect(hasThreadReplyCapability('samu', ['other:cap'])).toBe(false)
  })

  it('never applies to the main agent (it is not gated at all)', () => {
    expect(hasThreadReplyCapability(MAIN_AGENT_ID, [EMAIL_THREAD_REPLY_CAPABILITY])).toBe(false)
  })
})

describe('injectEmailSendGate with the thread-reply flag', () => {
  const innerCommand = (s: Record<string, unknown>): string => {
    const pre = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(pre).toHaveLength(1)
    return (pre[0].hooks as Array<{ command: string }>)[0].command
  }

  it('default stays byte-identical shape: no flag', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    expect(innerCommand(s)).not.toContain(EMAIL_THREAD_REPLY_FLAG)
  })

  it('threadReply=true appends the flag to the hook command', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s, true)
    const cmd = innerCommand(s)
    expect(cmd).toContain('email-send-gate.mjs')
    expect(cmd.endsWith(` ${EMAIL_THREAD_REPLY_FLAG}`)).toBe(true)
  })

  it('re-apply toggles cleanly in both directions (respawn regenerates)', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s, true)
    injectEmailSendGate(s, false)
    expect(innerCommand(s)).not.toContain(EMAIL_THREAD_REPLY_FLAG)
    injectEmailSendGate(s, true)
    expect(innerCommand(s)).toContain(EMAIL_THREAD_REPLY_FLAG)
  })
})

describe('emailGateCommandStale (migration sees a grant AND a revocation)', () => {
  const entry = (command: string) => [{
    matcher: 'Bash|.*send_email.*|.*manage_email.*',
    hooks: [{ type: 'command', command }],
  }]
  const base = '"/usr/bin/node" "/x/scripts/email-send-gate.mjs"'

  it('flags a wired-but-unflagged entry when the capability expects the flag', () => {
    expect(emailGateCommandStale(entry(base), `${base} ${EMAIL_THREAD_REPLY_FLAG}`)).toBe(true)
  })

  it('flags a still-flagged entry after the capability was revoked', () => {
    expect(emailGateCommandStale(entry(`${base} ${EMAIL_THREAD_REPLY_FLAG}`), base)).toBe(true)
  })

  it('is quiet when the entry matches the expectation', () => {
    expect(emailGateCommandStale(entry(base), base)).toBe(false)
    const flagged = `${base} ${EMAIL_THREAD_REPLY_FLAG}`
    expect(emailGateCommandStale(entry(flagged), flagged)).toBe(false)
  })

  it('ignores unrelated entries and tolerates a missing array', () => {
    expect(emailGateCommandStale([{ matcher: 'WebFetch', hooks: [{ command: 'x' }] }], base)).toBe(false)
    expect(emailGateCommandStale(undefined, base)).toBe(false)
  })
})

// Entrypoint integration: run the real script the way the hook runner does.
// The allow arm of the LIVE thread check needs the real mailbox and is proved
// in the two-control live probe (PR body); here every hermetic arm is pinned.
describe('gate script entrypoint (spawned, no network)', () => {
  const run = (args: string[], payload: unknown, env: Record<string, string> = {}) => {
    const out = execFileSync(process.execPath, [GATE, ...args], {
      input: JSON.stringify(payload),
      timeout: 15_000,
      env: { ...process.env, ...env },
    }).toString()
    return out ? JSON.parse(out) : null
  }
  const sendPayload = (tool_input: Record<string, unknown>) => ({
    tool_name: 'mcp__server-gmail-autoauth-mcp__send_email',
    tool_input,
  })

  it('WITHOUT the flag a send_email still gets the unconditional governance deny', () => {
    const res = run([], sendPayload({ threadId: 't1', to: ['barki@ceg.hu'] }))
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
  })

  it('with the flag but NO threadId: thread-gate deny, no network touched', () => {
    const res = run([EMAIL_THREAD_REPLY_FLAG], sendPayload({ to: ['partner@ceg.hu'] }))
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('szal-kapu')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('threadId hianyzik')
  })

  it('with the flag but unreadable credentials: fail-closed deny', () => {
    const res = run(
      [EMAIL_THREAD_REPLY_FLAG],
      sendPayload({ threadId: 't1', to: ['partner@ceg.hu'] }),
      {
        GMAIL_CREDENTIALS_PATH: '/nonexistent/credentials.json',
        GMAIL_OAUTH_PATH: '/nonexistent/keys.json',
      },
    )
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('fail-closed')
  })

  it('with the flag, non-mail tools still pass (flag widens nothing else)', () => {
    expect(run([EMAIL_THREAD_REPLY_FLAG], { tool_name: 'Bash', tool_input: { command: 'git status' } })).toBeNull()
    // and a Bash SEND route stays denied even for the capable agent
    const res = run([EMAIL_THREAD_REPLY_FLAG], { tool_name: 'Bash', tool_input: { command: 'echo hi | sendmail x@y.hu' } })
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
  })

  it('deny message names the way out with the configured bot name', () => {
    expect(buildThreadDenyMsg('Marveen', 'proba')).toContain('Marveen')
    expect(buildThreadDenyMsg('Marveen', 'proba')).toContain('proba')
  })
})
