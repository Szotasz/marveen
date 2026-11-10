import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unlockPaneInputIdle } from '../web/channel-plugin-unlock.js'

// Both new /reload-plugins senders (PR #2501 review) may only type into a pane
// PROVEN back at an empty idle prompt: typed into a parked draft the command is
// appended to it and Enter submits both; typed into a still-open /mcp menu
// level it lands in the menu.

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`
const pane = (input: string) => ['', SEP, input, SEP, FOOTER].join('\n')

const WEB = join(__dirname, '..', 'web')
const src = (f: string) => readFileSync(join(WEB, f), 'utf-8')

describe('unlockPaneInputIdle (confirmed-absent /reload-plugins guard)', () => {
  it('an empty idle prompt is idle', () => {
    expect(unlockPaneInputIdle(pane('❯ '))).toBe(true)
  })

  it('a DIM placeholder in an empty box is still idle', () => {
    expect(unlockPaneInputIdle(pane(`❯ ${DIM('Try refactor src/utils.ts to use the new API')}`))).toBe(true)
  })

  it('NEGATIVE CONTROL: real parked text is NOT idle', () => {
    expect(unlockPaneInputIdle(pane('❯ half-written draft for the owner'))).toBe(false)
  })

  it('a pane without the idle prompt (eg a menu still open) is NOT idle', () => {
    expect(unlockPaneInputIdle(['Manage MCP servers', '❯ plugin:google-workspace', '  Esc to go back'].join('\n'))).toBe(false)
  })

  it('an unreadable pane is NOT idle', () => {
    expect(unlockPaneInputIdle(null)).toBe(false)
  })
})

describe('the senders gate on the probe (source pins)', () => {
  it('channel-plugin-unlock: the confirmed-absent branch re-probes before typing, with a conditional second Escape', () => {
    const s = src('channel-plugin-unlock.ts')
    const i = s.indexOf("'/reload-plugins', 'Enter'")
    expect(i).toBeGreaterThan(0)
    const before = s.slice(s.lastIndexOf('RELOADPLUGINSABSENT1032', i), i)
    expect(before).toContain('let idle = unlockPaneInputIdle(captureColouredPane(session))')
    expect(before).toContain('if (!idle) {')
    expect(before).toContain("'Escape'")
    expect(before).toContain('idle = unlockPaneInputIdle(captureColouredPane(session))')
  })

  it('channel-monitor: the give-up /reload-plugins is sent only after mainInputBoxProvenEmpty, inside the send lane', () => {
    const s = src('channel-monitor.ts')
    const i = s.indexOf("'/reload-plugins', 'Enter'")
    expect(i).toBeGreaterThan(0)
    const before = s.slice(s.lastIndexOf('function sendGaveUpReloadIfIdle', i), i)
    expect(before).toContain("if (!mainInputBoxProvenEmpty(plain, dimStripped)) return 'not-idle'")
    expect(s).toContain("withSessionSendLock(MAIN_CHANNELS_SESSION, null, 'recover', async () => sendGaveUpReloadIfIdle())")
  })
})
