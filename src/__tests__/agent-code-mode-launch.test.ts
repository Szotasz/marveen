// CODEMODEFLAG1119: the per-agent Code Mode switch at launch. codeMode true in agent-config.json AND the agent on its
// own isolated config dir -> the launch exports CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 and the caveat keys are ensured
// in that dir's .claude.json; anything else exports =0 (n1: 0 wins over an inherited value and a settings.json env
// block). A switch since the last launch (agent-config.json codeModeLaunched) makes the start fresh (Q1).
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const tmpRoot = mkdtempSync(join(tmpdir(), 'code-mode-launch-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: tmpRoot }))

const { readAgentCodeMode, writeAgentCodeMode, readAgentCodeModeLaunched, writeAgentCodeModeLaunched } = await import('../web/agent-config.js')
const { codeModeLaunchEnv, resolveCodeModeLaunch } = await import('../web/agent-process.js')
const { decideContinueFlag, CODE_MODE_SWITCH_REASON } = await import('../web/channel-continue-policy.js')
const { CODE_MODE_MARKER_DIR, codeModeMarkerPath, syncCodeModeMarker } = await import('../web/code-mode-caveats.js')

const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
const FN = SRC.slice(SRC.indexOf('export async function startAgentProcess('))
const lineAt = (anchor: string) => { const i = FN.indexOf(anchor); expect(i, anchor).toBeGreaterThan(-1); return FN.slice(i, FN.indexOf('\n', i)) }
const VAR = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'

const agentConfig = (name: string, raw: string) => {
  mkdirSync(join(tmpRoot, 'agents', name), { recursive: true })
  writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), raw)
}

describe('readAgentCodeMode / writeAgentCodeMode', () => {
  it('only a literal true is on; missing, false, a string, or a broken file is off', () => {
    agentConfig('on', '{"codeMode":true}')
    agentConfig('off', '{"codeMode":false}')
    agentConfig('missing', '{"model":"claude-opus-5"}')
    agentConfig('string', '{"codeMode":"true"}')
    agentConfig('broken', '{not json')
    expect(readAgentCodeMode('on')).toBe(true)
    expect(readAgentCodeMode('off')).toBe(false)
    expect(readAgentCodeMode('missing')).toBe(false)
    expect(readAgentCodeMode('string')).toBe(false)
    expect(readAgentCodeMode('broken')).toBe(false)
    expect(readAgentCodeMode('no-such-agent')).toBe(false)
  })

  it('writing true adds the key beside the others, writing false removes it', () => {
    agentConfig('w', '{"model":"claude-opus-5"}')
    writeAgentCodeMode('w', true)
    expect(JSON.parse(readFileSync(join(tmpRoot, 'agents', 'w', 'agent-config.json'), 'utf-8'))).toEqual({ model: 'claude-opus-5', codeMode: true })
    writeAgentCodeMode('w', false)
    expect(JSON.parse(readFileSync(join(tmpRoot, 'agents', 'w', 'agent-config.json'), 'utf-8'))).toEqual({ model: 'claude-opus-5' })
  })
})

describe('codeModeLaunchEnv: the launch piece', () => {
  it('on -> =1; off -> an explicit =0, never nothing (n1)', () => {
    expect(codeModeLaunchEnv(true)).toBe(`export ${VAR}=1 && `)
    expect(codeModeLaunchEnv(false)).toBe(`export ${VAR}=0 && `)
  })
})

describe('readAgentCodeModeLaunched / writeAgentCodeModeLaunched (Q1 record)', () => {
  it('missing counts as false; true is written, false removes the key', () => {
    agentConfig('rec', '{"model":"claude-opus-5"}')
    expect(readAgentCodeModeLaunched('rec')).toBe(false)
    writeAgentCodeModeLaunched('rec', true)
    expect(readAgentCodeModeLaunched('rec')).toBe(true)
    writeAgentCodeModeLaunched('rec', false)
    expect(JSON.parse(readFileSync(join(tmpRoot, 'agents', 'rec', 'agent-config.json'), 'utf-8'))).toEqual({ model: 'claude-opus-5' })
  })
})

