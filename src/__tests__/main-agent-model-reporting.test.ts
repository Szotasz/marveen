import { describe, it, expect, vi, beforeEach } from 'vitest'

// The fleet list must report the MAIN agent's model from its actual launch
// source (.env MAIN_AGENT_MODEL -> .claude/settings.json, the channels.sh
// precedence readConfiguredMainModel mirrors), NOT from
// agents/<name>/agent-config.json. On a real install the two can diverge --
// e.g. a stale agent-config.json model key left behind by an older workflow --
// and the fleet list then shows a model the main agent is not running on: a
// silent split-brain between the dashboard and the process, in exactly the
// place an operator would look to verify a model decision.

const mockReadConfiguredMainModel = vi.fn(() => '')
const mockResolveDetailed = vi.fn(() => ({ model: 'claude-sonnet-5', source: 'default' as const }))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(),
  readConfiguredMainModel: () => mockReadConfiguredMainModel(),
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    resolveAgentModelDetailed: () => mockResolveDetailed(),
  }
})

async function load() {
  vi.resetModules()
  return await import('../web/routes/agents.js')
}

describe('main-agent model reporting resolves from the launch source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the launch source when it names a model, even when agent-config resolution disagrees', async () => {
    mockReadConfiguredMainModel.mockReturnValue('claude-opus-5')
    const { mainAgentModelResolution } = await load()
    expect(mainAgentModelResolution()).toEqual({ model: 'claude-opus-5', source: 'launch_config' })
    // The agent-config path must not have been consulted at all.
    expect(mockResolveDetailed).not.toHaveBeenCalled()
  })

  it('falls back to the ordinary resolution when neither launch source names a model', async () => {
    mockReadConfiguredMainModel.mockReturnValue('')
    const { mainAgentModelResolution } = await load()
    expect(mainAgentModelResolution()).toEqual({ model: 'claude-sonnet-5', source: 'default' })
  })
})
