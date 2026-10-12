import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// src/config.ts:331 resolves the embedding endpoint as
//   OLLAMA_URL ?? 'http://localhost:11434'
// but install-linux.sh hardcoded that fallback in seven places and never read
// OLLAMA_URL at all (`grep -c OLLAMA_URL install-linux.sh` was 0). An install
// pointed at a non-default or remote Ollama therefore:
//   - probed :11434 locally, found nothing, and installed a SECOND daemon,
//   - pulled nomic-embed-text into that local daemon,
//   - while the running fleet read the configured endpoint, where the model
//     was missing -- semantic memory silently degraded.
//
// The installer now resolves the endpoint the way the runtime does. These tests
// run the REAL resolution block out of the shipped install-linux.sh.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const DEFAULT_URL = 'http://localhost:11434'

/** The OLLAMA_API resolution block. */
function resolutionBlock(src: string): string {
  const start = src.indexOf('OLLAMA_API="${OLLAMA_URL:-}"')
  if (start < 0) throw new Error('OLLAMA_API resolution not found')
  const marker = `OLLAMA_API="\${OLLAMA_API:-${DEFAULT_URL}}"`
  const end = src.indexOf(marker, start)
  if (end < 0) throw new Error('OLLAMA_API default not found')
  return src.slice(start, end + marker.length)
}

/** Resolve with a given environment and .env content. */
function resolve(opts: { envVar?: string; dotenv?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-ollamaurl-'))
  if (opts.dotenv !== undefined) writeFileSync(join(dir, '.env'), opts.dotenv)

  const script = [
    'set -e',
    `INSTALL_DIR=${JSON.stringify(dir)}`,
    resolutionBlock(LINUX),
    'echo "$OLLAMA_API"',
  ].join('\n')

  return execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { ...process.env, ...(opts.envVar ? { OLLAMA_URL: opts.envVar } : { OLLAMA_URL: '' }) },
  }).trim()
}

describe('installer: OLLAMA_URL resolution matches the runtime', () => {
  it('falls back to the historical default when nothing is configured', () => {
    expect(resolve({})).toBe(DEFAULT_URL)
  })

  it('takes OLLAMA_URL from the environment', () => {
    expect(resolve({ envVar: 'http://ollama.internal:11434' })).toBe('http://ollama.internal:11434')
  })

  it('takes OLLAMA_URL from the .env the installer has already written', () => {
    expect(resolve({ dotenv: 'BOT_NAME=Marveen\nOLLAMA_URL=http://10.0.0.5:11434\n' }))
      .toBe('http://10.0.0.5:11434')
  })

  it('lets the environment win over .env, as cfg() does', () => {
    expect(resolve({ envVar: 'http://env-wins:11434', dotenv: 'OLLAMA_URL=http://dotenv:11434\n' }))
      .toBe('http://env-wins:11434')
  })

  it('tolerates a quoted .env value', () => {
    expect(resolve({ dotenv: 'OLLAMA_URL="http://quoted:11434"\n' })).toBe('http://quoted:11434')
  })

  it('falls back when .env has no OLLAMA_URL key', () => {
    expect(resolve({ dotenv: 'BOT_NAME=Marveen\n' })).toBe(DEFAULT_URL)
  })
})

describe('installer: no hardcoded endpoint left in the ollama step', () => {
  it('reaches the API only through OLLAMA_API', () => {
    // Everything after the resolution must go through the variable. The two
    // remaining literals are the documented default and the comment naming it.
    const afterResolution = LINUX.slice(LINUX.indexOf('OLLAMA_API="${OLLAMA_URL:-}"'))
    const stray = afterResolution
      .split('\n')
      .filter((l) => l.includes(DEFAULT_URL) && !l.includes('OLLAMA_API="${OLLAMA_API:-'))
    expect(stray).toEqual([])
  })
})
