import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { provisionMemoryBoundaryDir } from '../web/memory-boundary.js'

describe('provisionMemoryBoundaryDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-boundary-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a stub git root with an ignore-everything exclude', () => {
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toBe('*\n')
    // the boundary is a real git root: rev-parse resolves to the agent dir itself
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8' }).trim()
    expect(top).toBe(execFileSync('realpath', [dir], { encoding: 'utf-8' }).trim())
  })

  it('keeps the working tree clean: git status reports nothing despite files', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# agent instructions\n')
    mkdirSync(join(dir, 'workspace'))
    writeFileSync(join(dir, 'workspace', 'note.txt'), 'data\n')
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })
    expect(status).toBe('')
  })

  it('is idempotent and repairs a missing exclude on re-run', () => {
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    rmSync(join(dir, '.git', 'info', 'exclude'))
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toBe('*\n')
  })

  it('does not re-init an existing repo (preserves .git contents)', () => {
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    writeFileSync(join(dir, '.git', 'marker'), 'keep me\n')
    expect(provisionMemoryBoundaryDir(dir)).toBe(true)
    expect(readFileSync(join(dir, '.git', 'marker'), 'utf-8')).toBe('keep me\n')
  })

  it('returns false for a missing dir without throwing', () => {
    expect(provisionMemoryBoundaryDir(join(dir, 'does-not-exist'))).toBe(false)
  })
})
