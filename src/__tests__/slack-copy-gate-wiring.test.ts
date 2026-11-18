/**
 * The outgoing-copy gate on the Slack send tools, sub-agent half: the scaffold injector, a fresh render, and the boot
 * migration (ensureSlackCopyGate) that adds the matcher to an agent scaffolded before it existed. The main-agent half
 * (the committed .claude/settings.json and the hook's own dispatch) is pinned in copy-gate-main-agent-coverage.test.ts.
 *
 * These assert the FINAL settings file, not only the inject function: a gate whose injector passes but whose migration
 * never runs on an existing agent leaves that agent unaudited.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsSlackCopyGate,
  injectSlackCopyGate,
  injectTelegramCopyGate,
  ensureSlackCopyGate,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  SLACK_COPY_GATE_MATCHER,
  TELEGRAM_COPY_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'slack-copy-gate-probe'
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) throw new Error(`refusing: ${root} is outside the agents base dir`)
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${root} looks like a live agent, not a test checkout`)
  }
  rmSync(root, { recursive: true, force: true })
}
beforeEach(cleanup)
afterEach(cleanup)

type Entry = { matcher?: unknown; hooks?: unknown }
const ptuOf = (s: Record<string, unknown>) => ((s.hooks as Record<string, unknown>).PreToolUse ?? []) as Entry[]
const copyEntries = (s: Record<string, unknown>) => ptuOf(s).filter((e) => JSON.stringify(e).includes('outgoing-copy-gate.py'))
const slackEntries = (s: Record<string, unknown>) => copyEntries(s).filter((e) => e.matcher === SLACK_COPY_GATE_MATCHER)

function render(name: string): Record<string, unknown> {
  mkdirSync(join(agentRoot(name), '.claude'), { recursive: true })
  writeAgentSettingsFromProfile(name, loadProfileTemplate('default'))
  return JSON.parse(readFileSync(agentSettingsPath(name), 'utf-8'))
}

describe('scope', () => {
  it('every sub-agent gets it; the main agent is exempt (it carries the matcher in its project settings)', () => {
    expect(agentGetsSlackCopyGate(MAIN_AGENT_ID)).toBe(false)
    for (const n of ['social', 'heartbeat-worker', TEST_AGENT]) expect(agentGetsSlackCopyGate(n)).toBe(true)
  })

  it('the migration never touches the main agent', () => {
    expect(ensureSlackCopyGate(MAIN_AGENT_ID)).toBe(false)
  })
})

describe('injectSlackCopyGate', () => {
  it('wires the gate onto the Slack reply AND edit_message tools', () => {
    const s: Record<string, unknown> = {}
    injectSlackCopyGate(s)
    const [entry] = copyEntries(s)
    expect(entry.matcher).toBe(SLACK_COPY_GATE_MATCHER)
    expect(String(entry.matcher).split('|')).toEqual([
      'mcp__plugin_slack-channel_slack__reply',
      'mcp__plugin_slack-channel_slack__edit_message',
    ])
  })

  it('is idempotent', () => {
    const s: Record<string, unknown> = {}
    injectSlackCopyGate(s)
    injectSlackCopyGate(s)
    expect(slackEntries(s)).toHaveLength(1)
  })

  it('the Telegram and the Slack entry coexist: neither injector dedupes the other away', () => {
    const s: Record<string, unknown> = {}
    injectTelegramCopyGate(s)
    injectSlackCopyGate(s)
    injectTelegramCopyGate(s)
    expect(copyEntries(s).map((e) => e.matcher).sort()).toEqual([SLACK_COPY_GATE_MATCHER, TELEGRAM_COPY_GATE_MATCHER].sort())
  })
})

describe('the final settings file', () => {
  it('a fresh render carries the Slack copy gate', () => {
    expect(slackEntries(render(TEST_AGENT))).toHaveLength(1)
  })

  it('the migration adds it to an agent scaffolded before it existed, and the Telegram entry stays', () => {
    render(TEST_AGENT)
    const path = agentSettingsPath(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Entry[] } }
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((e) => e.matcher !== SLACK_COPY_GATE_MATCHER)
    writeFileSync(path, JSON.stringify(s, null, 2))
    expect(slackEntries(JSON.parse(readFileSync(path, 'utf-8')))).toHaveLength(0)

    expect(ensureSlackCopyGate(TEST_AGENT)).toBe(true)
    const after = JSON.parse(readFileSync(path, 'utf-8'))
    expect(slackEntries(after)).toHaveLength(1)
    expect(copyEntries(after).some((e) => e.matcher === TELEGRAM_COPY_GATE_MATCHER)).toBe(true)
  })

  it('is a no-op on a wired agent (no rewrite churn at every boot)', () => {
    render(TEST_AGENT)
    expect(ensureSlackCopyGate(TEST_AGENT)).toBe(false)
  })

  it('an agent without a settings file is left alone', () => {
    expect(ensureSlackCopyGate(TEST_AGENT)).toBe(false)
    expect(existsSync(agentSettingsPath(TEST_AGENT))).toBe(false)
  })
})
