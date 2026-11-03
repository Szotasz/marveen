import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mainChannelsRestartOutcome } from '../web/routes/agents.js'
import { channelsRestartCommand } from '../web/main-agent.js'

// #1878 item 6: a channel save on the main agent restarts the channels session.
// When that restart failed, the route answered restarted:false with no reason,
// and the onboarding step said a neutral "saved", then "still starting" ~2 min
// later. The route now returns restartError, and the step says so at once.
const __dirname = dirname(fileURLToPath(import.meta.url))
const agentsSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')
const appSource = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
const onboardingSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'onboarding.ts'), 'utf8')
const langSource = (lang: string) => readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${lang}.js`), 'utf8')

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a + start.length)
  if (a < 0 || b < 0) throw new Error(`Cannot extract source between ${start} and ${end}`)
  return source.slice(a, b)
}

describe('mainChannelsRestartOutcome', () => {
  it('a successful restart carries no error', () => {
    expect(mainChannelsRestartOutcome({ ok: true })).toEqual({ restarted: true })
  })
  it('a failed restart carries its reason', () => {
    expect(mainChannelsRestartOutcome({ ok: false, error: 'systemctl exit 5' })).toEqual({ restarted: false, restartError: 'systemctl exit 5' })
  })
  it('a failed restart without a reason still reads as failed', () => {
    expect(mainChannelsRestartOutcome({ ok: false })).toEqual({ restarted: false, restartError: 'restart failed' })
  })
})

describe('the channel-save route returns restartError on both main-agent branches', () => {
  const route = between(agentsSource, '// POST /api/agents/:name/channels/:provider (legacy: /telegram) -- setup', '// DELETE /api/agents/:name/channels/:provider')

  it('bot-token branch: the restart goes through the helper and the error reaches the response', () => {
    const botBranch = route.slice(route.indexOf('const { botToken'))
    expect(botBranch).toMatch(/mainChannelsRestartOutcome\(hardRestartMarveenChannels\(\)\)/)
    expect(botBranch).toMatch(/\.\.\.\(restartError \? \{ restartError, restartCommand: channelsRestartCommand\(\) \} : \{\}\)/)
    expect(botBranch).not.toMatch(/restarted = r\.ok/)
  })

  it('Google Chat branch: same', () => {
    const gcBranch = between(route, "if (provider === 'googlechat')", 'const { botToken')
    expect(gcBranch).toMatch(/mainChannelsRestartOutcome\(hardRestartMarveenChannels\(\)\)/)
    expect(gcBranch).toMatch(/restartError: gcRestartError, restartCommand: channelsRestartCommand\(\)/)
    expect(gcBranch).not.toMatch(/gcRestarted = r\.ok/)
  })
})

describe('onboarding step 3 (bot token) surfaces restartError at once', () => {
  it('stops before the channel-live wait with the saved_restart_failed message', () => {
    const step = between(appSource, "const botBtn = document.getElementById('onbBotBtn')", '} else if (step === 4)')
    const errAt = step.indexOf("if (d.restartError) { botBtn.disabled = false; onbMsg(t('onboarding.step2.saved_restart_failed', { cmd: d.restartCommand || '' }), true); return }")
    expect(errAt).toBeGreaterThan(-1)
    expect(errAt).toBeLessThan(step.indexOf('waitForChannelLive('))
  })

  it('the message exists in both languages', () => {
    for (const lang of ['en', 'hu']) {
      expect(langSource(lang)).toMatch(/'onboarding\.step2\.saved_restart_failed':\s*'[^']+'/)
    }
  })
})

// Follow-up (Dani's measurement on #1921): the messages hardcoded
// `systemctl --user restart marveen-channels` (wrong unit on a renamed install,
// no macOS form), and the agent-detail page toasted "connected" on a failed restart.
describe('channelsRestartCommand: this install\'s unit, per platform', () => {
  it('Linux: the user unit named after SERVICE_ID', () => {
    expect(channelsRestartCommand('linux', 'jarvis')).toBe('systemctl --user restart jarvis-channels')
  })
  it('macOS: the launchd job com.<SERVICE_ID>.channels in the GUI domain', () => {
    const cmd = channelsRestartCommand('darwin', 'jarvis')
    expect(cmd).toContain('launchctl kickstart -k gui/$(id -u)/com.jarvis.channels')
    expect(cmd).toContain('~/Library/LaunchAgents/com.jarvis.channels.plist')
    expect(cmd).not.toContain('marveen')
  })
})

describe('every restart-failed response carries the command, every message uses it', () => {
  it('the onboarding identity and auth responses add restartCommand next to restartError', () => {
    expect(onboardingSource.match(/restartError, restartCommand: channelsRestartCommand\(\)/g)?.length).toBe(2)
  })
  it('the three onboarding messages take {cmd} and hardcode no unit, in both languages', () => {
    for (const lang of ['en', 'hu']) {
      for (const key of ['identity', 'step1', 'step2']) {
        const m = langSource(lang).match(new RegExp(`'onboarding\\.${key}\\.saved_restart_failed':\\s*'([^']+)'`))
        expect(m?.[1], `${lang} ${key}`).toContain('{cmd}')
        expect(m?.[1], `${lang} ${key}`).not.toMatch(/systemctl|marveen-channels/)
      }
      expect(langSource(lang)).toMatch(/'agents\.channel\.saved_restart_failed':\s*'[^']*\{provider\}[^']*\{cmd\}[^']*'/)
    }
  })
  it('the three onboarding call sites pass the command', () => {
    for (const key of ['identity', 'step1', 'step2']) {
      expect(appSource).toContain(`t('onboarding.${key}.saved_restart_failed', { cmd: d.restartCommand || '' })`)
    }
  })
  it('the agent-detail channel save does not toast "connected" on a failed restart', () => {
    const save = between(appSource, "const payload = { botToken: token }", "document.getElementById('chTestBtn')")
    const errAt = save.indexOf("if (result.restartError) showToast(t('agents.channel.saved_restart_failed'")
    const okAt = save.indexOf('sikeresen csatlakoztatva')
    expect(errAt).toBeGreaterThan(-1)
    expect(errAt).toBeLessThan(okAt)
    expect(save.slice(errAt, okAt)).toContain('else showToast(')
  })
})
