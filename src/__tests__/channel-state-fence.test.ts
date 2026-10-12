// SLACKDMVESZT1006: a sub-agent launch must never leave a channel plugin able
// to fall back to the shared ~/.claude/channels/<provider> state, which is
// where the main agent's token lives. The slack-channel plugin resolves its
// state as `process.env.SLACK_STATE_DIR || ~/.claude/channels/slack`
// (server.ts:129 in slack-channel 0.1.0), so an unset variable IS the fallback.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { buildChannelStateFence } from '../web/channel-state-fence.js'

const AGENT = '/install/agents/demo'

describe('buildChannelStateFence', () => {
  it('a telegram agent: every OTHER provider points at the agent\'s own dir', () => {
    const f = buildChannelStateFence(['telegram'], AGENT)
    expect(f).toContain(`export SLACK_STATE_DIR="${AGENT}/.claude/channels/slack" && `)
    expect(f).toContain(`export DISCORD_STATE_DIR="${AGENT}/.claude/channels/discord" && `)
    expect(f).toContain(`export GOOGLECHAT_STATE_DIR="${AGENT}/.claude/channels/googlechat" && `)
    expect(f).toContain(`export TEAMS_STATE_DIR="${AGENT}/.claude/channels/teams" && `)
    // The provider the launch exports itself is left to that export.
    expect(f).not.toContain('TELEGRAM_STATE_DIR')
  })

  it('a channel-less agent fences ALL providers, telegram included', () => {
    const f = buildChannelStateFence([], AGENT)
    for (const v of ['TELEGRAM', 'SLACK', 'DISCORD', 'GOOGLECHAT', 'TEAMS']) expect(f).toContain(`export ${v}_STATE_DIR=`)
  })

  it('no path ever points outside the agent dir (never the shared ~/.claude/channels)', () => {
    const f = buildChannelStateFence([], AGENT)
    for (const m of f.matchAll(/_STATE_DIR="([^"]+)"/g)) expect(m[1].startsWith(`${AGENT}/.claude/channels/`)).toBe(true)
  })

  it('executed in a shell after the launch unset: SLACK_STATE_DIR is the agent\'s own dir', () => {
    const fence = buildChannelStateFence(['telegram'], AGENT)
    const out = execFileSync('/bin/sh', ['-c', `export SLACK_STATE_DIR=/home/x/.claude/channels/slack && unset SLACK_STATE_DIR && ${fence}printf %s "$SLACK_STATE_DIR"`]).toString()
    expect(out).toBe(`${AGENT}/.claude/channels/slack`)
  })
})

describe('launcher binding (agent-process.ts startAgentProcess)', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
  const FN = SRC.slice(SRC.indexOf('export async function startAgentProcess('))

  it('the fence is computed from the providers this launch exports itself', () => {
    expect(FN).toContain('const stateFence = buildChannelStateFence([...(hasChannel ? [agentProvider] : []), ...extraLaunch.providers], dir)')
  })
  it('the fence sits right AFTER the unset in the launch command (an unset after it would undo it)', () => {
    expect(FN).toContain('${unsetTokens} && ${stateFence}')
  })
  it('the unset of the inherited state dirs stays (CHANSTATEUNSET930)', () => {
    expect(FN).toMatch(/const unsetTokens = 'unset [^']*SLACK_STATE_DIR[^']*'/)
  })
})
