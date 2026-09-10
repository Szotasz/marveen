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
import { isEgressBlocked, egressDecision, payloadKeySignature } from '../../scripts/hooks/egress-gate.mjs'

const QUARANTINE = 'quarantine-reader'
const EMPTY = { domains: [], prefixes: [], quarantineDomains: [] }
// The operator flipped the reader-posture switch. Identical to EMPTY in every
// other respect, so any behaviour difference between the two objects IS the
// switch and nothing else.
const OPEN = { ...EMPTY, quarantinePosture: 'denylist' }

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

// The tier that made the gate's own escape hatch usable. A sub-agent payload
// carries `agent_type`, a main agent's does not (measured 2026-08-03) -- that
// field, and nothing else, separates the two.
describe('the quarantine tier', () => {
  const feed = { url: 'https://techcrunch.com/feed/' }

  it('lets the quarantine-reader fetch a feed on its list', () => {
    expect(isEgressBlocked('WebFetch', feed, EMPTY, QUARANTINE)).toBe(false)
    expect(egressDecision('WebFetch', feed, EMPTY, QUARANTINE).tier).toBe('quarantine')
  })

  it('STILL blocks the same url for a main agent', () => {
    // The property the whole design rests on: opening the tier for the
    // sub-agent must not open it for everyone. A main agent fetching a news
    // feed puts unwrapped, untrusted text straight into its own context.
    expect(isEgressBlocked('WebFetch', feed, EMPTY, '')).toBe(true)
    expect(isEgressBlocked('WebFetch', feed, EMPTY, undefined)).toBe(true)
  })

  it('blocks a domain the quarantine-reader was never given -- in the DEFAULT posture', () => {
    // This assertion is the owner's requirement made executable: an install
    // that never touched quarantine_reader_posture behaves exactly as before
    // the switch existed. The open behaviour lives in its own describe below
    // and is reachable only through the explicit config value.
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' }, EMPTY, QUARANTINE)).toBe(true)
  })

  it('fails closed on anything that is not an exact agent_type match', () => {
    // A typo, a rename, a spoofed-looking value: all fall through to the
    // block. A mistake here can only deny a fetch, never grant one.
    for (const bad of ['quarantine_reader', 'Quarantine-Reader', 'quarantine-reader ', 'general-purpose', null, 42]) {
      expect(isEgressBlocked('WebFetch', feed, EMPTY, bad as never)).toBe(true)
    }
  })

  it('holds the reddit promise its definition makes: RSS only', () => {
    // The sub-agent's definition allows reddit RSS feeds; hostname matching
    // alone would hand over the whole site, including the json endpoints a
    // main agent was blocked from earlier.
    expect(isEgressBlocked('WebFetch', { url: 'https://www.reddit.com/r/devops/new.rss' }, EMPTY, QUARANTINE)).toBe(false)
    expect(isEgressBlocked('WebFetch', { url: 'https://www.reddit.com/r/devops/about/rules.json' }, EMPTY, QUARANTINE)).toBe(true)
  })

  it('inherits the ordinary allowlist rather than replacing it', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://api.github.com/x' }, EMPTY, QUARANTINE)).toBe(false)
  })

  it('takes operator additions from quarantine_domains -- for the sub-agent only', () => {
    const list = { domains: [], prefixes: [], quarantineDomains: ['feeds.example.org'] }
    expect(isEgressBlocked('WebFetch', { url: 'https://feeds.example.org/rss' }, list, QUARANTINE)).toBe(false)
    // Putting a domain in the quarantine list must not open it to a main agent.
    expect(isEgressBlocked('WebFetch', { url: 'https://feeds.example.org/rss' }, list, '')).toBe(true)
  })

  it('reports the tier so the grant can be audited', () => {
    // A fetch nobody can see is a hole nobody can find: the entry point logs
    // an ALLOWED_QUARANTINE line off this tier.
    expect(egressDecision('WebFetch', { url: 'https://api.github.com/x' }, EMPTY, QUARANTINE).tier).toBe('builtin')
    expect(egressDecision('WebFetch', feed, EMPTY, QUARANTINE).tier).toBe('quarantine')
    expect(egressDecision('WebFetch', feed, EMPTY, '').tier).toBe('none')
  })
})

