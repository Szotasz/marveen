import { describe, it, expect } from 'vitest'
import {
  renderHeartbeatClaudeMd,
  shouldBootHeartbeatAgent,
  type HeartbeatIdentity,
} from '../web/heartbeat-agent-scaffold.js'

// A fully generic identity -- no real deployment values. The renderer is
// pure, so every operator-specific string in its output must trace back to
// one of these fields.
const ID: HeartbeatIdentity = {
  ownerName: 'Nina',
  botName: 'Helios',
  mainAgentId: 'helios',
  storeDir: '/srv/app/store',
  dashboardOrigin: 'http://localhost:3420',
  calendarAccount: 'nina@example.com',
}

describe('renderHeartbeatClaudeMd', () => {
  it('threads the owner name into the role + hard rules', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain("across Nina's systems")
    expect(out).toContain('you NEVER contact Nina directly')
  })

  it('names the main agent as the relay target by display name', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('hand the result to the main agent (Helios)')
  })

  it('routes the inter-agent message to the main agent id', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('"to":"helios"')
    // The sender is always the fixed heartbeat agent id.
    expect(out).toContain('"from":"heartbeat"')
  })

  it('uses the supplied store dir (absolute) for the DB and token paths', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('/srv/app/store/claudeclaw.db')
    expect(out).toContain('cat /srv/app/store/.dashboard-token')
  })

  it('uses the supplied dashboard origin for the messages API', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('http://localhost:3420/api/messages')
  })

  it('targets the configured calendar account when one is set', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('against `nina@example.com`')
  })

  it('falls back to the MCP primary calendar when no account is set', () => {
    const out = renderHeartbeatClaudeMd({ ...ID, calendarAccount: '' })
    expect(out).toContain('your primary calendar')
    // No dangling "against `<empty>`" -- the empty case must not emit a
    // backtick-quoted account at all.
    expect(out).not.toContain('against `')
    // The empty account is the shipped default, so the rendered file must
    // then carry no email address whatsoever.
    expect(out.match(/[\w.+-]+@[\w.-]+/g) ?? []).toEqual([])
  })

  it('emits no email beyond the configured calendar account', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The configured account is the ONLY address allowed in the output;
    // a previously hardcoded personal address would add a second one.
    const emails = out.match(/[\w.+-]+@[\w.-]+/g) ?? []
    expect(emails).toEqual(['nina@example.com'])
  })

  it('emits no absolute path outside the supplied store dir', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The generic identity uses /srv/app/store; any leftover home-dir
    // hardcode would surface as a /Users/ or /home/ path.
    expect(out).not.toMatch(/\/Users\//)
    expect(out).not.toMatch(/\/home\//)
  })

  it('carries no upstream default identity beyond the params', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // With a non-default owner/bot, the upstream default names must not
    // leak through from any hardcoded string.
    expect(out).not.toMatch(/Szabolcs|Szabi|Marveen/)
  })

  it('contains no em-dash (project style rule)', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // Build the em-dash (U+2014) via fromCharCode so this source file
    // itself stays em-dash-free.
    expect(out).not.toContain(String.fromCharCode(0x2014))
  })

  it('preserves the no-outbound-channel hard contract', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('**NEVER** call `reply` / Telegram / Slack tools.')
    expect(out).toContain('You are headless')
  })

  it('uses the heartbeat-summary API for kanban (card 776e800a, done-card exclusion delegated to the API)', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The Kanban section now uses the dashboard API instead of a manual SQLite
    // query, so done-card exclusion is enforced server-side. Verify the scaffold
    // points the agent at the API endpoint and mentions that only unfinished
    // cards are returned (so a done urgent card is not reported as active).
    expect(out).toContain('api/kanban/heartbeat-summary')
    expect(out).toContain('never archived, never')
    expect(out).toContain('done')
  })

  it('is fully driven by the identity -- distinct configs render distinctly', () => {
    const a = renderHeartbeatClaudeMd(ID)
    const b = renderHeartbeatClaudeMd({
      ownerName: 'Omar',
      botName: 'Atlas',
      mainAgentId: 'atlas',
      storeDir: '/data/store',
      dashboardOrigin: 'http://localhost:9000',
      calendarAccount: '',
    })
    expect(a).not.toBe(b)
    expect(b).toContain("across Omar's systems")
    expect(b).toContain('"to":"atlas"')
    expect(b).toContain('/data/store/claudeclaw.db')
    expect(b).toContain('http://localhost:9000/api/messages')
  })
})

