import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mainAgentChannelsLinkTarget } from '../web/agent-process.js'

// hu: Az izolalt CLAUDE_CONFIG_DIR-t a fo ugynok MINDEN indulasakor ujragyartja
//     (provisionIsolatedConfigDir): minden ~/.claude bejegyzest symlinkel, a
//     'channels'-t is. Emiatt egy kezzel szetvalasztott csatorna-konyvtar az
//     elso ujraindulasnal visszaallt a KOZOS ~/.claude/channels-re, es a ket
//     telepites megint egy .env-en/bot.pid-en osztozott.
//
//     A javitas: ha letezik a telepiteshez tartozo <provider>-<agentId>
//     konyvtar, a 'channels/<provider>' arra mutasson. Ha NEM letezik, maradjon
//     a regi globalis symlink -- kulonben egy meglevo telepites a frissites utan
//     egy URES konyvtarba nezne, nem talalna a bot-tokent, es NEMA maradna.
// en: The isolated config dir is re-provisioned on every main-agent start and
//     symlinks 'channels' to the shared ~/.claude/channels, which undid any
//     manual per-install split. Switch to <provider>-<agentId> only when that
//     directory already exists; otherwise keep the global link so an existing
//     install never loses its bot token.
describe('mainAgentChannelsLinkTarget', () => {
  const CH = join(homedir(), '.claude', 'channels')

  it('a telepiteshez tartozo konyvtarra mutat, ha az letezik', () => {
    const target = join(CH, 'telegram-marveen')
    expect(mainAgentChannelsLinkTarget('telegram', 'marveen', (p) => p === target)).toBe(target)
  })

  it('ket telepites ket kulon celt kap', () => {
    const m = join(CH, 'telegram-marveen')
    const j = join(CH, 'telegram-jarvis')
    const both = (p: string) => p === m || p === j
    expect(mainAgentChannelsLinkTarget('telegram', 'marveen', both)).toBe(m)
    expect(mainAgentChannelsLinkTarget('telegram', 'jarvis', both)).toBe(j)
  })

  // A LENYEGI NEGATIV ESET: konyvtar nelkul NEM szabad ratolni a linket egy nem
  // letezo utra -- az a meglevo telepitesek bot-tokenjet vagna el.
  it('null, ha a konyvtar meg nem letezik -- marad a globalis symlink', () => {
    expect(mainAgentChannelsLinkTarget('telegram', 'marveen', () => false)).toBeNull()
  })

  it('providerenkent kulon konyvtar', () => {
    const s = join(CH, 'slack-marveen')
    expect(mainAgentChannelsLinkTarget('slack', 'marveen', (p) => p === s)).toBe(s)
  })

  it('ures agentId eseten nem talal ki nevet', () => {
    expect(mainAgentChannelsLinkTarget('telegram', '', () => true)).toBeNull()
  })
})
