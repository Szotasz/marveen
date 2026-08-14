import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Reported by a user, 2026-08-01. They deleted a RUNNING agent from the
// dashboard; its card vanished from /api/agents, but minutes later the agent
// "returned" as an empty draft (CLAUDE.md and SOUL.md both empty) that still
// showed running=true, with the model reset to the default.
//
// Cause: the DELETE /api/agents/:name handler removed the agent directory
// (rmSync) and cleaned team references, but never stopped the running tmux
// session. The orphaned session survived the delete, and -- because a live
// Claude Code session rewrites its own config dir -- it recreated a minimal
// .claude-config under agents/<name>/. That partial dir made the name "known"
// again: no persona files -> draft, live session -> running=true, and the model
// fell back to the default because the real agent-config.json was gone.
//
// Fix: stop the session BEFORE removing the dir. stopAgentProcess() reads config
// from the dir (remote host, channel provider) for its orphan reap, so the order
// matters -- stop while the dir still exists, then rmSync.
//
// Source-level assertions, matching the idiom of
// agent-create-no-destructive-rollback.test.ts: the handler is an HTTP route that
// drives tmux and touches the live agents directory, so a runtime harness would
// either mock the very thing under test or risk killing a real fleet session.
// What must be guaranteed is a property of the code path, and that is asserted.

const SRC = join(import.meta.dirname, '..')
const FILE = 'web/routes/agents.ts'

function read(): string {
  return readFileSync(join(SRC, FILE), 'utf8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// The DELETE handler body: from the method match to just past its success path.
function deleteHandlerBody(code: string): string {
  const start = code.indexOf("agentMatch && method === 'DELETE'")
  expect(start, 'DELETE agent handler not found').toBeGreaterThan(-1)
  const teamIdx = code.indexOf('cleanupTeamReferences(name)', start)
  expect(teamIdx, 'cleanupTeamReferences not found in DELETE handler').toBeGreaterThan(start)
  const end = code.indexOf('return true', teamIdx)
  expect(end, 'DELETE handler end not found').toBeGreaterThan(teamIdx)
  return code.slice(start, end)
}

describe('deleting an agent stops its running session (no orphan ghost)', () => {
  it('the delete handler stops the session before removing the dir', () => {
    const body = deleteHandlerBody(stripComments(read()))
    const stopIdx = body.indexOf('stopAgentProcess(')
    const rmIdx = body.indexOf('rmSync(')
    // THE load-bearing assertion. On the pre-fix code stopAgentProcess is absent
    // from the handler and this goes red.
    expect(stopIdx, 'DELETE handler must call stopAgentProcess').toBeGreaterThan(-1)
    expect(rmIdx, 'DELETE handler must rmSync the dir').toBeGreaterThan(-1)
    // Order matters: stopAgentProcess reads config from the dir, so it must run
    // BEFORE rmSync removes it.
    expect(stopIdx, 'stopAgentProcess must run before rmSync').toBeLessThan(rmIdx)
  })

  it('the stop is guarded by isAgentRunning', () => {
    const body = deleteHandlerBody(stripComments(read()))
    expect(body).toMatch(/isAgentRunning\(/)
  })
})
