// MAINAUTH1107 (APIKULCSINDITAS1004 A): every main launch path applies main-auth before the pane starts and sources
// the post-file right after its config branch (CFG_ENV), so neither the config branch nor the tmux global env can
// add the other credential back.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMainSessionRespawnCmd, PANE_AUTH_PATH, PANE_AUTH_POST_PATH } from '../web/channel-monitor.js'

const REPO = process.cwd()
const readSrc = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf-8')

describe('every main launch path applies main-auth and sources the post-file right after CFG_ENV', () => {
  it('channel-monitor: the post piece follows the config branch in every config mode, and all three respawns apply first', () => {
    const base = { claudePath: '/x/claude', pluginId: 'telegram@claude-plugins-official', channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/s' } }
    for (const config of [
      { isolatedConfigDir: null, fleetToken: true },
      { isolatedConfigDir: null, fleetToken: false },
      { isolatedConfigDir: '/cfg', ownCredentials: true },
      { isolatedConfigDir: '/cfg', ownCredentials: false, tokenSecretId: 'plan1' },
      { isolatedConfigDir: '/cfg', fleetToken: true },
    ]) {
      const cmd = buildMainSessionRespawnCmd({ ...base, config } as never)
      const pre = cmd.indexOf(`. '${PANE_AUTH_PATH}'`)
      const post = cmd.indexOf(`. '${PANE_AUTH_POST_PATH}'`)
      const lastCred = Math.max(cmd.lastIndexOf('CLAUDE_CODE_OAUTH_TOKEN'), cmd.lastIndexOf('CLAUDE_CONFIG_DIR'))
      expect(pre, JSON.stringify(config)).toBeGreaterThan(-1)
      expect(post, JSON.stringify(config)).toBeGreaterThan(pre)
      expect(post, JSON.stringify(config)).toBeGreaterThan(lastCred)
      expect(post).toBeLessThan(cmd.indexOf('/x/claude'))
    }
    const src = readSrc('src', 'web', 'channel-monitor.ts')
    expect(src.match(/config: mainRespawnConfigWithAuth\(\),/g)?.length).toBe(3)
    expect(src).not.toMatch(/config: resolveMainConfigDecision\(\),/)
  })

  it('channels.sh: the helper runs on fd 3 after the config decision, before the [GUARD] triggers and the _cfg_* unset', () => {
    const sh = readSrc('scripts', 'channels.sh')
    const call = sh.indexOf('"$INSTALL_DIR/scripts/main-agent-auth.mjs" "$_ma_mode" "$_ma_dir" 3>&1 2>>"$INSTALL_DIR/store/channels-failures.log" 1>&2')
    expect(call).toBeGreaterThan(sh.indexOf('_cfg_mode="${_cfg_line%%'))
    expect(call).toBeLessThan(sh.indexOf('# LOUD REGRESSION GUARD'))
    expect(call).toBeLessThan(sh.indexOf('unset _cfg_raw _cfg_line _cfg_mode _cfg_dir'))
    expect(sh).toContain('if [ -n "$CFG_ENV" ]; then _ma_mode="$_cfg_mode"; _ma_dir="$_cfg_dir"; fi')
    // neither [GUARD] trigger fires for a main agent on a key: it does not ride the shared login
    expect(sh.match(/\[ -z "\$CFG_ENV" \] && \[ "\$\{MAIN_AUTH_EFFECTIVE:-\}" != api \]/g)?.length).toBe(2)
  })

  it('channels.sh: both new-session lines source the post-file right after CFG_ENV', () => {
    const lines = readSrc('scripts', 'channels.sh').split('\n').filter((l) => l.includes('${STATE_DIR_ENV}${MCP_BATCH_ENV}${CFG_ENV}'))
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toContain('${CFG_ENV}${AUTH_POST_ENV}${CUSTOM_PROVIDER_ENV}')
  })

  it('channels.sh fallback (no main-auth): the key only on key-only, and a stale post-file is removed', () => {
    const sh = readSrc('scripts', 'channels.sh')
    expect(sh).toContain('[ "$KEY_MODE" = keyonly ] && _auth_key_for_pane="${ANTHROPIC_API_KEY:-}"')
    expect(sh).toContain(`printf 'export ANTHROPIC_API_KEY=%s\\n' "$(_q "$_auth_key_for_pane")"`)
    expect(sh).not.toContain(`printf 'export ANTHROPIC_API_KEY=%s\\n' "$(_q "$ANTHROPIC_API_KEY")"`)
    const fb = sh.slice(sh.indexOf('elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "$_auth_key_for_pane" ]; then'))
    expect(fb.slice(0, 400)).toContain('rm -f "$INSTALL_DIR/store/.channels-pane-auth-post"')
  })

  it.each([
    ['channel-watchdog.sh', '$CLAUDE --dangerously'],
    ['stuck-modal-guard.sh', '$CLAUDE_Q --dangerously'],
  ])('%s: the helper on fd 3 before the respawn, the post piece after CFG_ENV', (file, claude) => {
    const sh = readSrc('scripts', file)
    const call = sh.indexOf('"$INSTALL_DIR/scripts/main-agent-auth.mjs" "$_ma_mode" "$_ma_dir" 3>&1 2>>"$STORE/channels-failures.log" 1>&2')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(sh.indexOf('respawn-pane -k -t'))
    // GROMZONEEDSAUTHGUARDS1109: the Gromzo needs-auth step sits between the Gromzo exports and claude
    expect(sh).toContain(`\${PANE_AUTH_SRC}\${CFG_ENV}\${PANE_AUTH_POST}\${GROMZO_ENV}\${GROMZO_NA_STEP}${claude}`)
  })

  it('stuck-modal-guard.sh reads the config helper on fd 3 now, as the other two callers do', () => {
    const sh = readSrc('scripts', 'stuck-modal-guard.sh')
    expect(sh).toContain('"$INSTALL_DIR/scripts/main-agent-isolated-config.mjs" "$_prov" 3>&1 2>>"$STORE/channels-failures.log" 1>&2')
    expect(sh).not.toContain('"$INSTALL_DIR/scripts/main-agent-isolated-config.mjs" "$_prov" 2>>"$STORE/channels-failures.log" || true')
  })
})
