import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnvContent } from '../env-parse.js'

// ENVLOADSPACE1107: morning-briefing.sh and hooks/memory-save.sh loaded .env with
// `export $(grep -v '^#' .env | xargs)`. The unquoted $(...) word-splits after xargs
// has dropped the quotes, so OWNER_NAME="Németh László" became `export
// OWNER_NAME=Németh László` and bash failed with "László: not a valid identifier"
// (measured 2026-11-07 in the timer journal). scripts/lib/load-env.sh replaces it
// with a line parser that matches src/env-parse.ts and never evaluates the file.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIB = join(ROOT, 'scripts/lib/load-env.sh')

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'load-env-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function load(content: string, keys: string[]): { env: Record<string, string>; stderr: string; status: number | null } {
  const file = join(dir, `env-${Math.random().toString(36).slice(2)}`)
  writeFileSync(file, content)
  const print = keys.map(k => `printf '%s\\0%s\\0' ${k} "\${${k}-<unset>}"`).join('; ')
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "$1"; load_env_file "$2"; ${print}`, 'x', LIB, file], {
    cwd: dir, encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' },
  })
  const parts = (r.stdout ?? '').split('\0')
  const env: Record<string, string> = {}
  for (let i = 0; i + 1 < parts.length; i += 2) env[parts[i]] = parts[i + 1]
  return { env, stderr: r.stderr ?? '', status: r.status }
}

describe('scripts/lib/load-env.sh', () => {
  it('keeps a quoted value with a space as one value, with no export error', () => {
    const r = load('OWNER_NAME="Németh László"\nWEB_PORT=3420\n', ['OWNER_NAME', 'WEB_PORT'])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.env).toEqual({ OWNER_NAME: 'Németh László', WEB_PORT: '3420' })
  })

  it('never evaluates the file: no command substitution, backticks, variables or globs', () => {
    writeFileSync(join(dir, 'decoy.txt'), '')
    const r = load('A=$(touch pwned)\nB=`touch pwned2`\nC=$HOME\nD=*.txt\n', ['A', 'B', 'C', 'D'])
    expect(r.status).toBe(0)
    expect(r.env).toEqual({ A: '$(touch pwned)', B: '`touch pwned2`', C: '$HOME', D: '*.txt' })
    expect(() => readFileSync(join(dir, 'pwned'))).toThrow()
    expect(() => readFileSync(join(dir, 'pwned2'))).toThrow()
  })

  it('matches src/env-parse.ts on comments, CRLF, whitespace, quotes and last-wins', () => {
    const content = [
      '# comment', '', '  SPACED = padded value  ', "SINGLE='one two'", 'CRLF=yes\r',
      'MISMATCH="open', 'LONE="', "LONE1='", 'EQ=a=b', 'DUP=first', 'DUP=second', 'not a line', '1BAD=x',
    ].join('\n')
    const keys = ['SPACED', 'SINGLE', 'CRLF', 'MISMATCH', 'LONE', 'LONE1', 'EQ', 'DUP']
    const r = load(content, keys)
    expect(r.status).toBe(0)
    const ts = parseEnvContent(content, keys)
    expect(r.env).toEqual(ts)
    expect(r.env.SPACED).toBe('padded value')
    expect(r.env.LONE).toBe('')
  })

  it('loads a last line that has no trailing newline', () => {
    const r = load('FIRST=1\nLAST="no newline here"', ['FIRST', 'LAST'])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.env).toEqual({ FIRST: '1', LAST: 'no newline here' })
  })

  it('skips an export-prefixed line, like src/env-parse.ts gives no plain key for it', () => {
    const content = 'export HIDDEN=x\nKEPT=y\n'
    const r = load(content, ['HIDDEN', 'KEPT'])
    expect(r.status).toBe(0)
    expect(r.env).toEqual({ HIDDEN: '<unset>', KEPT: 'y' })
    expect(parseEnvContent(content, ['HIDDEN', 'KEPT'])).toEqual({ KEPT: 'y' })
  })

  it('a missing file is not an error', () => {
    const r = spawnSync('bash', ['-c', 'set -euo pipefail; . "$1"; load_env_file /nonexistent/.env; echo ok', 'x', LIB], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout.trim()).toBe('ok')
  })

  it('no shipped script loads .env through the word-splitting xargs pattern', () => {
    for (const rel of ['scripts/morning-briefing.sh', 'scripts/hooks/memory-save.sh']) {
      const s = readFileSync(join(ROOT, rel), 'utf-8')
      expect(s).not.toMatch(/export \$\(grep[^)]*\.env[^)]*xargs\)/)
      expect(s).toMatch(/load_env_file "\$INSTALL_DIR\/\.env"/)
    }
  })
})