describe('shouldBootHeartbeatAgent', () => {
  it('boots only when respawn-enabled AND agent-enabled', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: true, agentEnabled: true })).toBe(true)
  })

  it('does not boot when the agent is not opted in (default off)', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: true, agentEnabled: false })).toBe(false)
  })

  it('does not boot on a respawn-gated-off host even if opted in', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: false, agentEnabled: true })).toBe(false)
  })

  it('does not boot when both gates are off', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: false, agentEnabled: false })).toBe(false)
  })
})

// HBMEMBLIND807 -> HBMEMBLIND819: the hot-memory metric went through TWO
// contracts, and both failures are why the current one exists. 807: a
// prose-only bullet let the agent compose its own SQL (reported 0 beside 3
// hot memories); the fix shipped a ready-made query with "do not rewrite the
// query". 819: that failed too -- post-compact rounds reconstructed the query
// from memory with agent_id='heartbeat' and reported 0 for 24h straight
// (14/14, real value 2 in three rounds). Current contract: the number is
// computed server-side (countNewHotMemories, served as
// counts.new_hot_memories_1h on /api/kanban/heartbeat-summary) and the
// scaffold tells the agent to COPY it -- there is no query left to rewrite.
describe('hot-memory metric is an endpoint number, never an agent-run query (HBMEMBLIND819)', () => {
  it('points the agent at counts.new_hot_memories_1h from the heartbeat-summary call', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('counts.new_hot_memories_1h')
  })

  it('ships NO runnable hot-memory SQL anywhere in the prompt', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The exact surface that drifted twice: a memories/hot query the agent
    // could run (and, measured, rewrite). Shape-agnostic: any SQL touching
    // the memories table near a hot filter is out of contract.
    expect(out).not.toMatch(/FROM memories[\s\S]{0,120}category='hot'/)
    expect(out).not.toContain('do not rewrite the query')
  })

  it('degrades a missing field to "no data", never to a self-run query or a zero', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('nincs adat (a summary nem adja)')
  })
})

// HBWARN807: the warnings metric was unfalsifiable -- it pointed at a source
// that does not exist (no status column on memories, no such log table), so
// it could only ever render 'none'. It was removed. This contract stops it
// from creeping back WITHOUT a real, ready-made query behind it.
describe('no unfalsifiable warnings metric (HBWARN807)', () => {
  it('the report format has no bare "warnings:" output line', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The removed line was `- warnings: <none | comma-separated>`. Any warnings
    // OUTPUT line must be backed by a query; a bare template line is the defect.
    expect(out).not.toMatch(/^\s*-\s*warnings:/m)
  })

  it('mentions status=warning only inside the guard comment, never in a query block', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The string may appear once, in the HBWARN807 explanation naming the dead
    // source. It must NOT appear inside a ```-fenced block (i.e. as a query the
    // agent is told to run).
    const fences = out.split('```')
    for (let i = 1; i < fences.length; i += 2) {
      expect(fences[i]).not.toContain("status='warning'")
    }
    // And it never appears as an actual sqlite invocation anywhere.
    expect(out).not.toMatch(/sqlite3[^\n]*status='warning'/)
  })

  it('if warnings is mentioned at all, it is only the guard comment demanding a real query', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // Every surviving "warning" mention must sit in the HBWARN807 explanation,
    // never as a metric the agent is told to emit. Proxy: no "warning" line
    // appears inside a ```-fenced report template block.
    const fences = out.split('```')
    // odd indices are inside fenced blocks
    for (let i = 1; i < fences.length; i += 2) {
      expect(fences[i].toLowerCase()).not.toContain('warning')
    }
  })
})

describe('deferred MCP tools (HBCALMCP808)', () => {
  it('the calendar step teaches the ToolSearch select protocol', () => {
    const md = renderHeartbeatClaudeMd(ID)
    // The load-bearing line: without it, a deferred calendar tool reads as
    // absent and the section silently goes empty (measured 2026-08-08/09:
    // 13 not-available reports, zero ToolSearch calls, all 13 tools present
    // in the session's own deferred list).
    expect(md).toContain('select:mcp__server-google-calendar-mcp__list-events')
    // "not available" may only be claimed after ToolSearch also failed.
    expect(md).toMatch(/ONLY[\s\S]{0,80}ToolSearch itself cannot surface/)
  })
})
