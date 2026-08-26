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
  metricsScript: '/srv/app/scripts/heartbeat-metrics.sh',
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

  it('uses the supplied store dir (absolute) for the instrument env and the token path', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The DB path itself no longer appears in the prose: the metrics
    // instrument derives it from CLAW_STORE_DIR, so the only store-dir
    // surfaces left are the instrument's env prefix and the step-3
    // message POST's token read.
    expect(out).toContain('CLAW_STORE_DIR=/srv/app/store')
    expect(out).toContain('cat /srv/app/store/.dashboard-token')
    expect(out).not.toContain('claudeclaw.db')
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

  it('does not ask the agent to filter done cards -- it cannot see them at all (was card 776e800a)', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // This assertion REPLACES the older one, which required the prose to carry
    // `priority='urgent' AND status != 'done'`. That instruction was present and
    // correct since #680, and the 09:00 report on 2026-08-04 still listed three
    // `done` cards out of five: a filter the model must re-apply every hour is
    // not a mechanism. The agent now calls an endpoint that can only return open
    // cards, so the guarantee moved from "it was told to" to "it cannot".
    expect(out).toContain('/api/kanban/heartbeat-summary')
    expect(out).not.toContain("priority='urgent' AND status != 'done'")
    expect(out).not.toMatch(/SELECT[^\n]*FROM kanban_cards/i)
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
      metricsScript: '/data/scripts/heartbeat-metrics.sh',
    })
    expect(a).not.toBe(b)
    expect(b).toContain("across Omar's systems")
    expect(b).toContain('"to":"atlas"')
    expect(b).toContain('CLAW_STORE_DIR=/data/store')
    expect(b).toContain('bash /data/scripts/heartbeat-metrics.sh')
    expect(b).toContain('http://localhost:9000/api/messages')
  })

  // 2026-08-02 (HBTZ802). The first report after a fresh restart carried
  // "09:00 (Europe/Budapest)" at 11:06 local. The transcript shows the agent
  // ran `date -u` and formatted with datetime.now(timezone.utc): the label was
  // a template constant, the number was UTC. The environment was never at
  // fault -- the spawn command is identical apart from `--continue`, no agent
  // gets a TZ var either way, and a process spawned by the same tmux server
  // prints correct local time. So the instructions must name the measurement.
  it('tells the agent to measure local time in the configured zone', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toMatch(/TZ=\S+ date \+'%Y-%m-%d %H:%M'/)
  })

  it('forbids the UTC clocks that produced the mislabelled header', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('date -u')
    expect(out).toContain('datetime.now(timezone.utc)')
    expect(out).toMatch(/Never `date -u`/)
  })

  it('does not leave a bare HH:MM placeholder in the header template', () => {
    // A literal `HH:MM` next to a zone label is what let the agent fill the
    // slot from whatever clock it happened to reach for.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).not.toContain('## Heartbeat YYYY-MM-DD HH:MM')
  })

  it('requires the calendar MCP to be called as a tool, never from a subprocess', () => {
    // Same round: the agent tried to reach the MCP server from a python
    // subprocess and reported "not accessible in subprocess context" while the
    // server was a live child of its own session.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('Call it as a TOOL, directly.')
    expect(out).toMatch(/Do not try to reach an MCP server\s+from Bash, python, curl or any other subprocess/)
  })

  it('separates "tool absent" from "call failed" so the two are not reported alike', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('calendar tool not available in this session')
    expect(out).toContain('calendar fetch failed: <reason>')
  })

  // Same investigation: the Tasks section read the `scheduled_tasks` table,
  // which holds 0 rows on this deployment while /api/schedules lists 25
  // enabled entries -- so every report said "active: 0, next: (none
  // scheduled)". A line that is always the same stops being read, which is
  // the failure this file already warns about elsewhere.
  it('reads the schedule count from the live registry, not the empty table', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('http://localhost:3420/api/schedules')
    expect(out).not.toContain('count active rows in')
    expect(out).not.toContain('next_run_at')
  })

  it('names the task_runs milliseconds trap but ships no runnable SQL for it', () => {
    // ts is epoch MILLISECONDS; a seconds comparison matches every row and
    // silently turns "last hour" into "since the beginning". This assertion
    // REPLACES the older one that required the literal
    // `(unixepoch()-3600)*1000` query in the prose: the cutoff now lives in
    // scripts/heartbeat-metrics.sh (asserted by its own conformance test),
    // and the prose only names the trap so nobody re-derives it by hand.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('MILLISECONDS')
    expect(out).toMatch(/\*1000[^\n]*cutoff/)
    expect(out).not.toMatch(/sqlite3 [^\n]*task_runs/)
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
    // Phrase updated with the instrument contract: the missing-field case
    // now surfaces as an ERROR line from the script, and the report writes
    // "nincs adat (muszer-hiba)" -- the load-bearing part is that the
    // degradation path exists and is named, and that fabricating a 0 is
    // called out as the defect.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('nincs adat (muszer-hiba)')
    expect(out).toMatch(/fabricated 0 is the defect/)
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

// HBHEREDOC819: the 18:00 round reported "empty response from
// /api/kanban/heartbeat-summary" while the endpoint served 200/3173B in 9ms
// and the SAME shell POSTed fine with the same token. The agent had composed
//   KANBAN=$(curl ...); echo "$KANBAN" | python3 << 'PY' ... PY
// -- the heredoc replaces python3's stdin, the piped data is silently lost,
// json.load reads EOF. A command the agent re-improvises every hour is not a
// mechanism (the HBMEMBLIND819 lesson, extraction-side): the scaffold now
// ships the COMPLETE one-line extractor and bans the pipe+heredoc shape.
// HBHEREDOC819 -> HBMEMBLIND819 third contract: the shipped one-liner era
// ended 2026-08-24 22:00, when a post-compact round re-composed the shipped
// extractor with a truncated format string and a missing field printed as a
// silent 0 -- the third failure of the same metric on a third layer. The
// extraction now lives in scripts/heartbeat-metrics.sh (its own conformance
// test exercises it); the prose ships NO extractor at all, only the
// instrument call and the sentinel rule.
describe('metrics come from the on-disk instrument, never from prose the agent can recompose', () => {
  it('ships the instrument call with identity-derived env and path', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain(
      'CLAW_STORE_DIR=/srv/app/store CLAW_DASHBOARD_ORIGIN=http://localhost:3420'
    )
    expect(out).toContain('bash /srv/app/scripts/heartbeat-metrics.sh')
  })

  it('ships NO runnable extractor -- the copy-surface that drifted three times', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).not.toContain('python3 -c "import json,urllib.request')
    expect(out).not.toMatch(/COUNTS urgent=%s/)
    // The endpoint may be NAMED (as the server-side source of the numbers)
    // but never fetched from the prose.
    expect(out).toContain('/api/kanban/heartbeat-summary')
    expect(out).not.toMatch(/curl[^\n]*heartbeat-summary/)
  })

  it('states the sentinel rule: known sentinel or instrument failure, never "looks like output"', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('HB_METRICS_V1')
    // The unknown-version branch is named explicitly (a future V2 under
    // these instructions must read as instrument failure, not be accepted
    // silently) -- Marveen's stipulation on HBMEMBLIND819, 2026-08-25.
    expect(out).toContain('HB_METRICS_V2')
    expect(out).toContain('muszer-hiba')
    expect(out).toMatch(/NEVER write 0/)
  })

  it('the ONLY python3-heredoc mention is the quoted example inside the ban text', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The ban must quote the forbidden shape (so the agent can recognise
    // it), and NOTHING else in the prompt may contain one. Class-level, not
    // variant-enumerated: on one line, `python3` is never followed by `<<`
    // outside the ban sentence.
    const matches = [...out.matchAll(/python3[^\n]*<</g)]
    expect(matches.length).toBe(1)
    const banStart = out.indexOf('THE SENTINEL RULE (HBMEMBLIND819)')
    expect(banStart).toBeGreaterThanOrEqual(0)
    const banEnd = out.indexOf('If the output contains', banStart)
    expect(banEnd).toBeGreaterThan(banStart)
    const idx = matches[0].index ?? -1
    expect(idx).toBeGreaterThan(banStart)
    expect(idx).toBeLessThan(banEnd)
  })

  it('names the heredoc incident so the ban survives paraphrase', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('HBHEREDOC819')
    expect(out).toMatch(/heredoc becomes python3's stdin/)
  })
})
