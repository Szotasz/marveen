import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Sandbox secret dir -- must be set BEFORE importing secret-resolver,
// since the module reads SECRET_MOUNT_DIR at module load time.
const SANDBOX_DIR = join(tmpdir(), `secret-resolver-test-${process.pid}`)

// Module is loaded fresh per test suite because of the top-level SECRET_DIR binding.
// We override SECRET_MOUNT_DIR before the import so the module uses the sandbox.
process.env['SECRET_MOUNT_DIR'] = SANDBOX_DIR

// Dynamic import after env is set.
const { resolveSecret } = await import('../secret-resolver.js')

beforeAll(() => {
  mkdirSync(SANDBOX_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(SANDBOX_DIR, { recursive: true, force: true })
  delete process.env['SECRET_MOUNT_DIR']
})

function writeSecret(name: string, value: string) {
  writeFileSync(join(SANDBOX_DIR, name), value)
}

describe('resolveSecret', () => {
  it('returns the trimmed file content when the key file exists', () => {
    writeSecret('AGENT_TOKEN', '  tok-abc123\n')
    expect(resolveSecret('AGENT_TOKEN')).toBe('tok-abc123')
  })

  it('returns undefined when the key file does not exist', () => {
    expect(resolveSecret('DOES_NOT_EXIST')).toBeUndefined()
  })

  it('returns undefined for an empty secret file', () => {
    writeSecret('EMPTY_SECRET', '   \n')
    expect(resolveSecret('EMPTY_SECRET')).toBeUndefined()
  })

  it('returns undefined for a file containing only whitespace', () => {
    writeSecret('WHITESPACE_SECRET', '\t  \n')
    expect(resolveSecret('WHITESPACE_SECRET')).toBeUndefined()
  })

  it('returns the value for a multi-line secret (trims to first+last newline)', () => {
    // A PEM or multi-line secret: trim() keeps inner content intact.
    writeSecret('MULTILINE', 'first\nsecond\nthird\n')
    expect(resolveSecret('MULTILINE')).toBe('first\nsecond\nthird')
  })

  it('does not path-traverse outside the secret dir (relative path input)', () => {
    // '../etc/passwd' is resolved to SECRET_DIR/../etc/passwd by join(),
    // which lands outside the sandbox -- the file does not exist, so the
    // result must be undefined (no throw, no traversal).
    expect(resolveSecret('../etc/passwd')).toBeUndefined()
  })

  it('handles keys with dots (e.g. service-account.json)', () => {
    writeSecret('sa.json', '{"key":"val"}')
    expect(resolveSecret('sa.json')).toBe('{"key":"val"}')
  })

  it('handles keys with underscores and uppercase (standard env-var casing)', () => {
    writeSecret('TELEGRAM_BOT_TOKEN', 'bot:12345')
    expect(resolveSecret('TELEGRAM_BOT_TOKEN')).toBe('bot:12345')
  })
})
