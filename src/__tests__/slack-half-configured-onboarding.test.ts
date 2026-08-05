import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// PRVERIFY883 regression guard for the HALF-CONFIGURED Slack onboarding state:
// a bot/app token is already saved, but the managed-settings.json plugin
// allowlist is not yet in place, so the Slack channel session can never come
// up. That is the customer's FIRST HOUR, and the happy path is the least
// interesting part of it. The gate function isManagedSettingsReady() is unit-
// tested elsewhere (managed-settings.test.ts); what is NOT otherwise covered is
// the WIRING added by this PR -- and the onboarding route is not unit-mountable
// (see wizard-pending-agent-id.test.ts), so these are structural assertions
// over the source, the convention this repo already uses for wizard invariants.
//
// Each assertion targets a line this PR ADDED; on the pre-PR source all three
// fail (verified by reverting onboarding.ts + web/app.js to the base). If any
// of them passes on the old code, it is locking file-existence, not the
// invariant.

const ONBOARDING = readFileSync(join(__dirname, '..', 'web', 'routes', 'onboarding.ts'), 'utf-8')
const APP = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

// Bound channelConfigured() to its own body so the slack-gate assertion cannot
// accidentally match an isManagedSettingsReady reference elsewhere in the file.
function channelConfiguredBody(): string {
  const start = ONBOARDING.indexOf('function channelConfigured(')
  expect(start, 'channelConfigured not found').toBeGreaterThan(0)
  const end = ONBOARDING.indexOf('\nfunction ', start + 1)
  expect(end, 'channelConfigured end anchor not found -- slice would run past the function').toBeGreaterThan(start)
  return ONBOARDING.slice(start, end)
}

describe('PRVERIFY883: half-configured Slack (token present, managed-settings not ready)', () => {
  // INVARIANT 1: channelConfigured() must NOT read a bare token presence as
  // "configured" for Slack -- it must additionally require the managed-settings
  // allowlist. Pre-PR channelConfigured() was a single token-presence return
  // with no isManagedSettingsReady reference, so this fails on revert.
  it('channelConfigured gates Slack on the managed-settings allowlist, not token presence alone', () => {
    const body = channelConfiguredBody()
    expect(body).toMatch(/CHANNEL_PROVIDER === 'slack'/)
    expect(body).toMatch(/isManagedSettingsReady\(\)/)
    // and it still short-circuits on no token (the non-Slack path stays presence-only)
    expect(body).toMatch(/if \(!hasToken\) return false/)
  })

  // INVARIANT 2: in the half-configured state the status endpoint must hand the
  // operator the sudo command immediately, and the wizard must surface it on
  // step 3 -- so the operator is not left staring at an empty pairing list.
  it('the status endpoint derives sudoCommand only when managed-settings is NOT ready', () => {
    expect(ONBOARDING).toMatch(/managedSettingsReady === false \? getManagedSettingsSudoCommand\(\)/)
    // and it is actually put on the wire (in the status response object)
    expect(ONBOARDING).toMatch(/\n\s*sudoCommand,/)
  })

  it('the wizard surfaces the sudo command on step 3 when the status carries one', () => {
    expect(APP).toMatch(/step === 3 && s\.sudoCommand/)
    expect(APP).toContain('showSudoModal(s.sudoCommand')
  })

  // INVARIANT 3: an empty Slack APP token must be REJECTED at save. Without
  // SLACK_APP_TOKEN the channel session starts but Socket Mode never connects,
  // so "saved" would read as success while Slack silently never comes online --
  // the exact half-ready trap. Pre-PR there was no Slack-specific save branch.
  it('an empty Slack app token is rejected at save (Socket Mode would never connect)', () => {
    expect(APP).toContain('onboarding.step2.app_token_empty_slack')
    // the rejection lives inside the slack save branch and returns early
    const slackBranch = APP.indexOf("if (onboardingChannelProvider === 'slack')")
    expect(slackBranch, 'slack save branch not found').toBeGreaterThan(0)
    const near = APP.slice(slackBranch, slackBranch + 600)
    expect(near).toMatch(/if \(!appToken\)\s*\{[^}]*app_token_empty_slack[^}]*return/)
  })
})
