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

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

describe('federation UI wiring', () => {
  it('sidebar has the federation nav item AFTER the ideabox item', () => {
    const ideas = HTML.indexOf('data-page="ideas"')
    const federation = HTML.indexOf('data-page="federation"')
    const updates = HTML.indexOf('data-page="updates"')
    expect(federation).toBeGreaterThan(ideas)
    expect(federation).toBeLessThan(updates)
  })

  it('page div, router dispatch and hoisted loader exist', () => {
    expect(HTML).toContain('id="federationPage"')
    expect(APP).toMatch(/pageId === 'federation'/)
    expect(APP).toMatch(/async function loadFederationPage\(/)
    expect(APP).toContain("federation: 'nav.federation'")
    expect(APP).toContain('federationPage: {')
  })

  it('frontend consumes the round-2 endpoints', () => {
    expect(APP).toContain('/api/federation/status')
    expect(APP).toContain('/api/federation/peers')
    expect(APP).toContain('/api/federation/refresh')
    expect(APP).toContain('/api/federation/enabled')
    expect(APP).toContain('/api/federation/remove')
    expect(APP).toContain('/inbound-token')
    expect(APP).toContain('/rotate-inbound-token')
  })

  it('the federation status fetches are failure-proof (must never blank Agents/Messages)', () => {
    const guarded = APP.match(/fetch\('\/api\/federation\/status'\)\.then\(\(r\) => \(r\.ok \? r\.json\(\) : null\)\)\.catch\(\(\) => null\)/g) || []
    expect(guarded.length).toBeGreaterThanOrEqual(2) // loadAgents + loadChatAgentList
  })

  it('federated agents live in a SEPARATE store from the local `agents` global', () => {
    expect(APP).toContain('let federatedPeerStatus = []')
    // the team editor's candidate source must stay the local list only:
    expect(APP).not.toMatch(/agents\.push\(.*federated/i)
  })

  it('manifest-derived strings render as text nodes via escapeHtml, never in attributes', () => {
    const cardFn = APP.slice(APP.indexOf('function renderFederatedAgentCards'), APP.indexOf('function openFederatedThread'))
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
    expect(APP).toMatch(/async function fedApplyToMainAgent/)
    const fn = APP.slice(APP.indexOf('function fedApplyToMainAgent'), APP.indexOf('async function fedRefreshAndReload'))
    expect(fn).toContain("confirm(t('federation.confirm.apply'))")
    // Server-side apply endpoint -- NOT the client-agent-id-dependent restart
    // (which 404'd when window._marveen was not loaded on the federation page).
    expect(fn).toMatch(/fetch\('\/api\/federation\/apply'/)
    expect(fn).not.toMatch(/fetch\(`\/api\/agents\//)
    // Status auto-refreshes after config mutations (enable, peer add) instead
    // of a manual refresh button.
    expect(APP).toMatch(/async function fedRefreshAndReload/)
    expect(APP).toContain("document.getElementById('federationApplyBtn')")
  })

  it('the per-peer capability-share checkbox is wired to a PATCH (L5)', () => {
    expect(APP).toContain('fed-share-cap')
    expect(APP).toContain('shareCapabilitySummaries')
    expect(APP).toMatch(/async function fedToggleShareCap/)
    // Reads its checked state from the peerView flag, mirrors the master switch.
    expect(APP).toContain('peer.shareCapabilitySummaries')
  })

  it('the pending-to-main hint is gated on pending status AND the main-agent recipient (L2)', () => {
    const bubbleFn = APP.slice(APP.indexOf('function buildBubbleHtml'), APP.indexOf('function fetchChatPage'))
    const hintIdx = bubbleFn.indexOf("t('messages.pending_main_hint')")
    expect(hintIdx).toBeGreaterThan(-1)
    // The guard must sit in the same expression: only a PENDING message
    // addressed to the MAIN agent gets the auto-pickup promise.
    const guard = bubbleFn.slice(Math.max(0, hintIdx - 200), hintIdx)
    expect(guard).toMatch(/status === 'pending'/)
    expect(guard).toMatch(/to_agent === mainAgentId\(\)/)
  })

  it('the routing-mode selector is wired to /api/federation/routing-mode for all three modes', () => {
    expect(APP).toContain('name="fedRoutingMode"')
    expect(APP).toContain('/api/federation/routing-mode')
    expect(APP).toContain("['strong', 'catalog-first', 'advisory']")
    // reads the current mode from the peers view and renders label + hint per mode
    expect(APP).toContain('view.routingMode')
    expect(APP).toContain("federation.routing.mode.' + m + '.label")
    expect(APP).toContain("federation.routing.mode.' + m + '.hint")
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