describe('decideContinueFlag: a Code Mode switch since the last launch is a fresh start (Q1)', () => {
  const base = {
    hasPriorSession: true, fresh: false, hasChannel: false, isMainAgent: false, provider: 'telegram',
    usesLaunchSecret: false, fleetTokenLaunch: true, useMcpJsonForChannel: false, installedCli: '2.1.326',
  }
  it('switched: no --continue, with its own reason, for a channel-less and a resumable telegram agent alike', () => {
    expect(decideContinueFlag({ ...base, codeModeSwitched: true })).toEqual({ useContinue: false, reason: CODE_MODE_SWITCH_REASON })
    expect(decideContinueFlag({ ...base, hasChannel: true, codeModeSwitched: true })).toEqual({ useContinue: false, reason: CODE_MODE_SWITCH_REASON })
  })
  it('not switched: the decision is today\'s (both agents keep --continue)', () => {
    expect(decideContinueFlag({ ...base, codeModeSwitched: false }).useContinue).toBe(true)
    expect(decideContinueFlag({ ...base, hasChannel: true }).useContinue).toBe(true)
  })
})

describe('resolveCodeModeLaunch: Code Mode only on the agent\'s own isolated config dir, caveat keys ensured (Q2)', () => {
  const ORIGINAL = '{\n  "numStartups": 3,\n  "projects": {\n    "/x": {\n      "allowedTools": []\n    }\n  }\n}\n'
  const setup = (name: string, codeMode: boolean) => {
    agentConfig(name, codeMode ? '{"codeMode":true}' : '{}')
    const cfg = join(tmpRoot, 'agents', name, '.claude-config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, '.claude.json'), ORIGINAL)
    return { cfg, dot: () => readFileSync(join(cfg, '.claude.json'), 'utf-8') }
  }

  it('on + own isolated dir: true, and both keys are true in its .claude.json', () => {
    const { cfg, dot } = setup('cm-on', true)
    expect(resolveCodeModeLaunch('cm-on', cfg)).toBe(true)
    const j = JSON.parse(dot())
    expect(j.codeModeCaveatsAcceptedV1).toBe(true)
    expect(j.codeModeAutoModeCaveatAcceptedV1).toBe(true)
    expect(resolveCodeModeLaunch('cm-on', cfg)).toBe(true)
  })

  it('off: false, and the .claude.json is not touched (the keys are stamped only for codeMode true)', () => {
    const { cfg, dot } = setup('cm-off', false)
    expect(resolveCodeModeLaunch('cm-off', cfg)).toBe(false)
    expect(dot()).toBe(ORIGINAL)
  })

  it('on but the shared root (null) or another config dir: false, nothing written', () => {
    const { cfg, dot } = setup('cm-other', true)
    const other = join(tmpRoot, 'plan-dir')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, '.claude.json'), ORIGINAL)
    expect(resolveCodeModeLaunch('cm-other', null)).toBe(false)
    expect(resolveCodeModeLaunch('cm-other', other)).toBe(false)
    expect(readFileSync(join(other, '.claude.json'), 'utf-8')).toBe(ORIGINAL)
    expect(dot()).toBe(ORIGINAL)
    void cfg
  })

  it('on + own dir but no .claude.json yet: false (the next launch, after provisioning, stamps it)', () => {
    agentConfig('cm-nofile', '{"codeMode":true}')
    expect(resolveCodeModeLaunch('cm-nofile', join(tmpRoot, 'agents', 'cm-nofile', '.claude-config'))).toBe(false)
  })
})

