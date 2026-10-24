import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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

const { resolveMainAgentConfigDir, explicitConfigDirLacksOwnLogin } = await import('../web/agent-process.js')

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

  // SECSZIVEK1007: a value from .env never met the settings write check, and the
  // dir reaches the channels launch command; the read applies the same path
  // rules as an agent's claudeConfigDir. The dir EXISTS here, so existence
  // alone (the old check) would have accepted it.
  it('returns null for an existing dir whose path is outside the config-dir rules', () => {
    const odd = join(SANDBOX, 'home', "it's dir")
    mkdirSync(odd, { recursive: true })
    SETTING = odd
    expect(resolveMainAgentConfigDir()).toBeNull()
    SETTING = '~/../home/.claude-bot'
    expect(resolveMainAgentConfigDir()).toBeNull()
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

describe('explicitConfigDirLacksOwnLogin (2026-10-23 "Not logged in" regression)', () => {
  it('a Linux dir with no .credentials.json has no login of its own', () => {
    expect(explicitConfigDirLacksOwnLogin(join(SANDBOX, 'home', '.claude-bot'), 'linux')).toBe(true)
  })
  it('a Linux dir with .credentials.json has its own login', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, '.credentials.json'), '{}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(false)
  })
  it('an API-key login (primaryApiKey in .claude.json) counts as its own login', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, '.claude.json'), '{"primaryApiKey":"x"}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(false)
  })
  it('an apiKeyHelper in settings.json counts as its own login', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, 'settings.json'), '{"apiKeyHelper":"/bin/true"}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(false)
  })
  it('an empty apiKeyHelper or primaryApiKey is not a login', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, 'settings.json'), '{"apiKeyHelper":""}')
    writeFileSync(join(dir, '.claude.json'), '{"primaryApiKey":"  "}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(true)
  })
  it('a key or provider switch in settings.json env counts as its own login', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"k"}}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(false)
    writeFileSync(join(dir, 'settings.json'), '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(false)
  })
  it('a broken settings.json is not a login', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, 'settings.json'), '{not json')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(true)
  })
  it('a .claude.json without a key does not', () => {
    const dir = join(SANDBOX, 'home', '.claude-bot')
    writeFileSync(join(dir, '.claude.json'), '{"oauthAccount":{}}')
    expect(explicitConfigDirLacksOwnLogin(dir, 'linux')).toBe(true)
  })
  it('the same on Windows', () => {
    expect(explicitConfigDirLacksOwnLogin(join(SANDBOX, 'home', '.claude-bot'), 'win32')).toBe(true)
  })
  it('macOS keeps its login in the Keychain: never reported as missing (no behaviour change there)', () => {
    expect(explicitConfigDirLacksOwnLogin(join(SANDBOX, 'home', '.claude-bot'), 'darwin')).toBe(false)
  })
})

