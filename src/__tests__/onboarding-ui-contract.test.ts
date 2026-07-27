// String-contract guard for the onboarding wizard and channel-setup surface
// (the house idiom: read frontend files as strings and assert short,
// formatting-proof fragments). Guards wiring that has no functional test.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP            = readFileSync(join(__dirname, '../../web/app.js'),                    'utf-8')
const ONBOARDING_MOD = readFileSync(join(__dirname, '../../web/modules/onboarding.js'),     'utf-8')
const AGENTS_MOD     = readFileSync(join(__dirname, '../../web/modules/agents.js'),         'utf-8')
const HTML           = readFileSync(join(__dirname, '../../web/index.html'),                 'utf-8')

describe('onboarding module wiring', () => {
  it('app.js imports initOnboarding, dismissOnboarding, showSudoModal, initChannelSetup from onboarding.js', () => {
    expect(APP).toMatch(/import\s*\{[^}]*initOnboarding[^}]*\}\s*from\s*['"]\.\/modules\/onboarding\.js['"]/)
    expect(APP).toContain('dismissOnboarding')
    expect(APP).toContain('showSudoModal')
    expect(APP).toContain('initChannelSetup')
  })

  it('onboarding functions are NOT defined in app.js (moved to module)', () => {
    expect(APP).not.toMatch(/^async function initOnboarding\(/m)
    expect(APP).not.toMatch(/^function dismissOnboarding\(/m)
    expect(APP).not.toMatch(/^function showSudoModal\(/m)
    expect(APP).not.toMatch(/^function showSlackManifestModal\(/m)
    expect(APP).not.toMatch(/^function fallbackCopyToClipboard\(/m)
  })

  it('initOnboarding and dismissOnboarding are exported from onboarding.js', () => {
    expect(ONBOARDING_MOD).toMatch(/export async function initOnboarding\(/)
    expect(ONBOARDING_MOD).toMatch(/export function dismissOnboarding\(/)
  })

  it('showSudoModal is exported from onboarding.js', () => {
    expect(ONBOARDING_MOD).toMatch(/export function showSudoModal\(/)
  })

  it('initChannelSetup is exported and uses agentApiName (not private currentAgent)', () => {
    expect(ONBOARDING_MOD).toMatch(/export function initChannelSetup\(/)
    // Must use agentApiName() -- never reference private currentAgent from agents.js
    expect(ONBOARDING_MOD).toContain('agentApiName()')
    expect(ONBOARDING_MOD).not.toContain('currentAgent.name')
  })

  it('showSudoModal is injected into agents.js via initAgents DI', () => {
    // agents.js initAgents must accept showSudoModal in its options
    expect(AGENTS_MOD).toMatch(/showSudoModal[,\s]/)
    // Must use the private DI reference, not call showSudoModal directly
    expect(AGENTS_MOD).toContain('_showSudoModal')
    expect(AGENTS_MOD).toMatch(/_showSudoModal\?\.\(/)
    // Must NOT call showSudoModal directly (which was the pre-existing bug)
    expect(AGENTS_MOD).not.toMatch(/(?<!_)showSudoModal\(/)
  })

  it('onboarding overlay and close button exist in HTML', () => {
    expect(HTML).toContain('id="onboardingOverlay"')
    expect(HTML).toContain('id="onboardingClose"')
    expect(HTML).toContain('id="onboardingBody"')
    expect(HTML).toContain('id="onboardingSteps"')
  })

  it('onboarding wizard API endpoints are in the module', () => {
    expect(ONBOARDING_MOD).toContain('/api/onboarding/status')
    expect(ONBOARDING_MOD).toContain('/api/onboarding/identity')
    expect(ONBOARDING_MOD).toContain('/api/onboarding/claude-auth')
    expect(ONBOARDING_MOD).toContain('/api/onboarding/launch')
  })

  it('Slack manifest API endpoint is in the module', () => {
    expect(ONBOARDING_MOD).toContain('/channels/slack/manifest')
  })

  it('chSlackManifestBtn listener NOT in app.js (moved to initChannelSetup)', () => {
    expect(APP).not.toContain("getElementById('chSlackManifestBtn')")
    expect(APP).not.toMatch(/currentAgent\.name/)
  })
})