// The reader-posture switch (quarantine_reader_posture: "denylist"). The
// owner's terms, verbatim in code: both behaviours exist, one setting chooses,
// the allowlist stays the default because its failure direction is the one a
// human hears about. Everything in this block requires the explicit config
// value; everything above ran on EMPTY and proved the default unchanged.
describe('the open reader posture (operator opt-in)', () => {
  it('lets the reader fetch a public domain it was never given', () => {
    // The reader has `tools: WebFetch` and nothing else -- no shell, no
    // filesystem, no store -- so it holds no secret to leak, and what it
    // returns is data the caller must wrap. That is why open reading is
    // defensible for this tier and no other.
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' }, OPEN, QUARANTINE)).toBe(false)
    expect(egressDecision('WebFetch', { url: 'https://evil.example/feed' }, OPEN, QUARANTINE).tier).toBe('quarantine-open')
  })

  it('opens NOTHING for the main agent, whatever the posture says', () => {
    // The switch narrows or widens the reader only. A main agent fetching a
    // news page puts unwrapped, untrusted text straight into its own context,
    // and no config value may change that.
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' }, OPEN, '')).toBe(true)
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' }, OPEN, undefined)).toBe(true)
  })

  it('takes only the literal value "denylist" -- anything else is the default', () => {
    // A typo or a wrong type must fall back to the stricter posture, not the
    // laxer one: the misconfiguration should be heard (a refused read), not
    // silently widen the gate.
    for (const bad of ['Denylist', 'open', 'DENYLIST', true, 1, {}, null]) {
      expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' },
        { ...EMPTY, quarantinePosture: bad as never }, QUARANTINE)).toBe(true)
    }
  })

  it('refuses our own network even for the open reader, and does it BEFORE any allow path', () => {
    // Order is the substance here. The built-in prefixes include this
    // install's own dashboard, so deny rules consulted only at the quarantine
    // step would have let the open reader reach localhost through the
    // built-in tier -- the one address the deny rules exist to refuse. Found
    // by a test, not by reading.
    const internal = [
      'http://localhost:3420/api/memories',
      'http://127.0.0.1:8080/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.85.98:9000/',
      'http://192.168.1.1/',
      'http://172.20.0.5/',
      'http://100.100.0.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://printer.local/',
      'http://box.internal/',
      'http://metadata.google.internal/',
      'file:///etc/passwd',
    ]
    for (const url of internal) {
      expect(egressDecision('WebFetch', { url }, OPEN, QUARANTINE).tier).toBe('quarantine-denied')
    }
    // ...and the neighbours of those ranges stay reachable, so the rule is a
    // rule and not a superstition about numbers that look private.
    for (const url of ['http://172.15.0.5/', 'http://172.32.0.5/', 'http://11.0.0.1/', 'http://100.63.0.1/']) {
      expect(isEgressBlocked('WebFetch', { url }, OPEN, QUARANTINE)).toBe(false)
    }
  })

  it('keeps the deny rules away from the main agent and from the default posture', () => {
    // The main agent may still reach its own dashboard through the built-in
    // prefixes, and so may the DEFAULT-posture reader (its prompt never asks
    // for internal addresses, and the owner's rule is that the default
    // changes for no one).
    expect(isEgressBlocked('WebFetch', { url: 'http://localhost:3420/api/memories' }, OPEN, '')).toBe(false)
    expect(isEgressBlocked('WebFetch', { url: 'http://localhost:3420/api/memories' }, EMPTY, QUARANTINE)).toBe(false)
  })

  it('reddit: the RSS path still matches by name, and the rest opens like any public site', () => {
    // The path rule predates the switch, when hostname-only matching would
    // have handed over the whole site while the definition promised feeds. It
    // is kept because the shipped sources must not depend on the posture --
    // but in the open posture it no longer decides anything: a non-RSS reddit
    // URL is reachable for the same reason any other public URL is. Stated
    // rather than left as a surprise for whoever next reads the path callback
    // and assumes it blocks.
    expect(egressDecision('WebFetch', { url: 'https://www.reddit.com/r/devops/new.rss' }, OPEN, QUARANTINE).tier).toBe('quarantine')
    expect(egressDecision('WebFetch', { url: 'https://www.reddit.com/r/devops/about/rules.json' }, OPEN, QUARANTINE).tier).toBe('quarantine-open')
  })

  it('fails closed on anything that is not an exact agent_type match, posture notwithstanding', () => {
    for (const bad of ['quarantine_reader', 'Quarantine-Reader', 'quarantine-reader ', 'general-purpose', null, 42]) {
      expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' }, OPEN, bad as never)).toBe(true)
    }
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
