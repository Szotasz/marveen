// GLOBAL SUITE SEAM: no test writes a scheduled-run snapshot into the checkout's store/.
//
// NUDGESHORT1031: every LOCAL scheduled fire writes the whole prompt to a
// snapshot under store/scheduled-runs/ and types only a pointer to it. Every
// test that drives the real tick therefore wrote there -- measured on the first
// full run of the change: 49 files from 36 fixture tasks in one worktree's store.
// A per-file vi.mock covered the eight files that existed when it was written
// and missed the ones that came after, so it lives here, where a new tick test
// is covered without anyone remembering it (the reasoning of
// default-ssh-dir-seam.ts).
//
// A test file that mocks '../web/scheduled-run-snapshot.js' itself keeps its own
// mock. Explicit `dir` arguments are respected, so scheduled-run-snapshot.test.ts
// still measures its own tmp dirs.
import { vi } from 'vitest'

vi.mock('../../web/scheduled-run-snapshot.js', async (importOriginal) =>
  (await import('../helpers/scheduled-runs-tmp.js')).redirectScheduledRuns(await importOriginal()))
