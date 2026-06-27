import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  stuckInputSignature,
  parkedInputRowCount,
  parkedInputText,
  decideStuckInputAction,
} from '../pane-state.js'

// End-to-end regression guard for the REAL production wedge (2026-06-26):
// a delivered multi-row inter-agent message parked in a Claude Code v2.1.170
// fresh-session WELCOME screen (logo + model + cwd, box between two rule lines,
// no idle footer). Before the P1 fix, liveInputBox anchored on the idle footer,
// so detectPaneState returned 'unknown' and the whole recovery stack was blind
// -> the agent stayed wedged until a manual restart. This fixture is the actual
// captured qwen pane. Live validation confirmed a single Enter submits it once
// detected; the ladder uses the more robust reinject-plain for a sub-agent.
const QWEN_WELCOME_WEDGE = `
 ▐▛███▜▌   Claude Code v2.1.170
▝▜█████▛▘  qwen3.6:27b-192k with high effort · API Usage Billing
  ▘▘ ▝▝    ~/ClaudeClaw/agents/qwen










────────────────────────────────────────────────────────────────────────────────
❯ kepet: /Users/marvin/ClaudeClaw/workspace/mbh-issue/aahe486-screenshot.png
  Olvasd be a Read tool-lal a kepfajlt, majd mondd meg: (1) mi ez az
  alkalmazas/oldal, (2) a tablazat konkret ertekei -- rendszam, tipus,
  letrehozas+modositas datumok, hany sor. Roviden a vegeredmenyt (ne
  gondolkodj sokat). Ez egy kepesseg-teszt rolad (qwen3.6 lokal modell),
  szoval csak old meg ahogy tudod, es a valaszod visszajelzem Szabinak.
  </trusted-peer>
────────────────────────────────────────────────────────────────────────────────

`

describe('welcome-screen wedge: detection -> recovery decision (real fixture)', () => {
  it('P1 detection sees the footer-less welcome-screen parked input', () => {
    expect(detectPaneState(QWEN_WELCOME_WEDGE)).toBe('typing')
    expect(stuckInputSignature(QWEN_WELCOME_WEDGE)).not.toBeNull()
    expect(parkedInputText(QWEN_WELCOME_WEDGE)).not.toBeNull()
    expect(parkedInputRowCount(QWEN_WELCOME_WEDGE)).toBeGreaterThan(1)
  })

  it('recovery decides reinject-plain for the multi-row sub-agent message (not hold/bare-Enter)', () => {
    const action = decideStuckInputAction({
      escalate: false,
      rowCount: parkedInputRowCount(QWEN_WELCOME_WEDGE),
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: true, // sub-agent box: no human draft
      hasPlainText: parkedInputText(QWEN_WELCOME_WEDGE) != null,
    })
    expect(action).toBe('reinject-plain')
  })
})
