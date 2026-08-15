import { describe, it, expect } from 'vitest'
import {
  stripSessionTitleBanner,
  stripAllAnsi,
  detectPaneState,
} from '../pane-state.js'

const ESC = '\x1b'
// A full-width highlighted session-name bar line (fg 256-colour 16 on bg 256-colour 37),
// exactly how Claude Code renders a /rename banner at the bottom of the pane.
const banner = (text: string) => `${ESC}[38;5;16m${ESC}[48;5;37m ${text} ${ESC}[39m${ESC}[49m`

describe('stripAllAnsi', () => {
  it('removes every SGR/CSI code, keeps all visible characters', () => {
    expect(stripAllAnsi(`${ESC}[38;5;253mhello${ESC}[39m world`)).toBe('hello world')
    expect(stripAllAnsi(`${ESC}[2mdim${ESC}[22m kept`)).toBe('dim kept')
  })
  it('is byte-for-byte the plain text of a coloured capture', () => {
    const plain = 'line one\n  ❯ input\nbypass permissions on (shift+tab to cycle)'
    const coloured = `${ESC}[1mline one${ESC}[0m\n  ❯ input\n${ESC}[2mbypass permissions on (shift+tab to cycle)${ESC}[0m`
    expect(stripAllAnsi(coloured)).toBe(plain)
  })
})

describe('stripSessionTitleBanner', () => {
  it('removes a multi-line trailing rename banner, keeps content above', () => {
    const pane = [
      '· esc to interrupt',
      '',
      banner('MarveenSCHEDULED TASK NOTICE -- the next <scheduled-task'),
      banner('source="..."> block is one of YOUR OWN scheduled tasks.'),
      banner('[Heartbeat: msiw-sentinel-watch]  <scheduled-task'),
    ].join('\n')
    const out = stripSessionTitleBanner(pane)
    expect(out).toBe('· esc to interrupt\n')
    expect(out).not.toContain('scheduled-task')
  })

  it('is a no-op when there is no trailing background-filled banner', () => {
    const pane = '· esc to interrupt\n  ❯ \nbypass permissions on (shift+tab to cycle)'
    expect(stripSessionTitleBanner(pane)).toBe(pane)
  })

  it('does NOT treat a foreground 256-colour index of 7 as a background fill', () => {
    // 38;5;7 is a FOREGROUND colour; it must not be misread as SGR 7 (reverse video).
    const fgOnly = `${ESC}[38;5;7mplain foreground text${ESC}[39m`
    expect(stripSessionTitleBanner(`content\n${fgOnly}`)).toBe(`content\n${fgOnly}`)
  })
})

describe('detectPaneState with a rename banner (capturePane pipeline)', () => {
  // Reproduces the 2026-08-01 incident: a long rename banner pushes the live
  // busy signal out of the bottom region, so the raw pane reads 'unknown'.
  const busyLine = '✻ Working… (· esc to interrupt)'
  const bannerBlock = Array.from({ length: 8 }, (_, i) => banner(`renamed session name wrap line ${i}`)).join('\n')
  const coloured = `${busyLine}\n${bannerBlock}`

  it('raw (banner intact) misclassifies a busy pane as unknown', () => {
    expect(detectPaneState(stripAllAnsi(coloured))).toBe('unknown')
  })

  it('after stripping the banner the busy signal classifies correctly', () => {
    // This is exactly what capturePane now does: strip banner, then strip ANSI.
    const cleaned = stripAllAnsi(stripSessionTitleBanner(coloured))
    expect(detectPaneState(cleaned)).toBe('busy')
  })
})
