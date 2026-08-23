// String-contract guard for the Federation dashboard surface (the house
// idiom: schedule-run-now.test.ts / dashboard-modal-css-contract.test.ts read
// the frontend files as strings and assert short, formatting-proof
// fragments). Guards the wiring that has NO functional test: the sidebar
// anchor, the router hook, the page loader and the security discipline that
// peer-controlled manifest strings never reach attribute contexts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAllCss } from './css-helper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP        = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
// Agents view + channel management extracted to agents.js in S-6 modularization.
const AGENTS_MOD = readFileSync(join(__dirname, '../../web/modules/agents.js'), 'utf-8')
// Messages/chat section extracted to messages.js in S-10 modularization.
const MESSAGES_MOD = readFileSync(join(__dirname, '../../web/modules/messages.js'), 'utf-8')
// Federation page extracted to federation.js in S-13b modularization.
const FEDERATION_MOD = readFileSync(join(__dirname, '../../web/modules/federation.js'), 'utf-8')
const APP_CORE   = readFileSync(join(__dirname, '../../web/modules/app-core.js'), 'utf-8')
const HTML       = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS        = readAllCss()

describe('federation UI wiring', () => {
  it('sidebar has the federation nav item AFTER the ideabox item', () => {
    const ideas = HTML.indexOf('data-page="ideas"')
    const federation = HTML.indexOf('data-page="federation"')
    // After #742 sidebar groups: federation is in KAPCSOLATOK (connections),
    // which comes after RENDSZER (system) where updates lives. Both appear
    // after ideas (in TUDAS/knowledge group).
    expect(federation).toBeGreaterThan(ideas)
    expect(federation).toBeGreaterThan(-1)
  })

  it('page div, router dispatch and hoisted loader exist', () => {
    expect(HTML).toContain('id="federationPage"')
    // router dispatch: page is registered in app.js via registerPage()
    expect(APP).toMatch(/registerPage\('federation'/)
    // loader implementation lives in federation.js after S-13b modularization
    expect(FEDERATION_MOD).toMatch(/async function loadFederationPage\(/)
    // nav key and page-header i18n map live in app-core.js after S-3 modularization
    expect(APP_CORE).toContain("federation: 'nav.federation'")
    expect(APP_CORE).toContain('federationPage: {')
  })

  it('frontend consumes the round-2 endpoints', () => {
    // endpoints live in federation.js after S-13b modularization
    expect(FEDERATION_MOD).toContain('/api/federation/status')
    expect(FEDERATION_MOD).toContain('/api/federation/peers')
    expect(FEDERATION_MOD).toContain('/api/federation/refresh')
    expect(FEDERATION_MOD).toContain('/api/federation/enabled')
    expect(FEDERATION_MOD).toContain('/api/federation/remove')
    expect(FEDERATION_MOD).toContain('/inbound-token')
    expect(FEDERATION_MOD).toContain('/rotate-inbound-token')
  })

  it('the federation status fetches are failure-proof (must never blank Agents/Messages)', () => {
    // loadAgents is in agents.js (S-6); loadFederationPage is in federation.js (S-13b)
    const combined = AGENTS_MOD + FEDERATION_MOD
    const guarded = combined.match(/fetch\('\/api\/federation\/status'\)\.then\(\(r\) => \(r\.ok \? r\.json\(\) : null\)\)\.catch\(\(\) => null\)/g) || []
    expect(guarded.length).toBeGreaterThanOrEqual(2) // loadAgents + loadFederationPage
  })

  it('federated agents live in a SEPARATE store from the local `agents` global', () => {
    // federatedPeerStatus extracted to agents.js in S-6 modularization.
    expect(AGENTS_MOD).toContain('let federatedPeerStatus = []')
    // the team editor's candidate source must stay the local list only:
    const combined = AGENTS_MOD + APP
    expect(combined).not.toMatch(/agents\.push\(.*federated/i)
  })

  it('manifest-derived strings render as text nodes via escapeHtml, never in attributes', () => {
    // renderFederatedAgentCards is in agents.js after S-6 extraction.
    const cardFn = AGENTS_MOD.slice(AGENTS_MOD.indexOf('function renderFederatedAgentCards'), AGENTS_MOD.indexOf('function openFederatedThread'))
    expect(cardFn).toContain('escapeHtml(fa.displayName)')
    expect(cardFn).toContain('escapeHtml(fa.model)')
    // No template interpolation inside an HTML attribute in the federated card
    // renderer (class="...${...}" or title="...${...}" with peer data):
    expect(cardFn).not.toMatch(/(class|title|alt|data-\w+)="[^"]*\$\{[^}]*fa\./)
  })

  it('federated card CSS exists and disarms the click affordance', () => {
    expect(CSS).toContain('.federated-agent-card')
    expect(CSS).toMatch(/\.federated-agent-card\s*{[^}]*cursor:\s*default/)
    expect(CSS).toContain('.federated-badge')
  })

  it('the top-right button applies settings by restarting the MAIN agent (no terminal, no misleading refresh)', () => {
    // The federation page's primary action is APPLY (restart the main agent),
    // NOT a status-only "refresh". The old refresh button id is gone.
    expect(HTML).toContain('id="federationApplyBtn"')
    expect(HTML).not.toContain('id="federationRefreshBtn"')
    expect(HTML).toContain('data-i18n="federation.btn.apply"')
    // implementation lives in federation.js after S-13b modularization
    expect(FEDERATION_MOD).toMatch(/async function fedApplyToMainAgent/)
    const fn = FEDERATION_MOD.slice(FEDERATION_MOD.indexOf('function fedApplyToMainAgent'), FEDERATION_MOD.indexOf('async function fedRefreshAndReload'))
    expect(fn).toContain("confirm(t('federation.confirm.apply'))")
    // Server-side apply endpoint -- NOT the client-agent-id-dependent restart
    // (which 404'd when window._marveen was not loaded on the federation page).
    expect(fn).toMatch(/fetch\('\/api\/federation\/apply'/)
    expect(fn).not.toMatch(/fetch\(`\/api\/agents\//)
    // Status auto-refreshes after config mutations (enable, peer add) instead
    // of a manual refresh button.
    expect(FEDERATION_MOD).toMatch(/async function fedRefreshAndReload/)
    expect(FEDERATION_MOD).toContain("document.getElementById('federationApplyBtn')")
  })

  it('the per-peer capability-share checkbox is wired to a PATCH (L5)', () => {
    // implementation lives in federation.js after S-13b modularization
    expect(FEDERATION_MOD).toContain('fed-share-cap')
    expect(FEDERATION_MOD).toContain('shareCapabilitySummaries')
    expect(FEDERATION_MOD).toMatch(/async function fedToggleShareCap/)
    // Reads its checked state from the peerView flag, mirrors the master switch.
    expect(FEDERATION_MOD).toContain('peer.shareCapabilitySummaries')
  })

  it('the pending-to-main hint is gated on pending status AND the main-agent recipient (L2)', () => {
    // buildBubbleHtml extracted to messages.js in S-10
    const src = MESSAGES_MOD
    const bubbleFn = src.slice(src.indexOf('function buildBubbleHtml'), src.indexOf('function fetchChatPage'))
    const hintIdx = bubbleFn.indexOf("t('messages.pending_main_hint')")
    expect(hintIdx).toBeGreaterThan(-1)
    // The guard must sit in the same expression: only a PENDING message
    // addressed to the MAIN agent gets the auto-pickup promise.
    const guard = bubbleFn.slice(Math.max(0, hintIdx - 200), hintIdx)
    expect(guard).toMatch(/status === 'pending'/)
    expect(guard).toMatch(/to_agent === mainAgentId\(\)/)
  })

  it('the routing-mode selector is wired to /api/federation/routing-mode for all three modes', () => {
    // implementation lives in federation.js after S-13b modularization
    expect(FEDERATION_MOD).toContain('name="fedRoutingMode"')
    expect(FEDERATION_MOD).toContain('/api/federation/routing-mode')
    expect(FEDERATION_MOD).toContain("['strong', 'catalog-first', 'advisory']")
    // reads the current mode from the peers view and renders label + hint per mode
    expect(FEDERATION_MOD).toContain('view.routingMode')
    expect(FEDERATION_MOD).toContain("federation.routing.mode.' + m + '.label")
    expect(FEDERATION_MOD).toContain("federation.routing.mode.' + m + '.hint")
  })

  it('nav + core keys exist in BOTH language files', async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
    for (const lang of ['hu', 'en'] as const) {
      expect(i18n[lang]['nav.federation']).toBeTruthy()
      expect(i18n[lang]['federation.page_title']).toBeTruthy()
      expect(i18n[lang]['federation.peer_state.auth-or-disabled']).toBeTruthy()
      expect(i18n[lang]['federation.confirm.remove']).toBeTruthy()
      // Human-visible strings say federated, never the SSH feature's "remote":
      expect((i18n[lang]['federation.badge'] || '').toLowerCase()).not.toContain('remote')
      // Routing-mode selector: title + label/hint for every mode, both languages.
      expect(i18n[lang]['federation.routing.title']).toBeTruthy()
      for (const m of ['strong', 'catalog-first', 'advisory'] as const) {
        expect(i18n[lang][`federation.routing.mode.${m}.label`]).toBeTruthy()
        expect(i18n[lang][`federation.routing.mode.${m}.hint`]).toBeTruthy()
      }
    }
  })
})
