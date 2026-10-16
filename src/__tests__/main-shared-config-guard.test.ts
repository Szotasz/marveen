// The main agent coming up on the SHARED ~/.claude must be said out loud --
// from every launch path, not just the one that happens to run in daylight.
//
// WHY THIS FILE EXISTS (kanban card `guard-respawn-vak`). scripts/channels.sh
// has carried a loud regression guard since 2026-07: two triggers, both meaning
// "this boot resolved to the shared root, so the main bot rides a rotating
// credential and can 401 into a silent channel". But channels.sh is only ONE of
// the ways the main session starts. The nightly 03:00 respawn, the stage-3
// recovery resume and the hard restart all go through tmux respawn-pane and
// never touch channels.sh -- so the guard could not fire on any of them.
//
// The cost was measured, not imagined: on 2026-08-04 the main agent came up on
// the shared root at 03:00 and the outage ran until 07:58. Nothing was broken
// except the reporting. The store/channels-failures.log had no line for that
// morning, and the absence looked exactly like health.
//
// THIS FILE MEASURES THE DECISION ONLY, AND SAYS SO. A green decision test is
// not evidence that anybody calls it -- that lesson cost a full round on the
// router fix the same week (four mutations red on the predicate, a fifth that
// deleted the CALL and left all seven assertions green). The wiring assertions
// live with the call sites; what is pinned here is that the decision itself is
// right, and in particular that it stays SILENT on a stock install.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSharedConfigTrigger } from '../web/agent-process.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

/** The four facts the decision reads, with the quiet default install as base. */
const stock = { isolatedConfigDir: null, fleetToken: false, isolatedDirExists: false, fleetTokenExported: false }

describe('the guard stays silent where silence is correct', () => {
  it('says nothing on a stock install: no isolation, no token, no dir', () => {
    // The common case by a wide margin. A guard that speaks here is noise on
    // every install that never asked for isolation, and noise is how a real
    // warning stops being read.
    expect(mainSharedConfigTrigger(stock)).toBeNull()
  })

  it('says nothing while isolation is actually working', () => {
    // The resolved dir is the whole point of the guard; having it means the
    // thing we are afraid of did not happen.
    expect(mainSharedConfigTrigger({
      isolatedConfigDir: '/srv/marveen/.channels-config',
      fleetToken: true,
      isolatedDirExists: true,
      fleetTokenExported: true,
    })).toBeNull()
  })
})

describe('the two triggers, and which one wins when both could apply', () => {
  it('a fleet token with no isolation is a MISSING SETTING, not a declined one', () => {
    // Issue #835's shape: the token is the thing isolation is gated on, so an
    // install that carries one and still lands on the shared root is
    // misconfigured rather than deliberately plain. Since #1805 this holds only
    // while the launch does NOT export the token (stock: fleetTokenExported false).
    expect(mainSharedConfigTrigger({ ...stock, fleetToken: true })).toBe('fleet-token-unused')
  })

  it('an existing .channels-config dir means isolation worked here once and was LOST', () => {
    // No token required: the dir on disk is the evidence. channels.sh trigger 2
    // fires on the same condition, deliberately, for the same reason.
    expect(mainSharedConfigTrigger({ ...stock, isolatedDirExists: true })).toBe('isolation-lost')
  })

  it('PRECEDENCE: the dir on disk wins over the token, because it points at the right fix', () => {
    // Both conditions hold on an install that lost its setting but kept its
    // token -- the likeliest real failure. Reporting that as a fresh install
    // would send the operator to "turn isolation on" when the truth is "your
    // setting disappeared", which is a different investigation.
    expect(mainSharedConfigTrigger({
      isolatedConfigDir: null, fleetToken: true, isolatedDirExists: true, fleetTokenExported: true,
    })).toBe('isolation-lost')
  })
})

describe('POSITIVE CONTROL', () => {
  it('not every input is null -- an always-silent stub cannot pass this file', () => {
    // Without this, a decision that returned null for everything would satisfy
    // both silence tests above and look like a working guard.
    const speaks = [
      mainSharedConfigTrigger({ ...stock, fleetToken: true }),
      mainSharedConfigTrigger({ ...stock, isolatedDirExists: true }),
    ].filter((t) => t !== null)
    expect(speaks).toHaveLength(2)
  })
})

describe('an EXPORTED fleet token is not a risk to warn about (issue #1805)', () => {
  // MEASURED, NOT IMAGINED. The reporter counted 23 fleet-token-unused notices in a week on a healthy
  // host, each asking for a main-session restart (which costs the running conversation), while the
  // fleet token sat in the session's env byte for byte. Claude Code's documented precedence puts an
  // env CLAUDE_CODE_OAUTH_TOKEN (rank 5) above the /login session (rank 7), and on 2026-10-09
  // (2.1.294, isolated temp CLAUDE_CONFIG_DIR) an EXPIRED .credentials.json next to a valid env token
  // still answered, the file untouched, while the same file alone failed with "OAuth session expired".
  // The test cases follow the reporter's (#1805) shape.
  it('stays SILENT on the shared root when the launch exports the token', () => {
    expect(mainSharedConfigTrigger({ ...stock, fleetToken: true, fleetTokenExported: true })).toBeNull()
  })

  it('still SPEAKS when a token exists but the launch does not export it', () => {
    // The only state the notice can honestly describe: the /login session is what authenticates.
    expect(mainSharedConfigTrigger({ ...stock, fleetToken: true, fleetTokenExported: false })).toBe('fleet-token-unused')
  })

  it('isolation-lost is unaffected: the dir on disk stays the stronger evidence', () => {
    for (const fleetTokenExported of [true, false]) {
      expect(mainSharedConfigTrigger({ ...stock, fleetToken: true, isolatedDirExists: true, fleetTokenExported })).toBe('isolation-lost')
    }
  })

  // The decision trusts readMainSharedConfigState's "exported" fact, which rests on the two launchers
  // exporting a token that exists. Pin both, so a launcher that stops exporting fails here first.
  it('the shared-root respawn exports the fleet token when there is one, and not otherwise', () => {
    const base = { claudePath: '/bin/true', pluginId: 'telegram@claude-plugins-official', model: '', continueSession: false,
      channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/m/.claude/channels/telegram' } }
    expect(buildMainSessionRespawnCmd({ ...base, config: mainConfigDecisionForTest({ fleetToken: true }) })).toContain('export CLAUDE_CODE_OAUTH_TOKEN=')
    expect(buildMainSessionRespawnCmd({ ...base, config: mainConfigDecisionForTest() })).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('channels.sh exports the token from .env or, failing that, from store/.claude-oauth-token', () => {
    const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')
    expect(sh).toMatch(/if \[ -z "\$_oauth" \] && \[ -s "\$INSTALL_DIR\/store\/\.claude-oauth-token" \]; then\s*\n\s*_oauth="\$\(cat "\$INSTALL_DIR\/store\/\.claude-oauth-token"\)"/)
    expect(sh).toContain('[ -n "$_oauth" ] && export CLAUDE_CODE_OAUTH_TOKEN="$_oauth"')
  })
})
