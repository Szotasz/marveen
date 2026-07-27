import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'profiles-test-'))
  mkdirSync(join(root, 'templates', 'profiles'), { recursive: true })
  return { TMP_ROOT: root }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR: join(TMP_ROOT, 'store'),
  MAIN_AGENT_ID: 'marveen',
}))

import {
  listProfileTemplates, loadProfileTemplate, resolveProfilePlaceholders,
  HARDCODED_DEFAULT_PROFILE,
} from '../web/profiles.js'

const PROFILES_DIR = join(TMP_ROOT, 'templates', 'profiles')

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('listProfileTemplates', () => {
  it('returns hardcoded default when profiles dir is empty', () => {
    const list = listProfileTemplates()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('default')
  })

  it('returns profiles from JSON files in the dir', () => {
    const profile = {
      id: 'strict',
      label: 'Strict',
      description: 'No writes',
      permissionMode: 'strict',
      filesystem: { allow: [], deny: ['/**'] },
    }
    writeFileSync(join(PROFILES_DIR, 'strict.json'), JSON.stringify(profile))
    const list = listProfileTemplates()
    const found = list.find(p => p.id === 'strict')
    expect(found).toBeDefined()
    expect(found!.label).toBe('Strict')
  })

  it('skips non-JSON files', () => {
    writeFileSync(join(PROFILES_DIR, 'readme.txt'), 'ignore me')
    const list = listProfileTemplates()
    expect(list.every(p => p.id !== 'readme.txt')).toBe(true)
  })

  it('skips malformed JSON files', () => {
    writeFileSync(join(PROFILES_DIR, 'broken.json'), '{not valid json')
    expect(() => listProfileTemplates()).not.toThrow()
  })

  it('skips JSON files without an id field', () => {
    writeFileSync(join(PROFILES_DIR, 'noid.json'), JSON.stringify({ label: 'no id here' }))
    const list = listProfileTemplates()
    expect(list.find(p => (p as any).label === 'no id here')).toBeUndefined()
  })
})

describe('loadProfileTemplate', () => {
  it('returns hardcoded default for unknown id', () => {
    const p = loadProfileTemplate('nonexistent-profile-xyz')
    expect(p.id).toBe('default')
    expect(p).toEqual(HARDCODED_DEFAULT_PROFILE)
  })

  it('loads a profile that exists on disk', () => {
    const profile = {
      id: 'custom',
      label: 'Custom',
      description: 'Custom profile',
      permissionMode: 'permissive',
      filesystem: { allow: ['/tmp/**'], deny: [] },
    }
    writeFileSync(join(PROFILES_DIR, 'custom.json'), JSON.stringify(profile))
    const loaded = loadProfileTemplate('custom')
    expect(loaded.id).toBe('custom')
    expect(loaded.label).toBe('Custom')
    expect(loaded.filesystem.allow).toEqual(['/tmp/**'])
  })

  it('returns default when profile file has invalid JSON', () => {
    writeFileSync(join(PROFILES_DIR, 'bad-profile.json'), '{bad}')
    const p = loadProfileTemplate('bad-profile')
    expect(p.id).toBe('default')
  })
})

describe('resolveProfilePlaceholders', () => {
  const ctx = { HOME: '/home/user', AGENT_DIR: '/agents/alice' }

  it('replaces ${HOME}', () => {
    expect(resolveProfilePlaceholders('${HOME}/data', ctx)).toBe('/home/user/data')
  })

  it('replaces ${AGENT_DIR}', () => {
    expect(resolveProfilePlaceholders('${AGENT_DIR}/config', ctx)).toBe('/agents/alice/config')
  })

  it('replaces ${WORKDIR} as alias for AGENT_DIR', () => {
    expect(resolveProfilePlaceholders('${WORKDIR}/logs', ctx)).toBe('/agents/alice/logs')
  })

  it('replaces multiple occurrences', () => {
    const val = '${HOME} and ${AGENT_DIR} and ${WORKDIR}'
    expect(resolveProfilePlaceholders(val, ctx)).toBe('/home/user and /agents/alice and /agents/alice')
  })

  it('returns unchanged string when no placeholders', () => {
    expect(resolveProfilePlaceholders('/static/path', ctx)).toBe('/static/path')
  })
})
