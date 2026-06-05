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
})
