import { describe, it, expect } from 'vitest'
import { systemDepsInstallCommand } from '../web/routes/voice.js'

// POST /api/voice/install answers a missing-dependency check with a command the
// user is told to run in a terminal. It was hard-coded to apt-get, which does
// not exist on macOS -- so on a Homebrew host the dashboard handed out a command
// that cannot work, in the one place where the user has no other guidance.

describe('systemDepsInstallCommand', () => {
  it('suggests Homebrew on macOS, never apt-get', () => {
    const cmd = systemDepsInstallCommand('darwin')
    expect(cmd).toContain('brew install')
    expect(cmd).toContain('ffmpeg')
    expect(cmd).not.toContain('apt-get')
    // brew refuses to run under sudo; suggesting it would be a second wrong turn.
    expect(cmd).not.toContain('sudo')
  })

  it('keeps the apt-get command on Linux', () => {
    const cmd = systemDepsInstallCommand('linux')
    expect(cmd).toContain('apt-get install')
    expect(cmd).toContain('ffmpeg')
    expect(cmd).toContain('python3-venv')
  })
})
