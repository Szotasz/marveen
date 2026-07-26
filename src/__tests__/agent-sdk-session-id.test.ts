import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the SDK so no real Claude process is spawned.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

// Mock the worker so no tmux session is launched regardless of backend env.
vi.mock('../web/agent-worker.js', () => ({
  runViaWorker: vi.fn().mockResolvedValue({ text: null, error: undefined, authFailed: true }),
}))

// eslint-disable-next-line import/first -- mocks must be registered before import
import { runAgent } from '../agent.js'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockedQuery = vi.mocked(query)

// Cast to `any` because the SDK's Query type has extra methods (interrupt,
// setPermissionMode, …) beyond AsyncIterable. The cast is safe here: agent.ts
// only `for await`s over the stream; it never calls those extra methods.
function makeEventStream(...events: object[]): any {
  return (async function* () {
    for (const e of events) yield e
  })()
}

const SUCCESS_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  result: 'ok',
}

describe('runAgent: init-event session_id extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Force the SDK path for every test so the query mock is exercised.
    vi.stubEnv('MARVEEN_AGENT_BACKEND', 'sdk')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('extracts newSessionId from snake_case session_id (SDK 0.3 format)', async () => {
    mockedQuery.mockReturnValue(makeEventStream(
      { type: 'system', subtype: 'init', session_id: 'snake-session-123' },
      SUCCESS_EVENT,
    ))

    const result = await runAgent('hello')
    expect(result.newSessionId).toBe('snake-session-123')
  })

  it('extracts newSessionId from camelCase sessionId (SDK 0.2 fallback)', async () => {
    mockedQuery.mockReturnValue(makeEventStream(
      { type: 'system', subtype: 'init', sessionId: 'camel-session-456' },
      SUCCESS_EVENT,
    ))

    const result = await runAgent('hello')
    expect(result.newSessionId).toBe('camel-session-456')
  })

  it('prefers snake_case over camelCase when both are present', async () => {
    mockedQuery.mockReturnValue(makeEventStream(
      { type: 'system', subtype: 'init', session_id: 'snake-wins', sessionId: 'camel-loses' },
      SUCCESS_EVENT,
    ))

    const result = await runAgent('hello')
    expect(result.newSessionId).toBe('snake-wins')
  })

  it('returns undefined newSessionId when no init event is emitted', async () => {
    mockedQuery.mockReturnValue(makeEventStream(SUCCESS_EVENT))

    const result = await runAgent('hello')
    expect(result.newSessionId).toBeUndefined()
  })
})
