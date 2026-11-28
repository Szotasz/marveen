// DISPOSABLECLOUD1126: on a Claude Code cloud VM (a throwaway clone, no live install) the live-install suite guard and
// the db-write-gate stand down; everywhere else they stay exactly as they were. The switch is off by default and only
// the cloud runtime's own two variables turn it on: one of them alone, or a local environment, keeps both gates on.
// The variables never turn a gate off where a live install's token marker exists (#3177: they can be planted).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { INSTALL_ROOT, onDisposableCloud } from '../../scripts/hooks/db-write-gate.mjs'
import { liveMarkersFound } from './setup/assert-not-live-install.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const CLOUD = { CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_test' }
const runningInCloud = process.env.CLAUDE_CODE_REMOTE === 'true' && Boolean(process.env.CLAUDE_CODE_REMOTE_SESSION_ID)

describe('live-install suite guard', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'disposable-cloud-')))
    mkdirSync(join(root, 'store'))
    writeFileSync(join(root, 'store', 'claudeclaw.db'), '')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('refuses a checkout with a live marker outside the cloud, also with only one of the two variables', () => {
    for (const env of [{}, { CLAUDE_CODE_REMOTE: 'true' }, { CLAUDE_CODE_REMOTE_SESSION_ID: 'x' }, { ...CLOUD, CLAUDE_CODE_REMOTE: '1' }] as Record<string, string>[]) {
      expect(liveMarkersFound(root, env)).toEqual([join('store', 'claudeclaw.db')])
    }
  })

  it('stands down on the cloud VM', () => {
    expect(liveMarkersFound(root, CLOUD)).toEqual([])
  })

  it('still refuses in the cloud when a token marker exists', () => {
    for (const token of ['.dashboard-token', '.claude-oauth-token']) {
      writeFileSync(join(root, 'store', token), '')
      expect(liveMarkersFound(root, CLOUD)).toEqual([join('store', token)])
      rmSync(join(root, 'store', token))
    }
  })

  it.skipIf(runningInCloud)('still refuses with this machine\'s own environment', () => {
    expect(liveMarkersFound(root)).toEqual([join('store', 'claudeclaw.db')])
  })
})

describe('db-write-gate', () => {
  const run = (extra: Record<string, string>) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: INSTALL_ROOT }
    delete env.CLAUDE_CODE_REMOTE
    delete env.CLAUDE_CODE_REMOTE_SESSION_ID
    const payload = { tool_name: 'Bash', tool_input: { command: 'git checkout -b claude/x' }, cwd: INSTALL_ROOT }
    return spawnSync(process.execPath, [join(INSTALL_ROOT, 'scripts', 'hooks', 'db-write-gate.mjs')], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...env, ...extra } })
  }
  const denied = (r: ReturnType<typeof spawnSync>) => String(r.stdout).includes('"permissionDecision":"deny"')

  it('denies a git write in the checkout outside the cloud, also with only one of the two variables', () => {
    for (const extra of [{}, { CLAUDE_CODE_REMOTE: 'true' }, { CLAUDE_CODE_REMOTE_SESSION_ID: 'x' }] as Record<string, string>[]) {
      const r = run(extra)
      expect(r.status).toBe(0)
      expect(denied(r)).toBe(true)
      expect(String(r.stdout)).toContain('APPROVALDBGATE1030')
    }
  })

  it('lets it through on the cloud VM', () => {
    const r = run(CLOUD)
    expect(r.status).toBe(0)
    expect(String(r.stdout)).toBe('')
  })

  it('does not stand down in the cloud when the install root holds a token marker', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'disposable-cloud-')))
    try {
      mkdirSync(join(root, 'store'))
      expect(onDisposableCloud(CLOUD, root)).toBe(true)
      for (const token of ['.dashboard-token', '.claude-oauth-token']) {
        writeFileSync(join(root, 'store', token), '')
        expect(onDisposableCloud(CLOUD, root)).toBe(false)
        rmSync(join(root, 'store', token))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
