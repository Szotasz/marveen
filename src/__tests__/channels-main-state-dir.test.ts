import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const channelsSh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')

// hu: A fo ugynok csatorna-allapot konyvtara eddig FIX $HOME/.claude/channels/
//     <provider> volt (MAIN_BOT_PID_FILE). Egy gepen ket telepites igy UGYANAZT
//     a bot.pid-et figyelte: a masik telepites pollere latszott sajatnak, es
//     amikor az cserelodott, a watchdog "eltunt a botom"-ot latott es ujraindult
//     -- kolcsonos restart-ciklus.
// en: The main agent's channel state dir was a fixed $HOME path, so two installs
//     on one host watched the SAME bot.pid and restart-looped against each other.
//
// A feloldas a csatorna-plugin sajat sorrendjet tukrozi (server.ts):
//   <PROVIDER>_STATE_DIR  >  CLAUDE_CONFIG_DIR/channels/<provider>  >  $HOME/...
function extractResolver(): string {
  const m = channelsSh.match(/resolve_main_chan_state_dir\(\)\s*\{[\s\S]*?\n\}/)
  if (!m) throw new Error('resolve_main_chan_state_dir() not found in channels.sh')
  return m[0]
}

function resolve(provider: string, envVarName: string, envValue: string, cfgDir: string): string {
  const script = [
    'set -u',
    'HOME=/home/tester',
    extractResolver(),
    envValue ? `export ${envVarName}='${envValue}'` : `unset ${envVarName} 2>/dev/null || true`,
    `resolve_main_chan_state_dir '${provider}' '${envVarName}' '${cfgDir}'`,
  ].join('\n')
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim()
}

function assignmentLine(name: string): string | undefined {
  for (const l of channelsSh.split('\n')) {
    if (l.trimStart().startsWith(name + '=')) return l
  }
  return undefined
}

describe('channels.sh: a fo ugynok csatorna-allapot konyvtara telepitesenkent', () => {
  it('a <PROVIDER>_STATE_DIR env gyoz, ha be van allitva', () => {
    expect(resolve('telegram', 'TELEGRAM_STATE_DIR', '/x/.claude/channels/telegram-marveen', '/x/Marveen/.channels-config'))
      .toBe('/x/.claude/channels/telegram-marveen')
  })

  it('env nelkul a telepites sajat CLAUDE_CONFIG_DIR-jebol szarmazik -- ez valasztja szet a ket telepitest', () => {
    expect(resolve('telegram', 'TELEGRAM_STATE_DIR', '', '/x/Marveen/.channels-config'))
      .toBe('/x/Marveen/.channels-config/channels/telegram')
    expect(resolve('telegram', 'TELEGRAM_STATE_DIR', '', '/x/Jarvis/.channels-config'))
      .toBe('/x/Jarvis/.channels-config/channels/telegram')
  })

  it('izolalt config nelkul a regi globalis ut marad (visszafele kompatibilitas)', () => {
    expect(resolve('telegram', 'TELEGRAM_STATE_DIR', '', ''))
      .toBe('/home/tester/.claude/channels/telegram')
  })

  it('provider-fuggetlen: slack a SLACK_STATE_DIR-t es a sajat alkonyvtarat kapja', () => {
    expect(resolve('slack', 'SLACK_STATE_DIR', '/x/.claude/channels/slack-marveen', '/x/M/.channels-config'))
      .toBe('/x/.claude/channels/slack-marveen')
    expect(resolve('slack', 'SLACK_STATE_DIR', '', '/x/M/.channels-config'))
      .toBe('/x/M/.channels-config/channels/slack')
  })

  // A watchdog PID-fajlja ebbol a feloldasbol szarmazzon, ne fix $HOME utbol --
  // kulonben a szetvalasztas a plugin oldalan megvan, a watchdog viszont
  // tovabbra is a masik telepites bot.pid-jet figyeli.
  it('a MAIN_BOT_PID_FILE a feloldott konyvtarbol szarmazik, nem fix $HOME utbol', () => {
    const line = assignmentLine('MAIN_BOT_PID_FILE')
    expect(line, 'MAIN_BOT_PID_FILE assignment not found').toBeTruthy()
    expect(line).not.toContain('$HOME/.claude/channels')
    expect(line).toContain('MAIN_CHAN_STATE_DIR')
  })

  // Ugyanez az orphan-reap celpontjara: eddig $INSTALL_DIR/.claude/channels/...
  // volt, ami egyik telepitesnel sem letezik -- a reap ezert sosem talalt semmit.
  it('a MAIN_CHAN_DIR is a feloldott konyvtar (a reap kulonben vak marad)', () => {
    const line = assignmentLine('MAIN_CHAN_DIR')
    expect(line, 'MAIN_CHAN_DIR assignment not found').toBeTruthy()
    expect(line).toContain('MAIN_CHAN_STATE_DIR')
  })
})
