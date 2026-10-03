import { describe, it, expect } from 'vitest'
import {
  detectsBlockingMenu,
  detectsUsageLimitScreen,
  decideUsageLimitAlert,
  USAGE_LIMIT_EPISODE_GAP_MS,
} from '../pane-state.js'

// USAGELIMIT1003. Synthetic captures with the layout measured on a live pane
// (2026-10-03): the footer shape after the picker was dismissed, and the picker
// itself (labels from the CLI's own rate-limit options component).
const RULE = '─'.repeat(60)

const LIMIT_FOOTER = [
  '  ⎿  You’ve hit your weekly limit · resets 12pm (UTC)',
  '     Continuing automatically at 12pm · esc to cancel',
  '',
  '✻ Worked for 0s · done 5:08 PM',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⚠ Usage limit reached · continuing automatically at 12pm · esc to cancel',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  '',
].join('\n')

// The same footer without the permission-mode line, so IDLE_FOOTER_RX does
// not catch it -- the new guard alone must keep it from reading as a menu.
const LIMIT_FOOTER_BARE = [
  '✻ Worked for 0s · done 5:08 PM',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⚠ Usage limit reached · continuing automatically at 12pm · esc to cancel',
  '',
].join('\n')

const LIMIT_PICKER = [
  '> run the scheduled check',
  '',
  RULE,
  '  You’ve hit your weekly limit · resets Oct 4, 12pm (UTC)',
  '',
  '  What do you want to do?',
  '',
  '  ❯ 1. Stop and wait for limit to reset',
  '    2. Upgrade your plan',
  '    3. Ask your admin for more usage',
  '',
  '  Enter to confirm · Esc to cancel',
  '',
].join('\n')

const MCP_MENU = [
  '  Manage MCP servers',
  '',
  '  ❯ 1. gmail · ✔ connected',
  '    2. calendar · ✘ failed',
  '',
  '  ↑/↓ to navigate · Enter to select · Esc to cancel',
  '',
].join('\n')

// An old limit message far up in the scrollback, with a normal idle footer.
const IDLE_WITH_OLD_LIMIT_TEXT = [
  '  ⎿  You’ve hit your weekly limit · resets 12pm (UTC)',
  ...Array.from({ length: 30 }, (_, i) => `  line ${i}`),
  RULE,
  '❯ ',
  RULE,
  '  ? for shortcuts',
  '',
].join('\n')

describe('detectsUsageLimitScreen', () => {
  it('reads the picker as the limit menu, with the reset time', () => {
    expect(detectsUsageLimitScreen(LIMIT_PICKER)).toEqual({ kind: 'menu', reset: 'Oct 4, 12pm (UTC)' })
  })

  it('reads the footer as the limit footer, with the reset time', () => {
    expect(detectsUsageLimitScreen(LIMIT_FOOTER)).toEqual({ kind: 'footer', reset: '12pm (UTC)' })
    expect(detectsUsageLimitScreen(LIMIT_FOOTER_BARE)).toEqual({ kind: 'footer', reset: '12pm' })
  })

  it('does not touch a real menu or an idle pane with old limit text', () => {
    expect(detectsUsageLimitScreen(MCP_MENU)).toBeNull()
    expect(detectsUsageLimitScreen(IDLE_WITH_OLD_LIMIT_TEXT)).toBeNull()
    expect(detectsUsageLimitScreen('')).toBeNull()
  })
})

describe('detectsBlockingMenu with the usage-limit screens', () => {
  it('the picker is still a blocking menu (Escape = stop and wait)', () => {
    expect(detectsBlockingMenu(LIMIT_PICKER)).toBe(true)
  })

  it('the footer is NEVER a menu: Escape there would cancel the automatic resume', () => {
    expect(detectsBlockingMenu(LIMIT_FOOTER)).toBe(false)
    expect(detectsBlockingMenu(LIMIT_FOOTER_BARE)).toBe(false)
  })

  it('a real menu (/mcp) is unchanged', () => {
    expect(detectsBlockingMenu(MCP_MENU)).toBe(true)
  })
})

describe('decideUsageLimitAlert', () => {
  const T0 = 1_790_000_000_000
  const menu = { kind: 'menu' as const, reset: 'Oct 4, 12pm (UTC)' }
  const footer = { kind: 'footer' as const, reset: 'Oct 4, 12pm (UTC)' }

  it('alerts once per episode, not on every reappearance', () => {
    const a = decideUsageLimitAlert(undefined, menu, T0)
    expect(a.alert).toBe(true)
    const b = decideUsageLimitAlert(a.next, footer, T0 + 60_000)
    expect(b.alert).toBe(false)
    const c = decideUsageLimitAlert(b.next, menu, T0 + 2 * 60 * 60 * 1000)
    expect(c.alert).toBe(false)
  })

  it('an unparsed reset inside the episode does not re-alert', () => {
    const a = decideUsageLimitAlert(undefined, menu, T0)
    const b = decideUsageLimitAlert(a.next, { kind: 'footer', reset: null }, T0 + 60_000)
    expect(b.alert).toBe(false)
  })

  it('keeps the episode across a short absence, ends it after the gap', () => {
    const a = decideUsageLimitAlert(undefined, menu, T0)
    const gone = decideUsageLimitAlert(a.next, null, T0 + 60_000)
    expect(gone.next).toBeDefined()
    const back = decideUsageLimitAlert(gone.next, menu, T0 + 120_000)
    expect(back.alert).toBe(false)
    const over = decideUsageLimitAlert(back.next, null, T0 + 120_000 + USAGE_LIMIT_EPISODE_GAP_MS + 1)
    expect(over.next).toBeUndefined()
  })

  it('next week, even with the same reset text, is a new episode', () => {
    const a = decideUsageLimitAlert(undefined, footer, T0)
    const week = decideUsageLimitAlert(a.next, footer, T0 + 7 * 24 * 60 * 60 * 1000)
    expect(week.alert).toBe(true)
  })

  it('a different reset time is a new episode', () => {
    const a = decideUsageLimitAlert(undefined, { kind: 'menu', reset: '3pm' }, T0)
    const b = decideUsageLimitAlert(a.next, menu, T0 + 60_000)
    expect(b.alert).toBe(true)
  })
})
