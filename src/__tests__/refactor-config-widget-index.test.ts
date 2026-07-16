/**
 * Tests for the marveen-kisebb-refaktor changes:
 *   1. OWNER_NAME default is distribution-safe ('Owner', not a personal name)
 *   2. The dead agentActivityWidget is removed from the dashboard HTML
 *   3. The broken 'schedule' npm script is removed from package.json
 *   4. The composite index idx_agent_messages_thread is created on agent_messages
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb } from '../db.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// 1. OWNER_NAME default
// ---------------------------------------------------------------------------
describe('OWNER_NAME default value', () => {
  it('does not fall back to a personal name', () => {
    // Read the raw source to catch the literal default without side-effecting
    // the running config (which may have OWNER_NAME set in the environment).
    const src = readFileSync(join(REPO_ROOT, 'src', 'config.ts'), 'utf8')
    const match = src.match(/OWNER_NAME\s*=\s*env\['OWNER_NAME'\]\s*\?\?\s*'([^']+)'/)
    expect(match, 'OWNER_NAME ?? fallback not found in config.ts').toBeTruthy()
    const defaultValue = match![1]
    expect(defaultValue).toBe('Owner')
    // Explicitly reject the old hardcoded personal name so a revert is caught.
    expect(defaultValue).not.toBe('Szabolcs')
  })
})

// ---------------------------------------------------------------------------
// 2. agentActivityWidget removal
// ---------------------------------------------------------------------------
describe('agentActivityWidget removal', () => {
  it('is absent from index.html', () => {
    const html = readFileSync(join(REPO_ROOT, 'web', 'index.html'), 'utf8')
    expect(html).not.toContain('agentActivityWidget')
  })

  it('overview.card.agent_activity i18n key is absent from app.js', () => {
    const js = readFileSync(join(REPO_ROOT, 'web', 'app.js'), 'utf8')
    expect(js).not.toContain('overview.card.agent_activity')
    expect(js).not.toContain('overview.meta.messages')
  })

  it('orphaned i18n keys are removed from en.js lang file', () => {
    const en = readFileSync(join(REPO_ROOT, 'web', 'lang', 'en.js'), 'utf8')
    expect(en).not.toContain('overview.card.agent_activity')
    expect(en).not.toContain('overview.meta.messages')
  })

  it('orphaned i18n keys are removed from hu.js lang file', () => {
    const hu = readFileSync(join(REPO_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
    expect(hu).not.toContain('overview.card.agent_activity')
    expect(hu).not.toContain('overview.meta.messages')
  })
})

// ---------------------------------------------------------------------------
// 3. Broken 'schedule' npm script removal
// ---------------------------------------------------------------------------
describe('package.json scripts', () => {
  it('does not contain the broken schedule entry', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts).not.toHaveProperty('schedule')
  })

  it('still contains the core scripts that must remain', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    for (const name of ['build', 'start', 'dev', 'test', 'typecheck']) {
      expect(pkg.scripts, `"${name}" script must remain`).toHaveProperty(name)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. agent_messages composite index
// ---------------------------------------------------------------------------
describe('agent_messages composite index', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('idx_agent_messages_thread index exists on the agent_messages table', () => {
    const db = getDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_messages'")
      .all() as Array<{ name: string }>
    const names = indexes.map(r => r.name)
    expect(names).toContain('idx_agent_messages_thread')
  })

  it('idx_agent_messages_thread covers from_agent, to_agent, created_at columns', () => {
    const db = getDb()
    const info = db
      .prepare("PRAGMA index_info('idx_agent_messages_thread')")
      .all() as Array<{ seqno: number; cid: number; name: string }>
    const cols = info.map(r => r.name)
    expect(cols).toContain('from_agent')
    expect(cols).toContain('to_agent')
    expect(cols).toContain('created_at')
    // from_agent must be the leading column for maximum benefit on from_agent= queries.
    expect(cols[0]).toBe('from_agent')
  })

  it('the original status index is still present', () => {
    const db = getDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_messages'")
      .all() as Array<{ name: string }>
    const names = indexes.map(r => r.name)
    expect(names).toContain('idx_agent_messages_status')
  })
})
