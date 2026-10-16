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

  it('uses the supplied store dir only for the step-3 token path -- no instrument env in the prose', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // HBMETRICSWIRE910: the WORKER runs the instrument, so the prose ships
    // no CLAW_* env prefix and no DB path -- the only store-dir surface
    // left is the message POST's token read.
    expect(out).toContain('cat /srv/app/store/.dashboard-token')
    expect(out).not.toContain('CLAW_STORE_DIR=')
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

  it('falls back to the dashboard-configured calendar when no account is set', () => {
    const out = renderHeartbeatClaudeMd({ ...ID, calendarAccount: '' })
    expect(out).toContain('the calendar the dashboard is configured for')
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
    // not a mechanism. Since HBMETRICSWIRE910 the agent does not even call the
    // endpoint -- the WORKER does -- so the prose names no queryable surface
    // for kanban at all.
    expect(out).not.toContain('/api/kanban/heartbeat-summary')
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
    // The instrument path appears as provenance only (no `bash` invocation,
    // see the runnable-call test below), but it must still be the identity's.
    expect(b).toContain('/data/scripts/heartbeat-metrics.sh')
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

  it('forbids ANY agent-side calendar fetch -- the block is the only source (5E0A32B0 -> HBMETRICSWIRE910)', () => {
    // A month of agent-side fetch variants ended in a fossil: one probe
    // against a nonexistent endpoint, copy-forwarded round after round as
    // "calendar fetch failed: API error" with zero real attempts. The
    // measured-empty vs failed-query distinction now lives in the renderer
    // (heartbeat-metrics-inject.test.ts); the prose's job is only the ban.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toMatch(/NEVER rebuild any of its numbers[\s\S]{0,120}calendar/)
    // The old MCP-tool instructions must be gone -- prose telling the agent
    // to fetch is exactly the surface the fossil grew on.
    expect(out).not.toContain('mcp__server-google-calendar-mcp__list-events')
  })

  it('pins the freshness surface on the worker-stamped ts, carried into the report', () => {
    // The anti-fossil prose existed before 5E0A32B0 and was ignored; the
    // mechanical form is now the `merve:` line that copies the block's
    // worker-stamped ts into the digest, so staleness is visible to the
    // READER instead of depending on the round's arithmetic.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('merve:')
    expect(out).toMatch(/ts= value from the block/)
    expect(out).toMatch(/two timestamps side by side ARE the finding/)
  })

  // Same investigation: the Tasks section once read the `scheduled_tasks`
  // table, which holds 0 rows on this deployment -- every report said
  // "active: 0". The live-registry read now lives in the instrument (its own
  // conformance test pins it); the prose must simply ship NO schedule or
  // task_runs query surface at all.
  it('ships no schedules or task_runs query surface in the prose', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).not.toContain('/api/schedules')
    expect(out).not.toContain('count active rows in')
    expect(out).not.toContain('next_run_at')
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
describe('hot-memory metric is never an agent-run query (HBMEMBLIND819 -> HBMETRICSWIRE910)', () => {
  it('ships NO runnable hot-memory SQL anywhere in the prompt', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The exact surface that drifted twice: a memories/hot query the agent
    // could run (and, measured, rewrite). Shape-agnostic: any SQL touching
    // the memories table near a hot filter is out of contract. Since the
    // worker injects the numbers, even the endpoint field name is gone.
    expect(out).not.toMatch(/FROM memories[\s\S]{0,120}category='hot'/)
    expect(out).not.toContain('do not rewrite the query')
    expect(out).not.toContain('counts.new_hot_memories_1h')
  })

  it('names the fabricated-zero defect and keeps muszer-hiba lines verbatim', () => {
    // The degradation path (ERROR line -> muszer-hiba in the block) now
    // renders worker-side; the prose's remaining duty is to forbid the round
    // from "fixing" it: a failure line is a measured result to copy through,
    // and a 0 the block does not contain is always the round's defect.
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toMatch(/muszer-hiba[\s\S]{0,200}IS the measured result/)
    expect(out).toMatch(/fabricated 0/)
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

describe('instrument-fed calendar (5E0A32B0, supersedes HBCALMCP808)', () => {
  it('ships no instrument line vocabulary -- the block arrives pre-rendered', () => {
    const md = renderHeartbeatClaudeMd(ID)
    // With HBMETRICSWIRE910 the round never parses instrument output, so the
    // line vocabulary (CALENDAR_EVENTS / CAL_EVENT / ERROR calendar:) left
    // the prose too -- it lives in heartbeat-metrics-inject.ts and its
    // tests. Prose mentioning parse rules is prose that can be recomposed.
    expect(md).not.toContain('CALENDAR_EVENTS')
    expect(md).not.toContain('CAL_EVENT')
    expect(md).not.toContain('ToolSearch')
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
// HBMETRICSWIRE910: the fourth failed layer of the same metric ended the
// run-it-yourself contract entirely. The prompt now carries the numbers
// PRE-RENDERED by the worker; the sentinel rule, the extractor, and the
// heredoc ban all moved out of the prose (into heartbeat-metrics-inject.ts,
// where the tests exercise them as code, not as instructions).
describe('metrics arrive pre-rendered in the prompt, never via prose the agent can recompose', () => {
  it('ships NO runnable instrument call -- the path appears as provenance only', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('/srv/app/scripts/heartbeat-metrics.sh')
    expect(out).not.toMatch(/bash [^\n]*heartbeat-metrics\.sh/)
    expect(out).not.toContain('CLAW_DASHBOARD_ORIGIN=')
  })

  it('ships NO runnable extractor and no endpoint to fetch', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).not.toContain('python3 -c "import json,urllib.request')
    expect(out).not.toMatch(/COUNTS urgent=%s/)
    expect(out).not.toContain('/api/kanban/heartbeat-summary')
    expect(out).not.toMatch(/curl[^\n]*heartbeat-summary/)
  })

  it('states the block rule: marker-led block or muszer-hiba, never "looks like a report"', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('[HB-METRIKA-BLOKK')
    expect(out).toContain('muszer-hiba')
    // The missing-block branch is named explicitly: no marker in the prompt
    // means the report says so in every section, never a self-measured fill.
    expect(out).toMatch(/hianyzo metrika-blokk/)
    expect(out).toMatch(/copied VERBATIM/)
  })

  it('bans self-measurement class-wide and names the measured history', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // Class-level ban (curl/python3/sqlite3/du/ls/stat/calendar), plus the
    // four dated failures that justify it -- the history is what keeps the
    // ban from being "simplified" away in a later edit.
    expect(out).toMatch(/NEVER rebuild any of its numbers/)
    expect(out).toContain('HBMEMBLIND807')
    expect(out).toContain('HBMEMBLIND819')
    expect(out).toMatch(/du-shaped DB\s+size 488/)
  })
})
