// String-contract guard for the agent modals surface (terminal, conversation,
// reauth). Guards the wiring that has NO functional test: module exports,
// router hook, DI injection, and the window-global bridge for agents.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP            = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
// Agent modals extracted to agent-modals.js in S-13d modularization.
const AGENT_MODALS   = readFileSync(join(__dirname, '../../web/modules/agent-modals.js'), 'utf-8')
// agents.js calls handleAgentLogin from event listeners -- verify its shape.
const AGENTS_MOD     = readFileSync(join(__dirname, '../../web/modules/agents.js'), 'utf-8')

describe('agent-modals UI wiring (S-13d)', () => {
  it('agent-modals.js exports the three public functions', () => {
    expect(AGENT_MODALS).toMatch(/export async function handleAgentLogin\(/)
    expect(AGENT_MODALS).toMatch(/export function openTerminalModal\(/)
    expect(AGENT_MODALS).toMatch(/export async function openConversationModal\(/)
    expect(AGENT_MODALS).toMatch(/export function initAgentModals\(/)
  })

  it('app.js imports openTerminalModal and openConversationModal from agent-modals.js', () => {
    expect(APP).toMatch(/import.*openTerminalModal.*openConversationModal.*from.*modules\/agent-modals\.js/)
  })

  it('app.js calls initAgentModals with openModal, closeModal and loadAgents', () => {
    expect(APP).toMatch(/initAgentModals\(\s*\{\s*openModal/)
    expect(APP).toContain('loadAgents')
  })

  it('terminal and conversation modal sections have been removed from app.js', () => {
    expect(APP).not.toContain('let terminalInstance')
    expect(APP).not.toContain('const CONVERSATION_PAGE_SIZE')
    expect(APP).not.toContain('async function handleAgentLogin(')
  })

  it('initAgentModals exposes handleAgentLogin as a window global for agents.js', () => {
    // agents.js calls handleAgentLogin without DI; bridge must be set in initAgentModals
    expect(AGENT_MODALS).toContain('window.handleAgentLogin = handleAgentLogin')
  })

  it('terminal input toggle enforces fail-closed: local gate checked before forwarding keys', () => {
    // terminalInputEnabled gate must fire before the keys fetch so we never
    // spam the audit log with 403s when input is off.
    const onDataIdx = AGENT_MODALS.indexOf('term.onData(')
    const gateIdx = AGENT_MODALS.indexOf('terminalInputEnabled', onDataIdx)
    const fetchIdx = AGENT_MODALS.indexOf("fetch(`/api/agents/", onDataIdx)
    expect(onDataIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(onDataIdx)
    expect(gateIdx).toBeLessThan(fetchIdx)
  })

  it('conversation renderer escapes entry text before injecting into innerHTML', () => {
    expect(AGENT_MODALS).toMatch(/escapeHtml\(.*\.text/)
  })
})
