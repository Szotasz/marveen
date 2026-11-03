import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { permissionPromptSummary } from '../pane-state.js'
import { formatStuckSessionAlert, formatUrgentHoldNotice } from '../web/message-router.js'
import { formatPermissionPromptMainAlert } from '../web/permission-prompt-escalation.js'
import { permissionPromptAsk } from '../web/permission-prompt-alert.js'

// ESZKALTOKEN1019: permissionPromptSummary() feeds three inter-agent messages
// (the urgent-held notice, the stuck-session alert, the permission-prompt
// escalation). On a Bash card WITHOUT a reason block, the last quoted block
// before the question is the command echo, and it used to come back as the
// "reason" -- so the command line, a token in argv included, went into
// agent_messages. The summary must never return the command line.
//
// The panes below are the live captures from fixtures/pane with a token put
// into the command, then with the reason block (and the description line)
// taken out: exactly the card shape that leaked.
const load = (n: string) => readFileSync(join(__dirname, `fixtures/pane/${n}.txt`), 'utf8')
// A marker, not a secret shape (the repo's secret gate rightly refuses those in a fixture).
const TOKEN = 'PROBE-ARGV-TOKEN-ESZKALTOKEN1019'
const withToken = (pane: string) => pane.replace('ls Example/Resources', `curl -H "x-api-key: ${TOKEN}"`)

const CD = withToken(load('permission-prompt-compound-cd'))
const UPPER = withToken(load('permission-prompt-upper-half'))
const REASON_RX = /\n\n │ Compound command contains cd with a relative file read while a Read\(\) deny\n │ rule exists\n/

const noReason = (pane: string) => pane.replace(REASON_RX, '\n')
const noReasonNoDescription = (pane: string) => noReason(pane).replace(/\n {3}Check localization files\n/, '\n')
// card shapes we have not seen: the reason block nested as deep as the command,
// and the command echo at the card's own indent, still followed by its description
const reasonNested = (pane: string) => pane.replace(/\n │ /g, '\n   │ ')
const commandAtCardIndent = (pane: string) => noReason(pane).replace(/\n {3}│ /g, '\n │ ')

// Every outgoing text the summary is quoted into, for one pane.
function outgoing(pane: string): string[] {
  const ask = permissionPromptSummary(pane)
  return [
    formatStuckSessionAlert('worker', 'marveen', 'agent-worker', 11 * 60 * 1000, 1, 'unknown', true, ask) ?? '',
    formatUrgentHoldNotice({ id: 7, from_agent: 'marveen', to_agent: 'worker' }, 'agent-worker', { kind: 'permission-prompt', ask }, 'worker'),
    formatPermissionPromptMainAlert('worker', 'agent-worker', permissionPromptAsk(pane), 15 * 60 * 1000),
  ]
}

describe('the fixtures carry the token in the command, and the cuts apply', () => {
  it('token in, reason block and description line removable', () => {
    for (const p of [CD, UPPER]) {
      expect(p).toContain(TOKEN)
      expect(noReason(p)).not.toContain('Compound command contains cd')
      expect(noReason(p)).toContain('Check localization files')
      expect(noReasonNoDescription(p)).not.toContain('Check localization files')
      expect(noReasonNoDescription(p)).toContain(TOKEN)
      expect(reasonNested(p)).toContain('   │ Compound command contains cd')
      expect(commandAtCardIndent(p)).toContain(' │ cd /Users/')
      expect(commandAtCardIndent(p)).not.toContain('   │ ')
    }
  })
})

describe('positive control: a card WITH its reason block still quotes the reason, never the command', () => {
  it.each([['compound-cd', CD], ['upper-half', UPPER]])('%s', (_n, pane) => {
    const s = permissionPromptSummary(pane)!
    expect(s.title).toBe('Bash command · from the general-purpose agent')
    expect(s.reason).toBe('Compound command contains cd with a relative file read while a Read() deny rule exists')
    for (const text of outgoing(pane)) {
      expect(text).toContain('Compound command contains cd')
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('localization')
    }
  })
})

describe('negative control: a card WITHOUT a reason block never puts the command into a message', () => {
  const cases: Array<[string, string]> = [
    ['no reason block (description line stays)', noReason(CD)],
    ['no reason block, upper-half shape', noReason(UPPER)],
    ['no reason block and no description line', noReasonNoDescription(CD)],
    ['no reason block and no description line, upper-half', noReasonNoDescription(UPPER)],
    ['unseen shape: reason nested as deep as the command', reasonNested(CD)],
    ['unseen shape: command echo at the card indent, followed by its description', commandAtCardIndent(CD)],
  ]
  it.each(cases)('%s', (_n, pane) => {
    expect(permissionPromptSummary(pane)).toBeNull()
    for (const text of outgoing(pane)) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('x-api-key')
      expect(text).not.toContain('example-wt')
      // the message itself still goes out: the prompt is reported, only unquoted
      expect(text).toContain('TOOL-PERMISSION PROMPT')
    }
  })
})
