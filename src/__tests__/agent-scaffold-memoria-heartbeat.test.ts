// Contract guard: per-agent memoria-heartbeat scaffolding is removed.
//
// The fleet now uses a single central sweep orchestrator
// (memoria-heartbeat-fleet) that discovers agents dynamically via /api/agents.
// New agents no longer need a dedicated scheduled task created at scaffold time.
// These tests ensure the removed code does not re-appear.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD = readFileSync(join(__dirname, '../../src/web/agent-scaffold.ts'), 'utf-8')
const AGENTS_CRUD = readFileSync(join(__dirname, '../../src/web/routes/agents-crud.ts'), 'utf-8')

describe('per-agent heartbeat scaffold removed (sweep model)', () => {
  it('agent-scaffold.ts does not export scaffoldAgentMemoriaHeartbeat', () => {
    expect(SCAFFOLD).not.toContain('scaffoldAgentMemoriaHeartbeat')
  })

  it('agent-scaffold.ts does not contain heartbeatMinuteFor', () => {
    expect(SCAFFOLD).not.toContain('heartbeatMinuteFor')
  })

  it('agents-crud.ts does not call scaffoldAgentMemoriaHeartbeat', () => {
    expect(AGENTS_CRUD).not.toContain('scaffoldAgentMemoriaHeartbeat')
  })

  it('agents-crud.ts does not import scaffoldAgentMemoriaHeartbeat', () => {
    expect(AGENTS_CRUD).not.toContain('scaffoldAgentMemoriaHeartbeat')
  })
})
