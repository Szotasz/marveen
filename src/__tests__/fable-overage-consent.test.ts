import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampFableOverageConsent } from '../web/agent-process.js'
import { detectsBlockingMenu, detectsModelConsentDialog } from '../pane-state.js'

const ORG = '238d7fa8-0000-4000-8000-000000000000'
const ACCT = '4039fb28-0000-4000-8000-000000000000'

describe('stampFableOverageConsent', () => {
  let dir: string
  let dotClaude: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fable-consent-'))
    dotClaude = join(dir, '.claude.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stamps the org-keyed consent when oauthAccount is present', () => {
    writeFileSync(dotClaude, JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { organizationUuid: ORG, accountUuid: ACCT },
    }))
    expect(stampFableOverageConsent(dotClaude)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.fableOverageConsentV2[ORG]).toBe(true)
    expect(data.hasCompletedOnboarding).toBe(true) // other keys preserved
  })

  it('is a no-op when consent is already stamped', () => {
    writeFileSync(dotClaude, JSON.stringify({
      oauthAccount: { organizationUuid: ORG },
      fableOverageConsentV2: { [ORG]: true },
    }))
    expect(stampFableOverageConsent(dotClaude)).toBe(false)
  })

  it('preserves existing consent entries for other orgs', () => {
    writeFileSync(dotClaude, JSON.stringify({
      oauthAccount: { organizationUuid: ORG },
      fableOverageConsentV2: { 'other-org': true },
    }))
    expect(stampFableOverageConsent(dotClaude)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.fableOverageConsentV2['other-org']).toBe(true)
    expect(data.fableOverageConsentV2[ORG]).toBe(true)
  })

  it('falls back to the acct: key when the account has no org', () => {
    writeFileSync(dotClaude, JSON.stringify({
      oauthAccount: { accountUuid: ACCT },
    }))
    expect(stampFableOverageConsent(dotClaude)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.fableOverageConsentV2[`acct:${ACCT}`]).toBe(true)
  })

  it('leaves a config without oauthAccount alone (nothing to key on)', () => {
    writeFileSync(dotClaude, JSON.stringify({ hasCompletedOnboarding: true }))
    expect(stampFableOverageConsent(dotClaude)).toBe(false)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.fableOverageConsentV2).toBeUndefined()
  })

  it('does not create a missing file', () => {
    expect(stampFableOverageConsent(dotClaude)).toBe(false)
    expect(existsSync(dotClaude)).toBe(false)
  })

  it('returns false on unparseable JSON without destroying the file', () => {
    writeFileSync(dotClaude, '{ not json')
    expect(stampFableOverageConsent(dotClaude)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe('{ not json')
  })
})

// The dialog as captured live on agent-deeper, 2026-07-23 (abridged chrome).
const CONSENT_DIALOG_PANE = `
  Fable 5 now uses usage credits
  Fable 5 runs on usage credits, purchased separately from your plan.
  Learn more: https://support.claude.com/en/articles/12429409
    1. Continue with Fable 5
  ❯ 2. Switch to Sonnet 5 and continue
  Enter to confirm · Esc to cancel
`

describe('detectsModelConsentDialog', () => {
  it('detects the live usage-credit model-switch dialog', () => {
    expect(detectsModelConsentDialog(CONSENT_DIALOG_PANE)).toBe(true)
  })

  // FABLEFALL1 regression anchor: the consent dialog ALSO satisfies the generic
  // stuck-menu detector (its footer says "Esc to cancel"), so any recovery
  // branch keyed on detectsBlockingMenu alone WILL reach it with a blind
  // keystroke. This test pins the shadowing itself: if it ever fails because
  // detectsBlockingMenu stops matching, the ordering guards in
  // channel-monitor can be simplified -- until then, every blind-keystroke
  // branch must probe detectsModelConsentDialog FIRST (measured field impact:
  // 12 customer events + 5 local events, choice:"cancelled", session continued
  // on the fallback model).
  it('is shadowed by detectsBlockingMenu -- guards must check consent first', () => {
    expect(detectsBlockingMenu(CONSENT_DIALOG_PANE)).toBe(true)
    expect(detectsModelConsentDialog(CONSENT_DIALOG_PANE)).toBe(true)
  })

  it('is model-name agnostic', () => {
    const pane = CONSENT_DIALOG_PANE.replaceAll('Fable 5', 'Newmodel 7').replaceAll('Sonnet 5', 'Haiku 9')
    expect(detectsModelConsentDialog(pane)).toBe(true)
  })

  it('ignores quoted dialog text when the idle prompt is live', () => {
    const pane = `
  Message says: "Fable 5 now uses usage credits ... 1. Continue with Fable 5 ... Enter to confirm"
❯
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`
    expect(detectsModelConsentDialog(pane)).toBe(false)
  })

  it('ignores quoted dialog text on a busy pane', () => {
    const pane = `
  Fable 5 now uses usage credits
    1. Continue with Fable 5
  Enter to confirm
  esc to interrupt
`
    expect(detectsModelConsentDialog(pane)).toBe(false)
  })

  it('requires the confirm hint in the live footer region', () => {
    const lines = [
      '  Fable 5 now uses usage credits',
      '    1. Continue with Fable 5',
      '  Enter to confirm',
      ...Array.from({ length: 12 }, () => '  scrollback filler'),
    ]
    expect(detectsModelConsentDialog(lines.join('\n'))).toBe(false)
  })

  it('requires the continue option, not just the title', () => {
    const pane = `
  Fable 5 now uses usage credits
  Enter to confirm · Esc to cancel
`
    expect(detectsModelConsentDialog(pane)).toBe(false)
  })

  it('returns false on empty input', () => {
    expect(detectsModelConsentDialog('')).toBe(false)
  })
})
