import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'desired-state-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

import {
  getDesiredAgents,
  addDesiredAgent,
  removeDesiredAgent,
} from '../web/agent-desired-state.js'

const DESIRED_FILE = join(STORE_DIR, 'agents-desired.json')

function cleanFile(): void {
  if (existsSync(DESIRED_FILE)) unlinkSync(DESIRED_FILE)
}

beforeEach(cleanFile)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('getDesiredAgents', () => {
  it('returns empty Set when no file exists', () => {
    expect(getDesiredAgents().size).toBe(0)
  })

  it('returns empty Set when file contains invalid JSON', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(DESIRED_FILE, '{bad}')
    expect(getDesiredAgents().size).toBe(0)
  })

  it('returns empty Set when file contains non-array JSON', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(DESIRED_FILE, '{"key":"val"}')
    expect(getDesiredAgents().size).toBe(0)
  })
})

describe('addDesiredAgent', () => {
  it('creates the file and adds the agent', () => {
    addDesiredAgent('agent-a')
    const set = getDesiredAgents()
    expect(set.has('agent-a')).toBe(true)
  })

  it('is idempotent -- adding twice does not duplicate', () => {
    addDesiredAgent('agent-a')
    addDesiredAgent('agent-a')
    expect(getDesiredAgents().size).toBe(1)
  })

  it('accumulates multiple agents', () => {
    addDesiredAgent('agent-a')
    addDesiredAgent('agent-d')
    const set = getDesiredAgents()
    expect(set.has('agent-a')).toBe(true)
    expect(set.has('agent-d')).toBe(true)
  })
})

describe('removeDesiredAgent', () => {
  it('removes an existing agent', () => {
    addDesiredAgent('agent-a')
    removeDesiredAgent('agent-a')
    expect(getDesiredAgents().has('agent-a')).toBe(false)
  })

  it('is idempotent -- removing a non-present agent does not throw', () => {
    expect(() => removeDesiredAgent('nonexistent')).not.toThrow()
  })

  it('does not remove other agents', () => {
    addDesiredAgent('agent-a')
    addDesiredAgent('agent-d')
    removeDesiredAgent('agent-a')
    const set = getDesiredAgents()
    expect(set.has('agent-a')).toBe(false)
    expect(set.has('agent-d')).toBe(true)
  })
})