describe('launcher wiring', () => {
  const HELPER = readFileSync(join(__dirname, '../../scripts/main-agent-isolated-config.mjs'), 'utf-8')
  const CHANNELS = readFileSync(join(__dirname, '../../scripts/channels.sh'), 'utf-8')
  const WATCHDOG = readFileSync(join(__dirname, '../../scripts/channel-watchdog.sh'), 'utf-8')

  it('the helper prefers explicit over rotated (configDir) over rotated (token) over isolated', () => {
    // explicit (an operator's own separate login) always wins: design 6.2
    // says it is never part of the rotation pool. A rotated plan (configDir-
    // or token-mode) wins over the generic isolated flotta fallback because
    // it is the more specific signal; configDir-mode is tried first only
    // because a plan is never both modes at once (validatePlan).
    expect(HELPER).toMatch(
      /const explicit = resolveMainAgentConfigDir\(\)[\s\S]*if \(explicit\)[\s\S]*const rotated = resolveMainAgentRotatedConfigDir\(\)[\s\S]*if \(rotated\)[\s\S]*const tokenSecretId = resolveMainAgentRotatedTokenSecretId\(\)[\s\S]*if \(tokenSecretId\)/,
    )
  })

  it('an explicit dir without its own login keeps the fleet token (isolated mode), only when the fleet token file exists, and warns', () => {
    expect(HELPER).toMatch(/if \(explicit && typeof explicitConfigDirLacksOwnLogin === 'function'\s*&& explicitConfigDirLacksOwnLogin\(explicit\) && fleetTokenUsable\) \{[\s\S]*?process\.stderr\.write\([\s\S]*?WARN MAIN_AGENT_CONFIG_DIR[\s\S]*?emitContract\(`isolated\\t\$\{explicit\}\\n`\)\s*\} else if \(explicit\) \{\s*emitContract\(`explicit\\t/)
    expect(HELPER).toMatch(/const fleetTokenFile = join\(projectRoot, 'store', '\.claude-oauth-token'\)/)
    expect(HELPER).toMatch(/const fleetTokenUsable = existsSync\(fleetTokenFile\) && statSync\(fleetTokenFile\)\.size > 0/)
    expect(HELPER).toMatch(/typeof explicitConfigDirLacksOwnLogin !== 'function'\) \{\s*process\.stderr\.write\(/)
  })

  it('the helper tags each path with its mode so the caller knows how to authenticate', () => {
    expect(HELPER).toMatch(/explicit\\t/)
    expect(HELPER).toMatch(/rotated\\t/)
    expect(HELPER).toMatch(/token\\t/)
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
    expect(HELPER).not.toMatch(/process\.stdout\.write\(`(explicit|rotated|isolated|token)/)
  })

  it('every caller opens fd 3 AND filters for a contract line, including the rotated and token modes (PR2c/PR3)', () => {
    // Both files spawn the helper; a caller that drifts reintroduces the outage
    // on exactly the path that matters (channel-watchdog.sh respawns when the
    // dashboard is down). A caller whose filter still only matches
    // explicit|rotated|isolated would silently drop a TOKEN-mode rotated plan
    // back onto the shared ~/.claude -- exactly the outage class this contract
    // exists to prevent, just for the newest mode.
    for (const [name, sh] of [['channels.sh', CHANNELS], ['channel-watchdog.sh', WATCHDOG]] as const) {
      expect(sh, name).toMatch(/main-agent-isolated-config\.mjs[^\n]*3>&1/)
      expect(sh, name).toMatch(/grep -m1 -E '\^\(explicit\|rotated\|isolated\|token\)/)
    }
  })

  it('channels.sh never injects the fleet token for an explicit OR rotated (configDir) dir', () => {
    // Both carry their OWN .credentials.json (an operator-logged-in dir for
    // explicit, a registered plan's dir for rotated -- design 6.5/4) --
    // exporting the fleet token for either would silently authenticate the
    // bot as the fleet identity instead. Stops at the next elif/else so the
    // TOKEN branch right after it (which legitimately DOES export a token --
    // just the plan's own, not the flotta's) is not swept into this capture.
    const branch = CHANNELS.match(/if \[ "\$_cfg_mode" = "explicit" \] \|\| \[ "\$_cfg_mode" = "rotated" \]; then\n([\s\S]*?)\n\s*(?:elif|else)/)
    expect(branch).not.toBeNull()
    expect(branch?.[1]).not.toMatch(/export CLAUDE_CODE_OAUTH_TOKEN/)
    expect(branch?.[1]).not.toMatch(/\.claude-oauth-token/)
    expect(branch?.[1]).toMatch(/CLAUDE_CONFIG_DIR/)
    // AUTH_PANE_ENV (sourced before CFG_ENV) and the tmux global env already
    // carry the fleet token; it must be dropped, or it outranks the dir's own
    // login and hides the claude.ai connectors (measured 2026-10-16).
    expect(branch?.[1]).toMatch(/unset CLAUDE_CODE_OAUTH_TOKEN/)
    // APIKEYUNSET1018: the auth file and the tmux global env carry ANTHROPIC_API_KEY
    // too when .env has one, and it outranks the dir's own login as well.
    expect(branch?.[1]).toMatch(/unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY/)
    expect(branch?.[1]).not.toMatch(/export ANTHROPIC_API_KEY/)
  })

  it('channels.sh exports the PLAN token (via resolve-plan-token-env.mjs), not the raw fleet token, for a token-mode rotated dir', () => {
    const branch = CHANNELS.match(/elif \[ "\$_cfg_mode" = "token" \]; then\n([\s\S]*?)\n\s*else/)
    expect(branch).not.toBeNull()
    expect(branch?.[1]).toMatch(/resolve-plan-token-env\.mjs/)
    expect(branch?.[1]).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    expect(branch?.[1]).toMatch(/CLAUDE_CONFIG_DIR/)
  })

  // PR #1304 review (c): a missing plan secret must not launch with an empty
  // token, so the token branch now ALSO passes the fleet-token path -- as the
  // resolver's OWN fallback argument, not a direct $(cat) export like the
  // plain `isolated` branch uses. And the resolver's exit status must gate
  // the launch: a bare `_plan_token=$(...)` assignment (no command word
  // before it) propagates that status into the `&&` chain, so a resolver
  // failure (neither the plan secret nor the fleet token available) stops
  // before `claude` ever runs.
  it('channels.sh\'s token branch passes the fleet-token path as the resolver\'s fallback arg and gates the launch on the resolver\'s exit status', () => {
    const branch = CHANNELS.match(/elif \[ "\$_cfg_mode" = "token" \]; then\n([\s\S]*?)\n\s*else/)
    expect(branch).not.toBeNull()
    expect(branch?.[1]).toMatch(/store\/\.claude-oauth-token/)
    expect(branch?.[1]).toMatch(/channels-failures\.log/)
    expect(branch?.[1]).toContain('_plan_token=')
    expect(branch?.[1]).toContain('resolve-plan-token-env.mjs')
    expect(branch?.[1]).toMatch(/export CLAUDE_CODE_OAUTH_TOKEN=.*_plan_token/)
  })
})
