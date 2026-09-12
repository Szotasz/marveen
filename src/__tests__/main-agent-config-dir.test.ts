import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MAIN_AGENT_CONFIG_DIR: an EXPLICIT CLAUDE_CONFIG_DIR for the main channels
// agent, for the operator whose bot has its own Claude login (separate from the
// fleet's). Distinct from MAIN_AGENT_ISOLATED_CONFIG, which authenticates from
// the fleet setup-token and therefore cannot keep the two identities apart.
let SANDBOX = ''
let SETTING = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_CONFIG_DIR' ? SETTING : actual.getEffectiveSettingValue(key),
  }
})

const { resolveMainAgentConfigDir } = await import('../web/agent-process.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'maincfg-'))
  mkdirSync(join(SANDBOX, 'home', '.claude-bot'), { recursive: true })
  SETTING = ''
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('resolveMainAgentConfigDir', () => {
  it('returns null when the setting is unset (shared ~/.claude, unchanged default)', () => {
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('resolves an absolute path that exists', () => {
    SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('expands a leading ~ against the home dir', () => {
    SETTING = '~/.claude-bot'
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('returns null (not the unresolved path) when the dir does not exist', () => {
    // Falling back to the shared root is the safe failure: launching with a
    // non-existent CLAUDE_CONFIG_DIR would start the bot logged-out.
    SETTING = join(SANDBOX, 'home', '.claude-nope')
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('trims surrounding whitespace from a hand-edited .env value', () => {
    SETTING = `  ${join(SANDBOX, 'home', '.claude-bot')}  `
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })
})

describe('launcher wiring', () => {
  const HELPER = readFileSync(join(__dirname, '../../scripts/main-agent-isolated-config.mjs'), 'utf-8')
  const CHANNELS = readFileSync(join(__dirname, '../../scripts/channels.sh'), 'utf-8')
  const WATCHDOG = readFileSync(join(__dirname, '../../scripts/channel-watchdog.sh'), 'utf-8')

  it('the helper prefers explicit over rotated over isolated', () => {
    // explicit (an operator's own separate login) always wins: design 6.2
    // says it is never part of the rotation pool. rotated (PR2c, a
    // registered plan the state side-car points the main agent at) wins over
    // the generic isolated flotta fallback because it is the more specific
    // signal.
    expect(HELPER).toMatch(
      /const explicit = resolveMainAgentConfigDir\(\)[\s\S]*if \(explicit\)[\s\S]*const rotated = resolveMainAgentRotatedConfigDir\(\)[\s\S]*if \(rotated\)/,
    )
  })

  it('the helper tags each path with its mode so the caller knows how to authenticate', () => {
    expect(HELPER).toMatch(/explicit\\t/)
    expect(HELPER).toMatch(/rotated\\t/)
    expect(HELPER).toMatch(/isolated\\t/)
  })

  // 2026-09-12 outage. The helper imports a pino-logging dist module, and pino
  // writes to fd 1 from its own handle (a pino-pretty transport does it from a
  // worker thread, so the script cannot intercept it). When #1218 added
  // `permissions` to the isolated settings.json only, the resulting
  // "kept target-only settings keys" line rode along on stdout, `_cfg_dir`
  // became multi-line, `[ -d ]` failed, and the main agent silently kept the
  // shared ~/.claude -- losing both the fleet-token auth and its own egress deny.
  it('the contract rides fd 3, not stdout, so a library log line cannot break it', () => {
    expect(HELPER).toMatch(/let CONTRACT_FD = 3/)
    expect(HELPER).toMatch(/writeSync\(CONTRACT_FD/)
    // stdout stays a usable fallback for a hand-run, but nothing writes the
    // contract through process.stdout.write -- patching it does not catch pino.
    expect(HELPER).not.toMatch(/process\.stdout\.write\(`(explicit|rotated|isolated)/)
  })

  it('every caller opens fd 3 AND filters for a contract line, including the rotated mode (PR2c)', () => {
    // Both files spawn the helper; a caller that drifts reintroduces the outage
    // on exactly the path that matters (channel-watchdog.sh respawns when the
    // dashboard is down). A caller whose filter still only matches
    // explicit|isolated would silently drop a rotated plan back onto either
    // the shared ~/.claude or the wrong (fleet-token) auth mode -- exactly the
    // outage class this contract exists to prevent, just for the new mode.
    for (const [name, sh] of [['channels.sh', CHANNELS], ['channel-watchdog.sh', WATCHDOG]] as const) {
      expect(sh, name).toMatch(/main-agent-isolated-config\.mjs[^\n]*3>&1/)
      expect(sh, name).toMatch(/grep -m1 -E '\^\(explicit\|rotated\|isolated\)/)
    }
  })

  it('channels.sh never injects the fleet token for an explicit OR rotated dir', () => {
    // Both carry their OWN .credentials.json (an operator-logged-in dir for
    // explicit, a registered plan's dir for rotated -- design 6.5/4) --
    // exporting the fleet token for either would silently authenticate the
    // bot as the fleet identity instead.
    const branch = CHANNELS.match(/if \[ "\$_cfg_mode" = "explicit" \] \|\| \[ "\$_cfg_mode" = "rotated" \]; then\n([\s\S]*?)\n\s*else/)
    expect(branch).not.toBeNull()
    expect(branch?.[1]).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    expect(branch?.[1]).toMatch(/CLAUDE_CONFIG_DIR/)
  })
})
