import { describe, it, expect } from 'vitest'
import { absolutizeFileRule } from '../web/agent-scaffold.js'

// A single-slash Read/Write/Edit path is project-root relative in Claude Code,
// so an absolute path needs `//`. A deny that stays single-slash never matches,
// which quietly turns a fail-closed deny into an "ask".
describe('absolutizeFileRule', () => {
  it('doubles the leading slash of a single-slash file rule', () => {
    expect(absolutizeFileRule('Edit(/home/u/agents/x/**)')).toBe('Edit(//home/u/agents/x/**)')
    expect(absolutizeFileRule('Read(/mnt/e/lib/**)')).toBe('Read(//mnt/e/lib/**)')
    expect(absolutizeFileRule('Write(/tmp/a)')).toBe('Write(//tmp/a)')
  })

  it('is idempotent on an already absolute rule', () => {
    const once = absolutizeFileRule('Write(/mnt/e/x/**)')
    expect(absolutizeFileRule(once)).toBe(once)
    expect(absolutizeFileRule('Read(//etc/hosts)')).toBe('Read(//etc/hosts)')
  })

  it('leaves relative and home-relative file rules alone', () => {
    expect(absolutizeFileRule('Read(src/**)')).toBe('Read(src/**)')
    expect(absolutizeFileRule('Read(~/.ssh/**)')).toBe('Read(~/.ssh/**)')
    expect(absolutizeFileRule('Edit(./x)')).toBe('Edit(./x)')
  })

  it('never touches non-file tools, even when their argument starts with a slash', () => {
    expect(absolutizeFileRule('Bash(/usr/bin/ls:*)')).toBe('Bash(/usr/bin/ls:*)')
    expect(absolutizeFileRule('WebFetch(domain:example.com)')).toBe('WebFetch(domain:example.com)')
    expect(absolutizeFileRule('NotebookEdit(/x)')).toBe('NotebookEdit(/x)')
    expect(absolutizeFileRule('Bash')).toBe('Bash')
    expect(absolutizeFileRule('ScheduleWakeup')).toBe('ScheduleWakeup')
  })

  it('does not match a tool name that only shares a prefix', () => {
    expect(absolutizeFileRule('ReadMcpResource(/x)')).toBe('ReadMcpResource(/x)')
  })

  it('leaves a malformed rule without the closing paren alone', () => {
    expect(absolutizeFileRule('Read(/x')).toBe('Read(/x')
  })
})
