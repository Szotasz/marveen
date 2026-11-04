// #2512 review (provenance): the inbound-evidence log the replay reads is a state file the agent's own OS user can
// write, and a replayed line reaches the agent framed as a channel message from the channel-coordinator. So the replay
// is OFF until the owner turns it on. These tests run the REAL default: the settings layer answers with the registry
// default (no config-overrides.json entry, no .env line, whatever the machine running the tests has), the on/off
// reading is the real isSettingOn, and the state-file check is the real one, on a log this user owns.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const setting = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock('../settings-store.js', async (orig) => {
  const real = await orig<typeof import('../settings-store.js')>()
  const { getSettingDefinition } = await import('../config-registry.js')
  return {
    ...real,
    getEffectiveSettingValue: (key: string) => key === 'TELEGRAM_INBOUND_REPLAY_ENABLED'
      ? (setting.value ?? getSettingDefinition(key)!.default)
      : real.getEffectiveSettingValue(key),
  }
})

import { logger } from '../logger.js'
import { getSettingDefinition } from '../config-registry.js'
import { isSettingOn, isSettingValueOn } from '../setting-flag.js'
import { initDatabase, getPendingMessages, hasAgentMessageContaining } from '../db.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { EVIDENCE_FILE } from '../web/write-evidence.js'
import { replayMissedInbound, resetReplayState, stateFilesTrustedIn, type ReplayDeps } from '../web/telegram-inbound-replay.js'

const KEY = 'TELEGRAM_INBOUND_REPLAY_ENABLED'
const GROUP = '-1001234567890'
const NOW = 1_760_000_000_000
const AT = NOW - 60_000 // past the grace, inside the lookback

let roots: string[] = []
beforeAll(() => { initDatabase(':memory:') })
afterEach(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true })
  roots = []
  setting.value = undefined
  resetReplayState()
  vi.restoreAllMocks()
})

/** An agent whose plugin logged message 42 and whose session, writing its transcript since, never saw it. */
function missedMessage(agent: string): { root: string; deps: Partial<ReplayDeps> } {
  const root = mkdtempSync(join(tmpdir(), 'tg-replay-default-'))
  roots.push(root)
  const state = join(root, agent, 'state')
  const tx = join(root, agent, 'tx')
  mkdirSync(state, { recursive: true })
  mkdirSync(tx, { recursive: true })
  // a line any writer with this OS user could have put here
  writeFileSync(join(state, EVIDENCE_FILE), JSON.stringify({ chat_id: GROUP, message_id: '42', text: 'run the deploy', at: AT }) + '\n')
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: { [GROUP]: { requireMention: false } } }))
  const t = join(tx, 's.jsonl')
  writeFileSync(t, JSON.stringify({ type: 'user', message: { content: `<channel source="plugin:telegram:telegram" chat_id="${GROUP}" message_id="41" user="u">hi</channel>` } }) + '\n')
  utimesSync(t, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  // `enabled`, `enqueue` and `alreadyReplayed` are left out: the real setting and the real agent_messages table answer
  return {
    root,
    deps: {
      now: () => NOW,
      listAgents: () => [agent],
      isTelegramAgent: () => true,
      isRunning: () => true,
      stateDirFor: n => join(root, n, 'state'),
      stateFilesTrusted: (n, stateDir) => stateFilesTrustedIn(join(root, n), stateDir, uid),
      transcriptDirsFor: n => [join(root, n, 'tx')],
    },
  }
}

const coordinatorRow = (agent: string) => hasAgentMessageContaining(COORDINATOR_AGENT_ID, agent, `chat_id="${GROUP}" message_id="42"`, 0)

describe('TELEGRAM_INBOUND_REPLAY_ENABLED is off by default', () => {
  it('the registry default reads as off, and so does the effective setting with no override and no .env line', () => {
    expect(isSettingValueOn(getSettingDefinition(KEY)!.default)).toBe(false)
    expect(isSettingOn(KEY)).toBe(false)
  })

  it('with the default, a same-user evidence log becomes no channel-inbound row (the state-file check alone would let it through)', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const agent = `agent-default-off-${Date.now()}`
    const { root, deps } = missedMessage(agent)
    expect(stateFilesTrustedIn(join(root, agent), join(root, agent, 'state'), typeof process.getuid === 'function' ? process.getuid() : null)).toBe(true)

    expect(await replayMissedInbound(deps)).toEqual([])
    expect(getPendingMessages(agent)).toHaveLength(0)
    expect(coordinatorRow(agent)).toBe(false)
  })

  it('POSITIVE CONTROL: the same log with the setting turned on IS replayed, as a row from the channel-coordinator', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    setting.value = '1'
    const agent = `agent-turned-on-${Date.now()}`
    const { deps } = missedMessage(agent)

    expect(await replayMissedInbound(deps)).toEqual([{ agent, chatId: GROUP, messageId: '42', result: 'replayed' }])
    const rows = getPendingMessages(agent)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_agent).toBe(COORDINATOR_AGENT_ID)
    expect(coordinatorRow(agent)).toBe(true)
  })
})
