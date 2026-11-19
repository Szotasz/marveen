// CODEMODEFLAG1119: the per-agent Code Mode switch at launch. codeMode true in agent-config.json -> the launch command
// exports CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1; false or missing -> it is not exported AND it is unset, so a value the
// tmux server carries can never switch it on. An agent without codeMode launches exactly as before apart from that
// one unset token, pinned below on the launch line itself.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const tmpRoot = mkdtempSync(join(tmpdir(), 'code-mode-launch-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: tmpRoot }))

const { readAgentCodeMode, writeAgentCodeMode } = await import('../web/agent-config.js')
const { codeModeLaunchEnv } = await import('../web/agent-process.js')

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
  it('on -> the export; off -> nothing at all', () => {
    expect(codeModeLaunchEnv(true)).toBe(`export ${VAR}=1 && `)
    expect(codeModeLaunchEnv(false)).toBe('')
  })
})

describe('the launch command (startAgentProcess)', () => {
  // Today's command on origin/develop 484d3d21, verbatim. The only allowed differences: the unset token and the
  // ${codeModeEnv} piece, which is '' for an agent without codeMode.
  const UNSET_BEFORE = "const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR'"
  const CMD_BEFORE = 'const buildLaunchCmd = (launchCwd: string) => `${umaskPrefix}export PATH="${venvPathPrefix}/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${stateFence}${autoUpdaterEnv}${byoUnsetEnv}${promptSuggestionEnv}${mcpEnv}${channelSetup}${apiKeyEnv}${claudeConfigEnv}${helperTokenEnvPiece}${agentEgressEnv}${oauthTokenEnv}${providerEnv}${stateObserverEnv}cd "${launchCwd}" && ${claudeBin()} ${continueFlag}${skipFlag}--model ${shSingleQuote(model)} ${channelFlag}${worksourceFlags}${bashSandboxFlag}`.trimEnd()'

  it('the unset line is today\'s plus exactly one token, the Code Mode variable', () => {
    expect(lineAt('const unsetTokens = ').trim()).toBe(UNSET_BEFORE.slice(0, -1) + ` ${VAR}'`)
  })

  it('the launch line is today\'s plus exactly ${codeModeEnv}, after the unset and before cd/claude', () => {
    const line = lineAt('const buildLaunchCmd = ').trim()
    expect(line.replace('${codeModeEnv}', '')).toBe(CMD_BEFORE)
    expect(line.split('${codeModeEnv}')).toHaveLength(2)
    expect(line.indexOf('${unsetTokens}')).toBeLessThan(line.indexOf('${codeModeEnv}'))
    expect(line.indexOf('${codeModeEnv}')).toBeLessThan(line.indexOf('cd "${launchCwd}"'))
  })

  it('the piece is read from this agent\'s own config, at launch', () => {
    expect(FN).toContain('const codeModeEnv = codeModeLaunchEnv(readAgentCodeMode(name))')
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

  it('off: an inherited value is gone by the time claude would start', () => {
    expect(seen(false)).toBe('UNSET')
  })

  it('on: the variable is 1', () => {
    expect(seen(true)).toBe('1')
  })
})