describe('the launch command (startAgentProcess)', () => {
  // Today's command on origin/develop 484d3d21, verbatim. The only allowed differences: the unset token and the
  // ${codeModeEnv} piece, which is '' for an agent without codeMode.
  const UNSET_BEFORE = "const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR'"
  const CMD_BEFORE = 'const buildLaunchCmd = (launchCwd: string) => `${umaskPrefix}export PATH="${venvPathPrefix}/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${stateFence}${autoUpdaterEnv}${byoUnsetEnv}${promptSuggestionEnv}${mcpEnv}${channelSetup}${apiKeyEnv}${claudeConfigEnv}${helperTokenEnvPiece}${agentEgressEnv}${oauthTokenEnv}${providerEnv}${stateObserverEnv}cd "${launchCwd}" && ${claudeBin()} ${continueFlag}${skipFlag}--model ${shSingleQuote(model)} ${channelFlag}${worksourceFlags}${bashSandboxFlag}`.trimEnd()'

  it('the unset line is today\'s, unchanged (the explicit =0 export makes an unset redundant)', () => {
    expect(lineAt('const unsetTokens = ').trim()).toBe(UNSET_BEFORE)
  })

  it('the launch line is today\'s plus exactly ${codeModeEnv}, after the unset and before cd/claude', () => {
    const line = lineAt('const buildLaunchCmd = ').trim()
    // ${disallowedToolsFlag()} after --model has its own pin (agent-disallowed-tools.test.ts).
    expect(line.replace('${codeModeEnv}', '').replace('${disallowedToolsFlag()}', '')).toBe(CMD_BEFORE)
    expect(line.split('${codeModeEnv}')).toHaveLength(2)
    expect(line.indexOf('${unsetTokens}')).toBeLessThan(line.indexOf('${codeModeEnv}'))
    expect(line.indexOf('${codeModeEnv}')).toBeLessThan(line.indexOf('cd "${launchCwd}"'))
  })

  it('the piece follows the resolved launch mode, which is decided after the config dir and fed to the resume decision', () => {
    expect(FN).toContain('const codeModeEnv = codeModeLaunchEnv(codeModeOn)')
    const resolved = FN.indexOf('const codeModeOn = resolveCodeModeLaunch(name, claudeConfigDir)')
    expect(resolved).toBeGreaterThan(FN.lastIndexOf('claudeConfigDir = isolated'))
    expect(FN).toContain('const codeModeSwitched = codeModeOn !== readAgentCodeModeLaunched(name)')
    const decision = FN.slice(FN.indexOf('const continueDecision = decideContinueFlag({'), FN.indexOf('const continueFlag = '))
    expect(decision).toMatch(/^\s+codeModeSwitched,$/m)
    expect(resolved).toBeLessThan(FN.indexOf('const continueDecision = decideContinueFlag({'))
  })

  it('a channel-less agent logs the switch reason too', () => {
    expect(FN).toContain('continueDecision.reason === CODE_MODE_SWITCH_REASON')
  })

  it('the launched mode is recorded right after the session started, only when it switched', () => {
    const start = FN.indexOf("runTmux(startTarget, ['new-session', '-d', '-s', session, buildLaunchCmd(dir)]")
    const rec = FN.indexOf('writeAgentCodeModeLaunched(name, codeModeOn)')
    expect(rec).toBeGreaterThan(start)
    expect(FN.slice(start, rec)).toContain('if (codeModeSwitched) {')
    expect(FN.slice(start, rec).split('\n').length).toBeLessThan(6)
  })

  it('both launches (normal and the EPERM /tmp fallback) go through buildLaunchCmd', () => {
    expect(FN).toContain("runTmux(startTarget, ['new-session', '-d', '-s', session, buildLaunchCmd(dir)]")
    expect(FN).toContain("['new-session', '-d', '-s', session, buildLaunchCmd(fallbackCwd)]")
  })

  // The real shell, with the variable inherited from the parent the way the tmux server would hand it on: the unset
  // line and the piece, in the order the launch line puts them.
  const unsetTokens = /const unsetTokens = '([^']+)'/.exec(FN)![1]
  const seen = (enabled: boolean) => execFileSync('/bin/sh', ['-c', `${unsetTokens} && ${codeModeLaunchEnv(enabled)}printf '%s' "\${${VAR}-UNSET}"`], {
    encoding: 'utf-8', env: { ...process.env, [VAR]: '1' },
  })

  it('off: an inherited 1 is 0 by the time claude would start', () => {
    expect(seen(false)).toBe('0')
  })

  it('on: the variable is 1', () => {
    expect(seen(true)).toBe('1')
  })
})

