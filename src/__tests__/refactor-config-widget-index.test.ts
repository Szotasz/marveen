/**
 * Tests for the dead-code cleanup changes:
 *   1. OWNER_NAME default is distribution-safe ('Owner', not a personal name)
 *   2. The dead agentActivityWidget is removed from the dashboard HTML
 *   3. The broken 'schedule' npm script is removed from package.json
 *   4. The composite index idx_agent_messages_thread is created on agent_messages
 *   5. Unused TS exports (cosineSimilarity, vectorSearch) are unexported
 *   6. Orphaned i18n keys are removed from lang files
 *   7. Dead HTML element IDs are removed from index.html
 *   8. Legacy vault_ssh_servers columns are dropped
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
    // The default is routed through the exported OWNER_NAME_PLACEHOLDER const
    // (the federation scrubber needs to recognise it), so assert both the
    // placeholder literal and the wiring.
    const src = readFileSync(join(REPO_ROOT, 'src', 'config.ts'), 'utf8')
    const placeholderMatch = src.match(/OWNER_NAME_PLACEHOLDER\s*=\s*'([^']+)'/)
    expect(placeholderMatch, 'OWNER_NAME_PLACEHOLDER literal not found in config.ts').toBeTruthy()
    const defaultValue = placeholderMatch![1]
    expect(defaultValue).toBe('Owner')
    // Explicitly reject the old hardcoded personal name so a revert is caught.
    expect(defaultValue).not.toBe('Szabolcs')
    expect(src).toMatch(/OWNER_NAME\s*=\s*env\['OWNER_NAME'\]\s*\?\?\s*OWNER_NAME_PLACEHOLDER/)
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
// 5. Unused exports unexported
// ---------------------------------------------------------------------------
describe('cosineSimilarity and vectorSearch are not exported from db.ts', () => {
  it('cosineSimilarity is not an exported symbol', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'db.ts'), 'utf8')
    // Must be defined (function exists) but NOT exported.
    expect(src).toContain('function cosineSimilarity(')
    expect(src).not.toMatch(/export\s+function\s+cosineSimilarity/)
  })

  it('vectorSearch is not an exported symbol', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'db.ts'), 'utf8')
    expect(src).toContain('function vectorSearch(')
    expect(src).not.toMatch(/export\s+function\s+vectorSearch/)
  })
})

// ---------------------------------------------------------------------------
// 6. Orphaned i18n keys
// ---------------------------------------------------------------------------
describe('orphaned i18n keys removed from lang files', () => {
  const DEAD_KEYS = [
    'agents.btn.new',
    'agents.btn.model_analysis',
    'agents.card.start',
    'agents.card.stop',
    'agents.card.starting',
    'agents.card.stopping',
    'agents.toast.start_error',
    'agents.toast.stop_error',
    'agents.toast.save_error',
    'agents.toast.model_active',
    'agents.toast.restarted',
    'agents.toast.error_msg',
    'agents.status.connected',
    'agents.status.disconnected',
    'agents.status.restarting',
    'agents.load_error',
    'agents.not_found',
    'agents.channel.conversation',
    'agents.model.cards_done',
    'activity.no_output',
    'activity.session_stopped',
    'autonomy.btn.refresh',
    'autonomy.level.1',
    'updates.page_subtitle',
  ]

  for (const lang of ['en', 'hu']) {
    it(`${lang}.js does not contain any orphaned key`, () => {
      const content = readFileSync(join(REPO_ROOT, 'web', 'lang', `${lang}.js`), 'utf8')
      const found = DEAD_KEYS.filter(k => content.includes(`'${k}'`))
      expect(found, `found orphaned keys in ${lang}.js: ${found.join(', ')}`).toHaveLength(0)
    })
  }
})

// ---------------------------------------------------------------------------
// 7. Dead HTML element IDs
// ---------------------------------------------------------------------------
describe('dead HTML element IDs removed from index.html', () => {
  const DEAD_IDS = [
    'sidebarBrandSub',
    'updatesNavLink',
    'kanbanViewSwitcher',
    'ganttPeriodWeek',
    'ganttPeriodMonth',
    'ganttPeriodQuarter',
    'vaultStatEncryption',
    'vaultStatStorage',
    'tokenUsageSubtitle',
    'tuTimelineChart',
    'processStatus',
    'voiceConfigGroup',
  ]

  it('none of the dead IDs appear in index.html', () => {
    const html = readFileSync(join(REPO_ROOT, 'web', 'index.html'), 'utf8')
    const found = DEAD_IDS.filter(id => html.includes(`id="${id}"`))
    expect(found, `dead IDs still present in index.html: ${found.join(', ')}`).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 8. vault_ssh_servers legacy columns
// ---------------------------------------------------------------------------
describe('vault_ssh_servers legacy columns', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('does not contain the legacy key columns', () => {
    const db = getDb()
    const cols = (db.prepare("PRAGMA table_info('vault_ssh_servers')").all() as Array<{ name: string }>)
      .map(r => r.name)
    for (const dead of ['key_type', 'fingerprint', 'vault_key_id', 'key_expires_at']) {
      expect(cols, `legacy column ${dead} should be absent`).not.toContain(dead)
    }
  })

  it('still has the active columns', () => {
    const db = getDb()
    const cols = (db.prepare("PRAGMA table_info('vault_ssh_servers')").all() as Array<{ name: string }>)
      .map(r => r.name)
    for (const active of ['id', 'name', 'host', 'port', 'username', 'ssh_key_id', 'description', 'created_at', 'updated_at']) {
      expect(cols, `active column ${active} must be present`).toContain(active)
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
