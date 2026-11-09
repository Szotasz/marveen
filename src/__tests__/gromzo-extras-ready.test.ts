// GROMZOEXTRASREADY1109 (Samu 73946): on a CHANNEL_PROVIDER=gromzo install the isolated MAIN config enables the gromzo
// plugin only once the main agent is primary-ready. Measured on the QA VPS 11-09 (V20): while PENDING the isolated
// settings.json still had enabledPlugins.gromzo-channel@gromzo-local = true, the pending claude started the plugin
// without MXD_AGENT (CONNECTION_CLOSED), and the next, ready session came up without its Gromzo channel.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainIsolatedExtraPluginIds } from '../web/agent-process.js'

const G = 'gromzo-channel@gromzo-local'
const S = 'slack-channel@marveen-marketplace'
const RAW = `${G} ${S}`

function usableSock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gz-extras-'))
  const sock = join(dir, 'agent.sock')
  writeFileSync(sock, '')
  return sock
}

describe('the isolated main config: the gromzo id only when the main agent is primary-ready (gromzo provider)', () => {
  it('gromzo provider, PENDING: the gromzo id is left out, every other extra kept', () => {
    expect(mainIsolatedExtraPluginIds('gromzo', 'marveen', RAW, { sockPath: usableSock(), primaryReady: () => false })).toEqual([S])
  })
  it('gromzo provider, READY: the gromzo id is enabled', () => {
    expect(mainIsolatedExtraPluginIds('gromzo', 'marveen', RAW, { sockPath: usableSock(), primaryReady: () => true })).toEqual([G, S])
  })
  it('the ready check gets the main agent id', () => {
    const seen: string[] = []
    mainIsolatedExtraPluginIds('gromzo', 'boss', RAW, { sockPath: usableSock(), primaryReady: (id) => { seen.push(id); return true } })
    expect(seen).toEqual(['boss'])
  })
  it('another provider (gromzo as an EXTRA): unchanged, only the socket/slug filter as before', () => {
    expect(mainIsolatedExtraPluginIds('telegram', 'marveen', RAW, { sockPath: usableSock(), primaryReady: () => false })).toEqual([G, S])
  })
  it('no usable socket: the gromzo id is out on every provider, as before (filterMainGromzoIds)', () => {
    const none = join(mkdtempSync(join(tmpdir(), 'gz-extras-')), 'agent.sock')
    expect(mainIsolatedExtraPluginIds('gromzo', 'marveen', RAW, { sockPath: none, primaryReady: () => true })).toEqual([S])
    expect(mainIsolatedExtraPluginIds('telegram', 'marveen', RAW, { sockPath: none })).toEqual([S])
  })
  it('readExtraChannelPluginIds reads CHANNEL_PROVIDER from the .env and goes through the helper', () => {
    const ap = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf8')
    expect(ap).toMatch(/const env = readEnvFile\(\['CHANNEL_PLUGINS_EXTRA', 'MAIN_AGENT_ID', 'CHANNEL_PROVIDER'\]\)\n\s+return mainIsolatedExtraPluginIds\(env\['CHANNEL_PROVIDER'\] \|\| CHANNEL_PROVIDER, env\['MAIN_AGENT_ID'\] \?\? '', env\['CHANNEL_PLUGINS_EXTRA'\] \?\? ''\)/)
  })
})