// CODEMODEFOLLOW1119: scripts/watchdog.sh relaunches with its own command. It follows the dashboard's decision through
// store/code-mode/<name>.on, which every start keeps in step with the resolved mode and the owner's "off" removes.
describe('the watchdog marker (CODEMODEFOLLOW1119)', () => {
  const REPO = join(__dirname, '..', '..')
  const WD_SRC = readFileSync(join(REPO, 'scripts', 'watchdog.sh'), 'utf-8')
  const ROUTE = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf-8')

  it('lives under store/code-mode, where the watchdog looks', () => {
    expect(CODE_MODE_MARKER_DIR.endsWith(join('store', 'code-mode'))).toBe(true)
    expect(codeModeMarkerPath('abel')).toBe(join(CODE_MODE_MARKER_DIR, 'abel.on'))
    expect(WD_SRC).toContain('"$INSTALL_DIR/store/code-mode/$1.on"')
  })

  it('on creates it, off removes it, off without one is fine', () => {
    const dir = join(tmpRoot, 'marker-unit')
    syncCodeModeMarker('m', true, dir)
    expect(existsSync(join(dir, 'm.on'))).toBe(true)
    syncCodeModeMarker('m', false, dir)
    expect(existsSync(join(dir, 'm.on'))).toBe(false)
    expect(() => syncCodeModeMarker('m', false, dir)).not.toThrow()
  })

  // The dashboard's writer and the watchdog's reader against one fixture install: the real watchdog.sh, its
  // --code-mode-env self-test, an agent on its own .claude-config with the fleet token present.
  it('what the dashboard writes is what a watchdog restart exports: on -> 1, off -> 0', () => {
    const fx = join(tmpRoot, 'wd')
    mkdirSync(join(fx, 'scripts'), { recursive: true })
    mkdirSync(join(fx, 'agents', 'abel', '.claude-config'), { recursive: true })
    mkdirSync(join(fx, 'store'), { recursive: true })
    writeFileSync(join(fx, 'store', '.claude-oauth-token'), 'fixture-token\n')
    writeFileSync(join(fx, 'scripts', 'watchdog.sh'), readFileSync(join(REPO, 'scripts', 'watchdog.sh')))
    const run = () => execFileSync('bash', [join(fx, 'scripts', 'watchdog.sh'), '--code-mode-env', 'abel'], { encoding: 'utf-8' }).trim()
    const markers = join(fx, 'store', 'code-mode')
    expect(run()).toBe(`env=export ${VAR}=0 &&`)
    syncCodeModeMarker('abel', true, markers)
    expect(run()).toBe(`env=export ${VAR}=1 &&`)
    // a relaunch that would not run on the agent's own .claude-config (no fleet token: shared config) stays off
    rmSync(join(fx, 'store', '.claude-oauth-token'))
    expect(run()).toBe(`env=export ${VAR}=0 &&`)
    writeFileSync(join(fx, 'store', '.claude-oauth-token'), 'fixture-token\n')
    expect(run()).toBe(`env=export ${VAR}=1 &&`)
    syncCodeModeMarker('abel', false, markers)
    expect(run()).toBe(`env=export ${VAR}=0 &&`)
  })

  it('every successful start syncs it to the resolved mode, after the session started, not only on a switch', () => {
    const start = FN.indexOf("runTmux(startTarget, ['new-session', '-d', '-s', session, buildLaunchCmd(dir)]")
    const sync = FN.indexOf('syncCodeModeMarker(name, codeModeOn)')
    expect(sync).toBeGreaterThan(start)
    const between = FN.slice(start, sync)
    // the switched-only block is closed before the sync
    expect(between.split('if (codeModeSwitched) {')).toHaveLength(2)
    expect(FN).toMatch(/\n    \}\n    \/\/ CODEMODEFOLLOW1119[^\n]*\n    try \{ syncCodeModeMarker\(name, codeModeOn\) \}/)
    expect(between.split('\n').length).toBeLessThan(10)
  })

  it('the owner\'s off removes it before anything else of the switch is written', () => {
    const branch = ROUTE.slice(ROUTE.indexOf('if (data.codeMode !== undefined) {'))
    const rm = branch.indexOf('syncCodeModeMarker(name, false)')
    expect(rm).toBeGreaterThan(-1)
    expect(branch.slice(0, rm)).toContain('if (data.codeMode !== true) {')
    expect(rm).toBeLessThan(branch.indexOf('setCodeModeCaveats('))
    expect(rm).toBeLessThan(branch.indexOf('writeAgentCodeMode(name, data.codeMode === true)'))
  })

  it('the watchdog relaunch line carries the piece before cd, and the relaunch never resumes', () => {
    expect(WD_SRC).toContain('CODE_MODE_ENV="$(agent_code_mode_env "$AGENT_ID" "$AGENT_DIR")"')
    const cmd = WD_SRC.split('\n').find((l) => l.trimStart().startsWith('CMD="'))!
    expect(cmd).toContain('${CODE_MODE_ENV}cd \\"$AGENT_DIR\\"')
    expect(WD_SRC).not.toContain('--continue')
  })
})
