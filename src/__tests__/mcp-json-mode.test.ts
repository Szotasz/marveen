// MCPJSON0600-1121: every .mcp.json writer goes through writeMcpJsonFile (0600, rename replaces a symlink instead of
// following it), and a pre-existing 0644 file is narrowed at the next spawn by tightenMcpJsonMode.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, rmSync, chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeMcpJsonFile, tightenMcpJsonMode, MCP_JSON_MODE } from '../web/atomic-write.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcpjson-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const mode = (p: string) => statSync(p).mode & 0o777

describe('writeMcpJsonFile', () => {
  it('writes a new file owner-only', () => {
    const p = join(dir, '.mcp.json')
    writeMcpJsonFile(p, '{"mcpServers":{}}\n')
    expect(mode(p)).toBe(MCP_JSON_MODE)
    expect(readFileSync(p, 'utf-8')).toBe('{"mcpServers":{}}\n')
  })

  it('narrows an existing 0644 file on rewrite', () => {
    const p = join(dir, '.mcp.json')
    writeFileSync(p, '{}'); chmodSync(p, 0o644)
    writeMcpJsonFile(p, '{"mcpServers":{"a":{}}}')
    expect(mode(p)).toBe(0o600)
  })

  it('replaces a symlink at the path instead of writing through it', () => {
    const target = join(dir, 'elsewhere.json')
    writeFileSync(target, 'ORIGINAL')
    const p = join(dir, '.mcp.json')
    symlinkSync(target, p)
    writeMcpJsonFile(p, '{"mcpServers":{}}')
    expect(readFileSync(target, 'utf-8')).toBe('ORIGINAL')
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
    expect(mode(p)).toBe(0o600)
  })

  it('leaves no tmp file behind', () => {
    writeMcpJsonFile(join(dir, '.mcp.json'), '{}')
    expect(readdirSync(dir)).toEqual(['.mcp.json'])
  })
})

describe('tightenMcpJsonMode', () => {
  it('narrows a 0644 regular file and reports it', () => {
    const p = join(dir, '.mcp.json')
    writeFileSync(p, '{}'); chmodSync(p, 0o644)
    expect(tightenMcpJsonMode(p)).toBe(true)
    expect(mode(p)).toBe(0o600)
  })

  it('leaves a 0600 file alone', () => {
    const p = join(dir, '.mcp.json')
    writeFileSync(p, '{}'); chmodSync(p, 0o600)
    expect(tightenMcpJsonMode(p)).toBe(false)
  })

  it('never chmods through a symlink', () => {
    const target = join(dir, 'elsewhere.json')
    writeFileSync(target, '{}'); chmodSync(target, 0o644)
    const p = join(dir, '.mcp.json')
    symlinkSync(target, p)
    expect(tightenMcpJsonMode(p)).toBe(false)
    expect(mode(target)).toBe(0o644)
  })

  it('a missing file is not an error', () => {
    expect(tightenMcpJsonMode(join(dir, 'nope.json'))).toBe(false)
  })
})

describe('wiring: no .mcp.json writer bypasses the helper', () => {
  const ROOT = join(__dirname, '..')
  const files = ['web/agent-process.ts', 'web/agent-worker.ts', 'heartbeat.ts', 'web/routes/agents.ts', 'web/agent-scaffold.ts', 'web/routes/connectors.ts']
  it.each(files)('%s writes .mcp.json only through writeMcpJsonFile', (f) => {
    // A direct write whose first argument names an .mcp.json path. The one exception is connectors.ts's removal
    // loop over ~/.claude.json and external project files, which keeps each file's own mode on purpose.
    const lines = readFileSync(join(ROOT, f), 'utf-8').split('\n')
      .filter((l) => !l.includes('mode: statSync(mcpPath).mode'))
    const direct = lines.filter((l) =>
      /(?:writeFileSync|atomicWriteFileSync)\((?:mcpJsonPath|mcpPath|mcpJson)\b/.test(l)
      // One level of nested parentheses, so join(agentDir(name), '.mcp.json') is caught too (Geri on #3011).
      || /(?:writeFileSync|atomicWriteFileSync)\(join\((?:[^()]|\([^()]*\))*'\.mcp\.json'\)/.test(l))
    expect(direct).toEqual([])
  })
  it('fleet-transfer writes both .mcp.json files at MCP_JSON_MODE', () => {
    const src = readFileSync(join(ROOT, 'web/fleet-transfer.ts'), 'utf-8')
    expect(src.match(/'\.mcp\.json'\)[^\n]*tracker, \{ mode: MCP_JSON_MODE \}\)/g)?.length).toBe(2)
  })
  it('agent-process narrows a pre-existing .mcp.json at spawn', () => {
    const src = readFileSync(join(ROOT, 'web/agent-process.ts'), 'utf-8')
    expect(src).toContain("tightenMcpJsonMode(join(agentDir(name), '.mcp.json'))")
  })
})
