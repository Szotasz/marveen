import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampExternalIncludesDeclined } from '../web/agent-process.js'

// Card 9b419139: the root CLAUDE.md's @import is an EXTERNAL include for every
// agents/<name> session, and Claude Code keys the "allow external imports"
// dialog on the install dir's project entry. These pin the pre-answer.
const WARN = 'hasClaudeMdExternalIncludesWarningShown'
const APPROVED = 'hasClaudeMdExternalIncludesApproved'

describe('stampExternalIncludesDeclined', () => {
  let dir: string
  let dotClaude: string
  let install: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ext-includes-'))
    dotClaude = join(dir, '.claude.json')
    install = join(dir, 'install')
    mkdirSync(install)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stamps the declined verdict ("No") on the install dir key Claude Code reads (its realpath) of a fresh config', () => {
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    const key = realpathSync(install)
    expect(Object.keys(data.projects)).toEqual([key])
    expect(data.projects[key][WARN]).toBe(true)
    expect(data.projects[key][APPROVED]).toBe(false)
  })

  it('keeps the other keys of the same project entry and the other projects', () => {
    const key = realpathSync(install)
    const agentDir = join(key, 'agents', 'x')
    writeFileSync(dotClaude, JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        [key]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
        [agentDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }))
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.hasCompletedOnboarding).toBe(true)
    expect(data.projects[key].allowedTools).toEqual(['Bash'])
    expect(data.projects[key].hasTrustDialogAccepted).toBe(true)
    expect(data.projects[key][WARN]).toBe(true)
    expect(data.projects[agentDir]).toEqual({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true })
  })

  it('never overrides an earlier explicit choice (an operator\'s "Yes" stays)', () => {
    const before = JSON.stringify({ projects: { [install]: { [WARN]: true, [APPROVED]: true } } })
    writeFileSync(dotClaude, before)
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(before)
  })

  it('is idempotent: a second launch is a no-op and leaves the bytes alone', () => {
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(true)
    const first = readFileSync(dotClaude, 'utf-8')
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(first)
  })

  it('stamps the realpath key only, not the symlink spelling (symlinked install dir)', () => {
    const link = join(dir, 'install-link')
    symlinkSync(install, link)
    expect(stampExternalIncludesDeclined(dotClaude, link)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(Object.keys(data.projects)).toEqual([realpathSync(link)])
    expect(data.projects[realpathSync(link)][WARN]).toBe(true)
  })

  it('keeps an explicit choice under the realpath key when called with the symlink path', () => {
    const link = join(dir, 'install-link')
    symlinkSync(install, link)
    const before = JSON.stringify({ projects: { [realpathSync(link)]: { [WARN]: true, [APPROVED]: true } } })
    writeFileSync(dotClaude, before)
    expect(stampExternalIncludesDeclined(dotClaude, link)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(before)
  })

  it('keeps an explicit choice under the symlink spelling: no stamp on the realpath key either', () => {
    const link = join(dir, 'install-link')
    symlinkSync(install, link)
    const before = JSON.stringify({ projects: { [link]: { [WARN]: true, [APPROVED]: true } } })
    writeFileSync(dotClaude, before)
    expect(stampExternalIncludesDeclined(dotClaude, link)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(before)
  })

  it('returns false on unparseable JSON without touching the file', () => {
    writeFileSync(dotClaude, '{ not json')
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe('{ not json')
    expect(existsSync(dotClaude)).toBe(true)
  })
})

// The macOS case on any OS: there the tmp dir itself is a symlink (/var -> /private/var), so every path the
// tests build is a symlink spelling of the key Claude Code reads.
describe('stampExternalIncludesDeclined under a symlinked tmp root', () => {
  let root: string
  let install: string
  let dotClaude: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ext-includes-root-'))
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    install = join(root, 'link', 'install')
    mkdirSync(install)
    dotClaude = join(root, 'link', '.claude.json')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('never overrides an earlier explicit choice stored under the given spelling', () => {
    const before = JSON.stringify({ projects: { [install]: { [WARN]: true, [APPROVED]: true } } })
    writeFileSync(dotClaude, before)
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(false)
    expect(readFileSync(dotClaude, 'utf-8')).toBe(before)
  })

  it('a fresh config gets the stamp on the realpath key only', () => {
    expect(stampExternalIncludesDeclined(dotClaude, install)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(Object.keys(data.projects)).toEqual([join(realpathSync(root), 'real', 'install')])
  })
})

describe('external-includes stamp wiring (9b419139)', () => {
  const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

  it('startAgentProcess stamps the install dir in the ISOLATED config root only, before the spawn', () => {
    const callIdx = AGENT_PROCESS.indexOf("stampExternalIncludesDeclined(join(claudeConfigDir, '.claude.json'), PROJECT_ROOT)")
    const launchIdx = AGENT_PROCESS.indexOf("runTmux(startTarget, ['new-session', '-d', '-s', session, buildLaunchCmd(dir)]")
    expect(callIdx).toBeGreaterThan(0)
    expect(launchIdx).toBeGreaterThan(0)
    expect(launchIdx).toBeGreaterThan(callIdx)
    // Guarded by the isolated config root: the shared ~/.claude.json is also the main
    // agent's, and the main agent keeps its import.
    const guard = AGENT_PROCESS.lastIndexOf('if (claudeConfigDir) {', callIdx)
    expect(guard).toBeGreaterThan(0)
    expect(callIdx - guard).toBeLessThan(120)
  })
})
