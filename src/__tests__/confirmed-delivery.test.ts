import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Tier-1 contract tests for confirmed inter-agent delivery.
//
// Root cause: the message router marked a message "delivered" the instant
// send-keys returned, but the Claude TUI occasionally swallows the closing
// Enter, leaving the prompt parked in the input box. That booked a silent-lie
// "delivered" while the target never saw the message. The fix makes
// sendPromptToSession report whether the submit was CONFIRMED and gates the
// router's bookkeeping on it: confirmed -> delivered; unconfirmed -> failed +
// escalate to the owner via the main agent (never vanish silently).

const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
const MESSAGE_ROUTER = readFileSync(join(__dirname, '../web/message-router.ts'), 'utf-8')

describe('sendPromptToSession confirmed-submit signal', () => {
  it('returns a boolean (submit-confirmed) instead of void', () => {
    const sigIdx = AGENT_PROCESS.indexOf('export function sendPromptToSession(')
    expect(sigIdx).toBeGreaterThan(0)
    // The closing of the signature must declare a boolean return type.
    const sig = AGENT_PROCESS.slice(sigIdx, sigIdx + 320)
    expect(sig).toMatch(/\}\s*=\s*\{\},\s*\)\s*:\s*boolean\s*\{/)
  })

  it("confirms only on decideSubmitFollowup === 'done' and returns that flag", () => {
    expect(AGENT_PROCESS).toMatch(/let submitted = false/)
    // 'done' is the only path that flips submitted true.
    expect(AGENT_PROCESS).toMatch(/if \(action === 'done'\) \{ submitted = true; break \}/)
    // The give-up path must NOT set submitted true (stays false -> unconfirmed).
    const giveUp = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf("if (action === 'give-up')"), AGENT_PROCESS.indexOf("if (action === 'give-up')") + 160)
    expect(giveUp).not.toMatch(/submitted = true/)
    // And the function returns the flag.
    expect(AGENT_PROCESS).toMatch(/\n  return submitted\n\}/)
  })
})

describe('message-router gates delivery on confirmed submit', () => {
  it('captures the sendPromptToSession return value', () => {
    expect(MESSAGE_ROUTER).toMatch(/const submitted = sendPromptToSession\(session, prefix \+ wrapped, host\)/)
  })

  it('marks delivered ONLY inside the submitted branch', () => {
    // markMessageDelivered must sit under `if (submitted)`.
    const ifIdx = MESSAGE_ROUTER.indexOf('if (submitted) {')
    expect(ifIdx).toBeGreaterThan(0)
    const elseIdx = MESSAGE_ROUTER.indexOf('} else {', ifIdx)
    expect(elseIdx).toBeGreaterThan(ifIdx)
    const submittedBranch = MESSAGE_ROUTER.slice(ifIdx, elseIdx)
    expect(submittedBranch).toMatch(/markMessageDelivered\(msg\.id\)/)
    // markMessageDelivered must NOT appear in the unconfirmed (else) branch.
    const afterElse = MESSAGE_ROUTER.slice(elseIdx, elseIdx + 2200)
    expect(afterElse).not.toMatch(/markMessageDelivered/)
  })

  it('on unconfirmed submit: marks failed and does not claim delivery', () => {
    const elseIdx = MESSAGE_ROUTER.indexOf('} else {', MESSAGE_ROUTER.indexOf('if (submitted) {'))
    const branch = MESSAGE_ROUTER.slice(elseIdx, elseIdx + 2200)
    expect(branch).toMatch(/markMessageFailed\(msg\.id, 'Submit unconfirmed/)
    expect(branch).toMatch(/logger\.error\(/)
  })

  it('escalates to the owner via the main agent, guarded against alert->alert recursion', () => {
    const elseIdx = MESSAGE_ROUTER.indexOf('} else {', MESSAGE_ROUTER.indexOf('if (submitted) {'))
    const branch = MESSAGE_ROUTER.slice(elseIdx, elseIdx + 2200)
    // Recursion guard: only escalate when the stranded message was NOT itself
    // bound for the main agent (the alert is delivered to MAIN_AGENT_ID).
    expect(branch).toMatch(/if \(msg\.to_agent !== MAIN_AGENT_ID\)/)
    expect(branch).toMatch(/createAgentMessage\(\s*'message-router',\s*MAIN_AGENT_ID,/)
  })

  it('imports createAgentMessage from db', () => {
    expect(MESSAGE_ROUTER).toMatch(/import \{[\s\S]*createAgentMessage[\s\S]*\} from '\.\.\/db\.js'/)
  })
})
