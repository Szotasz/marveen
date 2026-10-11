// The rows of GET /api/agents/input-state, built from injected I/O so the
// endpoint's contract is testable end-to-end without tmux/ssh: every agent
// (main + the agent list -- never a name list), a run state, a ghost-aware
// input state, and ONLY the length of a parked text (never the text).
import { classifyInputBox } from '../pane-state.js'

export type InputViews = { ghostless: string; withGhost: string } | null

export interface InputStateRow {
  name: string
  isMain: boolean
  host: string | null
  run: string
  input: string | null
  chars: number
}

export interface InputStateDeps {
  mainAgentId: string
  mainSession: string
  agents: string[]                                  // the agent list without main
  remoteHostOf: (name: string) => string | null
  runStateOf: (name: string, isRemote: boolean) => string
  sessionOf: (name: string) => string
  capture: (session: string, host: string | null, name: string | null) => InputViews
  sessionExists: (session: string) => boolean       // local: does the MAIN session exist
}

function describe(views: InputViews, running: boolean): { input: string | null; chars: number } {
  if (!running) return { input: null, chars: 0 }
  if (views == null) return { input: 'unreadable', chars: 0 }
  const c = classifyInputBox(views.ghostless, views.withGhost)
  return { input: c.state, chars: c.chars }
}

export function buildInputStateRows(d: InputStateDeps): InputStateRow[] {
  const rows: InputStateRow[] = []
  // a failed capture of a RUNNING main session is 'unreadable', not 'stopped' -- the session's existence decides
  const mainViews = d.capture(d.mainSession, null, null)
  const mainRunning = mainViews != null || d.sessionExists(d.mainSession)
  rows.push({ name: d.mainAgentId, isMain: true, host: null, run: mainRunning ? 'running' : 'stopped', ...describe(mainViews, mainRunning) })
  for (const name of d.agents) {
    const host = d.remoteHostOf(name)
    const run = d.runStateOf(name, host != null)
    const views = run === 'running' ? d.capture(d.sessionOf(name), host, name) : null
    rows.push({ name, isMain: false, host, run, ...describe(views, run === 'running') })
  }
  return rows
}
