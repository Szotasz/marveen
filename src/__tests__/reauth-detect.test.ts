import { describe, it, expect } from 'vitest'
import { detectReauthNeeded } from '../web/reauth-detect.js'

// Dashboard reauth badge (Szabi 2026-06-03). Must fire on the distinctive
// Claude Code auth-failure strings, and NOT on ordinary chat that merely
// mentions "/login".
describe('detectReauthNeeded', () => {
  it('null/empty pane -> no reauth', () => {
    expect(detectReauthNeeded(null).needsReauth).toBe(false)
    expect(detectReauthNeeded('').needsReauth).toBe(false)
    expect(detectReauthNeeded(undefined).needsReauth).toBe(false)
  })

  it('detects "Please run /login"', () => {
    const r = detectReauthNeeded('Some output\n  Please run /login\n')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/login/i)
  })

  it('detects the 401 invalid-credentials string', () => {
    const r = detectReauthNeeded('API Error: 401 Invalid authentication credentials')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/401|credential/i)
  })

  it('detects "Not logged in"', () => {
    expect(detectReauthNeeded('Not logged in - Please run /login').needsReauth).toBe(true)
  })

  it('detects bare API Error: 401', () => {
    expect(detectReauthNeeded('request failed: API Error: 401').needsReauth).toBe(true)
  })

  it('detects OAuth token expired', () => {
    expect(detectReauthNeeded('Your OAuth token has expired.').needsReauth).toBe(true)
  })

  it('does NOT fire on a chat message mentioning /login as a topic', () => {
    const pane = '❯ hogyan működik a /login parancs?\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })

  it('does NOT fire on a normal idle pane', () => {
    const pane = '✻ Sautéed for 1m\n❯\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })

  it('does NOT fire when the marker is in scrollback ABOVE the tail (review false-positive)', () => {
    // Reproduces the review case: an agent reading reauth-detect.ts has the
    // markers high in scrollback, but its live tail is a normal idle prompt.
    const scrollback = [
      'reviewing: detects "Invalid authentication credentials"',
      'and "Please run /login" and "API Error: 401"',
      ...Array.from({ length: 20 }, (_, i) => `... work line ${i} ...`),
      '❯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(detectReauthNeeded(scrollback).needsReauth).toBe(false)
  })

  it('DOES fire when the marker is in the live tail', () => {
    const pane = [
      ...Array.from({ length: 20 }, (_, i) => `... work line ${i} ...`),
      'API Error: 401 Invalid authentication credentials',
      'Please run /login',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(true)
  })

  // Devy 2026-07-12: recovered agent still badged as broken. The stale
  // "Not logged in" transcript result sits inside the 15-line tail, ABOVE a
  // later "Login successful" -- but the live status line (above the input box)
  // shows a healthy context readout. The status line is what tracks auth.
  it('does NOT fire when a stale login failure is followed by a successful login', () => {
    const pane = [
      '  1 in_progress Devy kártya </scheduled-task>',
      '  ⎿  Not logged in · Please run /login',
      '✻ Crunched for 0s',
      '❯ /login',
      '  ⎿  Login interrupted',
      '❯ /login',
      '  ⎿  Login successful',
      '                                        ~290k uncached · /clear to start fresh',
      '──────────────────────────────────────────────────────────────── Devy ──',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })

  // Finy 2026-07-12, the genuinely-broken twin of the case above: the SAME
  // interrupted-login transcript, but the live status line still says so.
  it('DOES fire when the live status line above the input box reports the failure', () => {
    const pane = [
      '  ⎿  Login interrupted',
      '❯ /login',
      '  ⎿  Login interrupted',
      '                                            Not logged in · Run /login',
      '────────────────────────────────────────────────────────────── Finy ──',
      '❯ ',
      '──────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    const r = detectReauthNeeded(pane)
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/not logged in/i)
  })

  // itzhakstern 2026-09-09, the case the Devy hardening went blind to, and the
  // reason this file now has a lookback. The token expired, so every incoming
  // prompt was refused -- but the session stayed up, so the live status line
  // kept showing an ordinary context readout. The refusal sits 4 lines above the
  // box top (spinner + blank between), i.e. outside the old one-line window.
  // The agent looked healthy for 40 days.
  it('DOES fire on a transactional "Login expired" while the status line looks normal', () => {
    const pane = [
      '❯ [Üzenet @mikrobi-tól]: kérlek nézd meg a mai kártyákat',
      '  ⎿  Login expired · Please run /login',
      '✻ Worked for 0s',
      '',
      '                                        ~158k uncached · /clear to start fresh',
      '──────────────────────────────────────────────────────── itzhakstern ──',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    const r = detectReauthNeeded(pane)
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/login/i)
  })

  // The pair to the test above: SAME shape, same distance from the box, but a
  // completed login after the refusal. This is what keeps the wider window from
  // re-creating the Devy false positive -- recovery decides, not position.
  it('does NOT fire when that same refusal is followed by a completed login', () => {
    const pane = [
      '❯ [Üzenet @mikrobi-tól]: kérlek nézd meg a mai kártyákat',
      '  ⎿  Login expired · Please run /login',
      '❯ /login',
      '  ⎿  Login successful',
      '',
      '                                        ~158k uncached · /clear to start fresh',
      '──────────────────────────────────────────────────────── itzhakstern ──',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })

  // Order matters, not mere presence: a login that succeeded BEFORE a later
  // refusal is not recovery. Without this the guard would silently swallow an
  // agent whose token died again after a successful re-login.
  it('DOES fire when a completed login is followed by a NEW refusal', () => {
    const pane = [
      '❯ /login',
      '  ⎿  Login successful',
      '❯ [Üzenet @mikrobi-tól]: folytasd',
      '  ⎿  Login expired · Please run /login',
      '✻ Worked for 0s',
      '',
      '                                        ~158k uncached · /clear to start fresh',
      '──────────────────────────────────────────────────────── itzhakstern ──',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(true)
  })

  // Review 2026-09-23, found before merge: the recovery guard was a bare
  // substring match, so PROSE containing "Login successful" anywhere in the
  // lookback cancelled a real badge. An agent narrating this very fix, or a
  // quoted healer alert, would have silenced a live outage -- the same
  // self-quote family that bit this file in 2026-06-03 and 2026-07-13, only on
  // the recovery side instead of the marker side. Recovery must look like a
  // tool result, not like talk about one.
  it('DOES fire when only PROSE mentions a successful login after a real failure', () => {
    const pane = [
      '❯ [Üzenet @mikrobi-tól]: folytasd a kártyát',
      '  ⎿  Login expired · Please run /login',
      '❯ mi történt? a naplóban a "Login successful" sor után is elszállt?',
      '✻ Worked for 0s',
      '',
      '                                        ~158k uncached · /clear to start fresh',
      '──────────────────────────────────────────────────────── itzhakstern ──',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    const r = detectReauthNeeded(pane)
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/login/i)
  })

  it('does NOT fire when a prior escalation message is quoted back into the pane (self-loop)', () => {
    // Reproduces the 2026-07-13 bug: the owner pastes the healer's own alert
    // (which embeds the raw marker text) back into the chat, and it re-matches.
    const pane = [
      ...Array.from({ length: 10 }, (_, i) => `... work line ${i} ...`),
      '🔐 A(z) bigme ágens halott OAuth tokent jelez (Please run /login) több mint ~9 perce.',
      'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb), automatikusan nem gyógyítható.',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })

  it('does NOT fire on the quiet-hours morning summary quoted back either', () => {
    const pane = [
      '🔐 Reggeli token-összegzés: az éjszakai csendes sáv (23:00-06:00) alatt elnyomott riasztások. MOST IS halott tokent jelez:',
      '• bigme: Invalid authentication credentials (401) (~45 perce)',
      'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb).',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })

  // 2026-07-15 bootcamp "mass /login": the pane was NOT an auth failure but
  // Claude Code's first-run picker (hasCompletedOnboarding lost from
  // ~/.claude.json). It blocks the agent identically, so it must badge.
  it('detects the first-run "Select login method" onboarding picker', () => {
    const pane = [
      ' Welcome to Claude Code',
      '',
      ' Select login method:',
      '',
      ' ❯ 1. Claude account with subscription',
      '   2. Anthropic Console account',
    ].join('\n')
    const r = detectReauthNeeded(pane)
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/onboarding picker/i)
  })

  it('does NOT fire on a chat that merely mentions the picker in scrollback', () => {
    const pane = [
      '❯ a "Select login method" képernyőről beszéltünk',
      ...Array.from({ length: 20 }, (_, i) => `... work line ${i} ...`),
      '──────────────────────────────────────────────────────────────────────',
      '❯ ',
      '──────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })
})

// Second first-run-gate marker: the state a blind Enter on the picker advances
// into (observed live 2026-07-16: channels.sh's first-run guard selected
// option 1 and parked the session on the browser sign-in screen).
describe('detectReauthNeeded: browser sign-in screen', () => {
  it('detects the sign-in URL screen', () => {
    const pane = [
      ' Use the url below to sign in:',
      '',
      ' https://claude.ai/oauth/authorize?code=...',
      '',
      ' Paste code here if prompted >',
    ].join('\n')
    const r = detectReauthNeeded(pane)
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/sign-in screen/i)
  })

  it('does NOT re-fire on the healer escalation quoting the picker reason (self-loop regression)', () => {
    const pane = [
      ...Array.from({ length: 10 }, (_, i) => `... work line ${i} ...`),
      '🔐 A(z) boni ágens halott OAuth tokent jelez (First-run onboarding picker (Select login method)) több mint ~9 perce.',
      'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb), automatikusan nem gyógyítható.',
    ].join('\n')
    expect(detectReauthNeeded(pane).needsReauth).toBe(false)
  })
})
