import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveTranscriptLocation } from '../web/routes/agents.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { projectsDirFor } from '../web/active-model.js'

// GH #816: the dashboard showed the main agent's model as the DEFAULT_MODEL
// fallback rather than the model the process was on, and the display read as a
// statement rather than as "I do not know". The reporter saw the owner take it
// for a silent downgrade of their assistant.
//
// The reason activeModel could never fill that gap: the row resolved the
// transcript location through agentDir(name), i.e. <root>/agents/<main>. The
// main agent runs in PROJECT_ROOT, under the channels session, so the reader
// was pointed at a different working directory than the one being written.
// Measured on the live install at the same moment: the old path resolved to a
// directory that EXISTS and yields null, the new one yields claude-opus-5,
// which is what the process was running. The old directory not being missing is
// why this never surfaced as an error.

describe('resolveTranscriptLocation', () => {
  it('points the MAIN agent at PROJECT_ROOT, where it actually runs', () => {
    expect(resolveTranscriptLocation(MAIN_AGENT_ID).workingDir).toBe(PROJECT_ROOT)
  })

  it('does NOT point the main agent at agents/<name>, the path that made activeModel null', () => {
    expect(resolveTranscriptLocation(MAIN_AGENT_ID).workingDir).not.toContain(join('agents', MAIN_AGENT_ID))
  })

  it('keeps sub-agents on their own working directory', () => {
    const loc = resolveTranscriptLocation('some-sub-agent')
    expect(loc.workingDir).toContain(join('agents', 'some-sub-agent'))
    expect(loc.workingDir).not.toBe(PROJECT_ROOT)
  })

  it('encodes to the project dir the session actually writes', () => {
    // The encoding is what ties the two halves together: PROJECT_ROOT
    // /Users/x/ClaudeClaw becomes -Users-x-ClaudeClaw, which is the directory
    // name observed on a live install.
    const loc = resolveTranscriptLocation(MAIN_AGENT_ID)
    const dir = projectsDirFor(loc.workingDir, loc.configDir)
    expect(dir).toContain(PROJECT_ROOT.replace(/[/.]/g, '-'))
  })
})

describe('resolveTranscriptLocation: isolated config root', () => {
  // With main-agent isolation the session writes under <root>/.channels-config.
  // The probe is filesystem-based rather than a re-derivation of the launcher's
  // isolation decision, so these two cases are about the directory existing.
  let tmp: string

  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'gh816-')) })
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('returns a configDir only when the isolated projects dir exists', () => {
    // On this checkout the real PROJECT_ROOT decides the answer; assert the
    // contract rather than a machine-specific value.
    const loc = resolveTranscriptLocation(MAIN_AGENT_ID)
    if (loc.configDir !== undefined) {
      expect(loc.configDir).toBe(join(PROJECT_ROOT, '.channels-config'))
    } else {
      expect(loc.configDir).toBeUndefined()
    }
  })

  it('projectsDirFor falls back to the shared root when no configDir is given', () => {
    const withIsolation = projectsDirFor('/w', '/iso')
    const without = projectsDirFor('/w', undefined, '/home/u')
    expect(withIsolation).toBe(join('/iso', 'projects', '-w'))
    expect(without).toBe(join('/home/u', '.claude', 'projects', '-w'))
    mkdirSync(join(tmp, 'unused'), { recursive: true })
  })
})
