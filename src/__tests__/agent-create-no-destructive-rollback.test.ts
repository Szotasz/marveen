import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Reported by a user, 2026-07-31. Their agent's card was on the dashboard,
// the terminal answered "Agent not found", and restarting could not help because
// there was nothing left to start.
//
// Cause: the POST /api/agents handler wrapped personality generation in a try
// whose catch ran
//     rmSync(agentDir(name), { recursive: true, force: true })
// so ANY failure of the LLM step -- timeout, missing auth, CLI error, network --
// deleted the whole agent directory that scaffoldAgentDir() had just built
// correctly. A slow generation became silent data loss.
//
// Worse, the team-notification loop sat INSIDE the same try, after the
// "Agent created successfully" log, so a failing greeting could delete a fully
// created agent too.
//
// These assertions are source-level, matching the idiom of
// main-restart-platform.test.ts. The handler is an HTTP route that awaits real
// Claude Code CLI calls and writes to the live agents directory; a runtime
// harness here would either mock the very thing under test or risk touching the
// real fleet. What must be guaranteed is a property of the code path, and that
// is what is asserted.

const SRC = join(import.meta.dirname, '..')
const FILE = 'web/routes/agents.ts'

function read(): string {
  return readFileSync(join(SRC, FILE), 'utf8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// The create handler: from the scaffold call to the success response.
function createHandlerBody(code: string): string {
  const start = code.indexOf('scaffoldAgentDir(name)')
  expect(start, 'scaffoldAgentDir call not found').toBeGreaterThan(-1)
  const end = code.indexOf("json(res, { ok: true, name })", start)
  expect(end, 'create-handler success response not found').toBeGreaterThan(-1)
  return code.slice(start, end)
}

describe('agent creation never deletes the agent directory on failure', () => {
  it('the create handler does not rmSync the agent dir', () => {
    // THE load-bearing assertion. On the pre-fix code this line existed
    // verbatim in the catch and this test goes red.
    const body = createHandlerBody(stripComments(read()))
    expect(body).not.toMatch(/rmSync\(\s*agentDir\(/)
  })

  it('the failure path writes fallback personality files instead', () => {
    const body = createHandlerBody(stripComments(read()))
    expect(body).toMatch(/fallbackClaudeMd\(/)
    expect(body).toMatch(/fallbackSoulMd\(/)
  })

  it('the failure path marks the personality as a placeholder', () => {
    // Without the sentinel a template silently becomes the agent's identity and
    // nobody ever learns the personality was never generated. The marker says the
    // personality IS a placeholder -- not that anything is coming to replace it,
    // because nothing reads this file.
    const body = createHandlerBody(stripComments(read()))
    expect(body).toMatch(/PERSONALITY_PENDING_SENTINEL/)
  })

  it('a failed generation still reports the agent as created, with a warning', () => {
    // The caller must not be told "creation failed" for an agent that exists and
    // works -- that is what drove the user to restart something that was fine.
    const body = createHandlerBody(stripComments(read()))
    expect(body).toMatch(/personalityPending:\s*true/)
  })

  it('team notification sits OUTSIDE the generation try/catch', () => {
    // It used to be inside, after the success log, so a failed greeting ran the
    // destructive catch. Assert ordering: the catch closes before the notify.
    const code = stripComments(read())
    const body = createHandlerBody(code)
    const catchIdx = body.indexOf('} catch (err) {')
    const notifyIdx = body.indexOf('createAgentMessage(')
    expect(catchIdx, 'generation catch not found').toBeGreaterThan(-1)
    expect(notifyIdx, 'notification call not found').toBeGreaterThan(-1)
    expect(notifyIdx, 'notification must come after the generation catch block')
      .toBeGreaterThan(catchIdx)
    // ...and it must have its own guard, so a notify failure cannot bubble.
    const afterCatch = body.slice(catchIdx)
    expect(afterCatch).toMatch(/try\s*\{[\s\S]*createAgentMessage\([\s\S]*?\}\s*catch/)
  })
})
