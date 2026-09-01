import { describe, it, expect, afterEach } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { channelStateDir } from '../channel-provider.js'

// hu: Egy gepen tobb Marveen-telepites is futhat (kulon WEB_PORT, kulon bot).
//     A fo ugynok csatorna-allapota eddig FIX ~/.claude/channels/<provider> volt,
//     igy ket telepites ugyanabban a .env-ben, bot.pid-ben es access.json-ben
//     dolgozott: a masodik telepito felulirta az elso bot-tokenjet, a plugin
//     orphan-killere pedig a kozos bot.pid alapjan kiloette a masik pollert.
// en: Multiple installs can share a host. The main agent's channel state was a
//     fixed ~/.claude/channels/<provider>, so two installs shared one .env,
//     bot.pid and access.json -- the second install overwrote the first's token
//     and the plugin's orphan-killer shot down the other install's poller.
describe('channelStateDir -- telepitesenkenti elkulonites', () => {
  const saved = { ...process.env }

  afterEach(() => {
    for (const k of ['TELEGRAM_STATE_DIR', 'SLACK_STATE_DIR', 'DISCORD_STATE_DIR']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('a fo ugynok a provider-specifikus STATE_DIR env-et hasznalja, ha be van allitva', () => {
    process.env['TELEGRAM_STATE_DIR'] = '/Users/x/.claude/channels/telegram-marveen'
    expect(channelStateDir('telegram')).toBe('/Users/x/.claude/channels/telegram-marveen')
  })

  it('env nelkul a globalis alapertelmezes marad (visszafele kompatibilitas)', () => {
    delete process.env['TELEGRAM_STATE_DIR']
    expect(channelStateDir('telegram')).toBe(join(homedir(), '.claude', 'channels', 'telegram'))
  })

  // A LENYEGI NEGATIV ESET: a dashboard a fo session env-jebol orokli a
  // TELEGRAM_STATE_DIR-t, es ugyanaz a folyamat szamolja a SUB-agentek utjat is.
  // Ha az env a sub-agent agat is felulirna, minden fej egyetlen konyvtarba
  // omlana -- egy bot.pid, egy token, kolcsonos kiloves az egesz flottaban.
  it('a sub-agent ag NEM veszi at az env-et -- az agentDir gyoz', () => {
    process.env['TELEGRAM_STATE_DIR'] = '/Users/x/.claude/channels/telegram-marveen'
    expect(channelStateDir('telegram', '/Users/x/Marveen/agents/delphi'))
      .toBe(join('/Users/x/Marveen/agents/delphi', '.claude', 'channels', 'telegram'))
  })

  it('provideenkent kulon env: a slack a SLACK_STATE_DIR-t nezi, nem a telegramet', () => {
    process.env['TELEGRAM_STATE_DIR'] = '/Users/x/.claude/channels/telegram-marveen'
    process.env['SLACK_STATE_DIR'] = '/Users/x/.claude/channels/slack-marveen'
    expect(channelStateDir('slack')).toBe('/Users/x/.claude/channels/slack-marveen')
    expect(channelStateDir('discord')).toBe(join(homedir(), '.claude', 'channels', 'discord'))
  })
})
