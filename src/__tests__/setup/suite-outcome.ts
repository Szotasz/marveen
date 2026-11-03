// Exit-code contract for the scripts/__tests__ suites, in a module of its own.
//
// It lives OUTSIDE script-tests-runner.test.ts on purpose: importing a test
// file executes its tests, so a second file importing the classifier from
// there would run every shell and python suite a second time (measured:
// 95s and 70 extra test cases for two assertions).
//
// WAITFORSKIP925: 77 is SKIP, the autotools convention, and it is separate
// from 0 deliberately. "Could not measure here" and "measured, all good" are
// different answers; collapsing them is how a positive control quietly stops
// being a control. The instrument codes (1, 2) stay failures.
export const SKIP_EXIT = 77

export function suiteOutcome(status: number | null): 'pass' | 'skip' | 'fail' {
  if (status === 0) return 'pass'
  if (status === SKIP_EXIT) return 'skip'
  return 'fail'
}

// A bare 77 is not a skip: the suite must say WHY, on a line of its own that starts with the
// marker. Anchored on purpose: suites print "SKIP" incidentally (a skipped case, a FAIL line
// naming a SEED_SKIP variable; the maintainer counted 16 such suites), and an unanchored /SKIP/
// let an exit 77 carrying only such a line pass as a skip.
export const SKIP_REASON = /^SKIP \(control unmet\)/m

export function hasSkipReason(output: string): boolean {
  return SKIP_REASON.test(output)
}
