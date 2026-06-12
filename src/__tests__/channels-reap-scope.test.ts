import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const channelsSh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')

// The second reap pass in channels.sh kills orphan provider pollers from older
// plugin builds that carry CLAUDE_PLUGIN_ROOT but no *_STATE_DIR. CLAUDE_PLUGIN_ROOT
// resolves to the SHARED user-level plugin cache for every agent, so it cannot
// distinguish the main agent from a sub-agent. The fix scopes the pass to the
// main agent by excluding any process whose environment references
// $INSTALL_DIR/agents/<name>/ (where every sub-agent's poller runs). These tests
// pull the REAL awk program out of channels.sh and run it against fixture
// `ps eww -e` lines, so a regression to the unscoped form fails here.

const INSTALL_DIR = '/test/install'
const PROVIDER = 'telegram'

function extractReapAwkProgram(): string {
  const line = channelsSh.split('\n').find(l => l.includes('ORPHAN_PIDS2=') && l.includes('awk'))
  if (!line) throw new Error('ORPHAN_PIDS2 awk line not found in channels.sh')
  const m = line.match(/awk .*?'([^']*)'/)
  if (!m) throw new Error('could not extract awk program from the ORPHAN_PIDS2 line')
  return m[1]
}

function runReapMatcher(psLines: string[]): string[] {
  const program = extractReapAwkProgram()
  const out = execSync(
    `awk -v needle='CLAUDE_PLUGIN_ROOT=' -v prov='/${PROVIDER}' -v subdir='${INSTALL_DIR}/agents/' '${program}'`,
    { input: psLines.join('\n') + '\n', encoding: 'utf-8' },
  )
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

// CLAUDE_PLUGIN_ROOT is the shared cache path for main and sub alike. A main
// orphan carries no agent dir; a sub-agent poller carries $INSTALL_DIR/agents/<name>/.
const MAIN_ORPHAN_A = '67149 ?? S 0:01 node CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram BOT=x'
const MAIN_ORPHAN_B = '67154 ?? S 0:01 node CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 BOT=x'
const SUB_DEV2 = `14513 ?? S 0:01 node CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram TELEGRAM_STATE_DIR=${INSTALL_DIR}/agents/dev2/.claude/channels/telegram`
const SUB_DEV3 = `28358 ?? S 0:01 node CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 CLAUDE_CONFIG_DIR=${INSTALL_DIR}/agents/dev3/.claude`
const OTHER_PROVIDER = '99999 ?? S 0:01 node CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/slack'
const UNRELATED = '88888 ?? S 0:01 node some-other-process --flag'

describe('channels.sh second-pass orphan reap is scoped to the main agent', () => {
  it('reaps the main agent old-build orphans (no agent dir in env)', () => {
    expect(runReapMatcher([MAIN_ORPHAN_A, MAIN_ORPHAN_B]).sort()).toEqual(['67149', '67154'])
  })

  it('never reaps a live sub-agent poller (env carries $INSTALL_DIR/agents/<name>/)', () => {
    expect(runReapMatcher([SUB_DEV2, SUB_DEV3])).toEqual([])
  })

  it('selects only the main orphans out of a mixed fleet snapshot', () => {
    const selected = runReapMatcher([
      MAIN_ORPHAN_A, SUB_DEV2, SUB_DEV3, MAIN_ORPHAN_B, OTHER_PROVIDER, UNRELATED,
    ])
    expect(selected.sort()).toEqual(['67149', '67154'])
  })

  it('ignores a different provider and non-poller processes', () => {
    expect(runReapMatcher([OTHER_PROVIDER, UNRELATED])).toEqual([])
  })

  it('keeps the sub-agent exclusion guard so it cannot revert to the unscoped form', () => {
    expect(channelsSh).toContain('subdir="${INSTALL_DIR}/agents/"')
    expect(extractReapAwkProgram()).toContain('index($0, subdir) == 0')
  })
})
