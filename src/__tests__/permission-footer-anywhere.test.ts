import { describe, it, expect } from 'vitest'
import { detectsBlockingMenu, detectsPermissionDialog } from '../pane-state.js'

// A prompt high on the screen was invisible to BOTH probes.
//
// Every footer probe counted its window back from the last LINE of the
// capture. A fresh session whose first tool call needs consent draws the
// prompt in the upper half and leaves the rest of the pane empty, so the
// footer fell outside the window and nothing matched: no menu, no permission
// prompt, pane state `unknown`. The monitor then did neither of the things it
// exists for -- no alert, no recovery. It just sat there.
//
// Measured on the shipped code (2026-09-06), live prompt with an 18-line
// blank tail: detectsBlockingMenu=false, detectsPermissionDialog=false.
// After the change: both true, which routes the pane to the permission branch
// in channel-monitor -- alert the owner, send NO keystroke.

const BLANK_TAIL = '\n'.repeat(18)

/** A live consent prompt drawn high, with an empty tail below it. */
const UPPER_HALF_PROMPT = [
  '  Reading the sprint notes before the merge.',
  '',
  '────────────────────────────────────────────────────────────────',
  ' Edit file · from the general-purpose agent',
  '',
  '   │ ~/.claude/skills/deploy/SKILL.md',
  '   Update the rollback step',
  '',
  ' │ Claude wants to edit its own configuration',
  '',
  ' Do you want to make this edit?',
  ' ❯ Yes, allow this edit',
  '   Yes, and allow edits to this file for this session',
  '   No, tell Claude what to do differently',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n') + BLANK_TAIL

/** The same prompt ANSWERED long ago: the work continued, and the footer is
 * far above the last thing drawn. */
const ANSWERED_AND_SCROLLED_AWAY = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel · Tab to amend',
  '',
  ...Array.from({ length: 20 }, (_, i) => `  step ${i + 1}: editing src/file${i}.ts`),
  '  Done. Three call sites updated.',
].join('\n')

describe('a prompt with a blank tail below it', () => {
  it('is seen as a blocking menu', () => {
    expect(detectsBlockingMenu(UPPER_HALF_PROMPT)).toBe(true)
  })

  it('is seen as a permission prompt', () => {
    // Both matter, and in this order: the monitor only asks the second
    // question about a pane the first one flagged. Either half false and the
    // prompt stays invisible.
    expect(detectsPermissionDialog(UPPER_HALF_PROMPT)).toBe(true)
  })
})

describe('an answered prompt that scrolled away', () => {
  it('is not a blocking menu, so the monitor never acts on it', () => {
    expect(detectsBlockingMenu(ANSWERED_AND_SCROLLED_AWAY)).toBe(false)
  })

  // Deliberately NOT asserting that detectsPermissionDialog is false here.
  //
  // It returns true -- its question+Yes branch searches the whole pane -- and
  // that IS imprecise. It was measured and left alone on purpose. The only
  // caller reaches this probe exclusively for panes that detectsBlockingMenu
  // already flagged, which the case above shows this pane is not; and on that
  // branch the cost of the two errors is wildly asymmetric. A false positive
  // means the owner gets an alert instead of a blind Escape. A false negative
  // means the monitor presses Escape on a live consent prompt, which is NO --
  // denying the agent's own request while the owner believes they approved it.
  // That is the regression PERMDENY905 fixed. Tightening this branch would buy
  // precision nobody can observe at the risk of re-opening it.
})
