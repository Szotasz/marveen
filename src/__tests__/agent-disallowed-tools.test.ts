import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISABLEABLE_TOOLS, disallowedToolList, SETTINGS_REGISTRY } from '../config-registry.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'

const SH = join(__dirname, '../../scripts/main-extra-plugins-settings.sh')

function mainFlag(overrides: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'disallowed-'))
  try {
    mkdirSync(join(dir, 'store'))
    if (overrides) writeFileSync(join(dir, 'store/config-overrides.json'), JSON.stringify(overrides))
    return execFileSync('bash', ['-c', `. "$1"; main_disallowed_tools_flag "$2"`, 'x', SH, dir], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('AGENT_DISALLOWED_TOOLS', () => {
  const def = SETTINGS_REGISTRY.find((s) => s.key === 'AGENT_DISALLOWED_TOOLS')!

  it('accepts only the closed list, so the shared token cannot take Bash away', () => {
    expect(def.validate!('Artifact, Workflow')).toBeNull()
    expect(def.validate!('')).toBeNull()
    expect(def.validate!('Artifact,Bash')).not.toBeNull()
  })

  it('the sub-agent list drops unknown names and repeats', () => {
    expect(disallowedToolList('Bash, Artifact,Artifact Workflow')).toEqual(['Artifact', 'Workflow'])
    expect(disallowedToolList('')).toEqual([])
  })

  it('the main-agent shell side uses the same list', () => {
    const m = readFileSync(SH, 'utf8').match(/^ok = (\[.*\])$/m)
    expect(m && JSON.parse(m[1])).toEqual([...DISABLEABLE_TOOLS])
  })

  it('the sub-agent launch command carries the flag', () => {
    const src = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf8')
    expect(src).toMatch(/--model \$\{shSingleQuote\(model\)\}\$\{disallowedToolsFlag\(\)\} \$\{channelFlag\}/)
  })

  it('every main-agent shell launcher appends it', () => {
    for (const f of ['channels.sh', 'channel-watchdog.sh']) {
      const src = readFileSync(join(__dirname, '../../scripts', f), 'utf8')
      expect(src).toContain('EXTRA_SETTINGS_FLAG="${EXTRA_SETTINGS_FLAG}$(main_disallowed_tools_flag "$INSTALL_DIR")"')
    }
    const smg = readFileSync(join(__dirname, '../../scripts/stuck-modal-guard.sh'), 'utf8')
    expect(smg).toContain('SETTINGS_FLAG="${SETTINGS_FLAG}$(main_disallowed_tools_flag "$INSTALL_DIR")"')
  })

  it('the in-process main respawn (context-guard, hard restart, resume) carries it too', () => {
    const base = {
      claudePath: 'claude', pluginId: 'telegram@claude-plugins-official', model: 'm', continueSession: false,
      config: { isolatedConfigDir: null }, channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/x' },
    }
    expect(buildMainSessionRespawnCmd({ ...base, disallowedTools: " --disallowedTools 'Artifact,Workflow'" } as never))
      .toMatch(/--model 'm' --disallowedTools 'Artifact,Workflow' --channels /)
    expect(buildMainSessionRespawnCmd({ ...base, disallowedTools: '' } as never)).not.toContain('--disallowedTools')
  })

  it('the main-agent flag carries the filtered list, or nothing', () => {
    expect(mainFlag({ AGENT_DISALLOWED_TOOLS: 'Artifact, Bash,Workflow,Artifact' })).toBe(" --disallowedTools 'Artifact,Workflow'")
    expect(mainFlag({ AGENT_DISALLOWED_TOOLS: '' })).toBe('')
    expect(mainFlag(null)).toBe('')
  })
})
