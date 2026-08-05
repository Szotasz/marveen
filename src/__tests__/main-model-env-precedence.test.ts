// Regression tests for the split-brain between the LAUNCH and the RESPAWN path
// when resolving the main agent's model.
//
// Background (2026-08-04): scripts/channels.sh resolves the main model from
// `.env MAIN_AGENT_MODEL` first and only then from `.claude/settings.json` --
// deliberately, because .env is gitignored while settings.json is tracked, so an
// install that wants its own model can set it without dirtying a tracked file
// (which would otherwise block the update preflight and be reverted by the next
// update). `readConfiguredMainModel()` in channel-monitor.ts read ONLY
// settings.json, so the two paths agreed just as long as someone kept both files
// in sync by hand.
//
// Why that is worse than a plain inconsistency: the tracked settings.json ships a
// model of its own. An update reverts local edits to tracked files, so the very
// next respawn can hand the main session a DIFFERENT model than the one it
// launched with -- silently, with no dialog, no error and no log line, while the
// launch path keeps reporting the intended value.
//
// The asserts below lock BOTH sides: the TS behaviour, and the shell function it
// is supposed to mirror. A future edit that flips the precedence in channels.sh
// alone would otherwise re-open exactly the same gap from the other direction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readConfiguredMainModel, readExtraChannelPluginIds } from '../web/channel-monitor.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let root: string

function writeEnv(contents: string): void {
  writeFileSync(join(root, '.env'), contents)
}

function writeSettings(obj: unknown): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(obj, null, 2))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'main-model-precedence-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readConfiguredMainModel', () => {
  it('prefers .env MAIN_AGENT_MODEL over the tracked .claude/settings.json', () => {
    writeEnv('SOMETHING_ELSE=1\nMAIN_AGENT_MODEL=claude-opus-5\n')
    writeSettings({ model: 'claude-opus-4-8[1m]' })
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })

  it('falls back to settings.json when .env has no MAIN_AGENT_MODEL', () => {
    writeEnv('CHANNEL_PLUGINS_EXTRA=slack-channel@marveen-marketplace\n')
    writeSettings({ model: 'claude-opus-4-8[1m]' })
    expect(readConfiguredMainModel(root)).toBe('claude-opus-4-8[1m]')
  })

  it('falls back to settings.json when .env is absent entirely', () => {
    writeSettings({ model: 'claude-opus-5' })
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })

  // An EMPTY value must not win: `MAIN_AGENT_MODEL=` is how a half-edited .env
  // looks, and treating it as a real answer would drop the --model flag and hand
  // the session to claude-code's built-in default -- the drift this function
  // exists to prevent.
  it('ignores an empty MAIN_AGENT_MODEL and falls through', () => {
    writeEnv('MAIN_AGENT_MODEL=\n')
    writeSettings({ model: 'claude-opus-5' })
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })

  it('returns empty string when neither source names a model', () => {
    writeEnv('MAIN_AGENT_MODEL_SOMETHINGELSE=x\n')
    writeSettings({ enabledPlugins: {} })
    expect(readConfiguredMainModel(root)).toBe('')
  })

  it('survives an unparseable settings.json', () => {
    writeEnv('MAIN_AGENT_MODEL=claude-opus-5\n')
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')
    expect(readConfiguredMainModel(root)).toBe('claude-opus-5')
  })
})

describe('readExtraChannelPluginIds (shares the same .env reader)', () => {
  it('still splits a space-separated list', () => {
    writeEnv('CHANNEL_PLUGINS_EXTRA=slack-channel@marveen-marketplace  discord@x\n')
    expect(readExtraChannelPluginIds(root)).toEqual([
      'slack-channel@marveen-marketplace',
      'discord@x',
    ])
  })

  it('returns [] when unset, absent or empty', () => {
    writeEnv('MAIN_AGENT_MODEL=claude-opus-5\n')
    expect(readExtraChannelPluginIds(root)).toEqual([])
  })
})

// A shell<->TS runtime parity is covered by main-model-resolution-parity.test.ts
// (executes channels.sh --resolve-main-model and asserts TS === shell). The
// weaker structural source-inspection that used to live here was dropped.

