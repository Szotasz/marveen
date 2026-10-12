// Coverage for the native-ABI suite gate's decision logic (see
// src/__tests__/setup/assert-supported-node.ts for the incident it prevents).
// The gate itself is import-time side effect; these are its pure parts.
import { describe, it, expect } from 'vitest'

import {
  buildNodeAbiMessage,
  isNodeAbiMismatch,
  readExpectedNodeMajor,
} from '../__tests__/setup/node-abi.js'

const REAL_BINDINGS_ERROR =
  "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  'was compiled against a different Node.js version using\n' +
  'NODE_MODULE_VERSION 127. This version of Node.js requires\n' +
  'NODE_MODULE_VERSION 147. Please try re-compiling or re-installing\n' +
  'the module (for instance, using `npm rebuild` or `npm install`).'

describe('isNodeAbiMismatch', () => {
  it('recognises the real bindings error that cost the 2026-08-17 diagnosis', () => {
    expect(isNodeAbiMismatch(new Error(REAL_BINDINGS_ERROR))).toBe(true)
  })

  it('does not claim an unrelated failure — a real bug must surface as itself', () => {
    expect(isNodeAbiMismatch(new Error('Cannot find module better-sqlite3'))).toBe(false)
    expect(isNodeAbiMismatch(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBe(
      false,
    )
  })

  it('handles a thrown non-Error without crashing the gate', () => {
    expect(isNodeAbiMismatch('NODE_MODULE_VERSION 127')).toBe(true)
    expect(isNodeAbiMismatch(undefined)).toBe(false)
  })
})

describe('readExpectedNodeMajor', () => {
  it('reads the major from .nvmrc', () => {
    expect(readExpectedNodeMajor('/repo', () => '22\n')).toBe('22')
  })

  it('tolerates a v-prefix and a full version', () => {
    expect(readExpectedNodeMajor('/repo', () => 'v22')).toBe('22')
    expect(readExpectedNodeMajor('/repo', () => '22.11.0')).toBe('22')
  })

  it('returns null rather than inventing a target when .nvmrc is missing', () => {
    expect(readExpectedNodeMajor('/repo', () => null)).toBeNull()
    expect(readExpectedNodeMajor('/repo', () => 'lts/iron')).toBeNull()
  })

  it('reads the repo-root .nvmrc, not some other path', () => {
    const seen: string[] = []
    readExpectedNodeMajor('/repo', (path) => {
      seen.push(path)
      return '22'
    })
    expect(seen).toEqual(['/repo/.nvmrc'])
  })
})

describe('buildNodeAbiMessage', () => {
  const message = buildNodeAbiMessage({
    originalMessage: REAL_BINDINGS_ERROR,
    runningVersion: 'v26.7.0',
    expectedMajor: '22',
  })

  it('states both versions, so the reader does not have to work them out', () => {
    expect(message).toContain('v26.7.0')
    expect(message).toContain('Node 22 (.nvmrc)')
  })

  it('says the suite is not broken — that is the whole point of the gate', () => {
    expect(message).toContain('Nothing in the suite is broken')
  })

  it('gives a command that fixes it, targeting the expected major', () => {
    expect(message).toContain('nvm use')
    expect(message).toContain('/opt/homebrew/opt/node@22/bin')
  })

  it('warns that rebuilding rebinds node_modules to the running Node', () => {
    expect(message).toContain('npm rebuild better-sqlite3')
    expect(message).toContain('live install')
  })

  it('keeps the original error to one line so the advice is not buried', () => {
    expect(message).toContain("The module '/repo/node_modules/better-sqlite3")
    expect(message).not.toContain('Please try re-compiling')
  })

  it('omits an invented target when .nvmrc could not be read', () => {
    const withoutTarget = buildNodeAbiMessage({
      originalMessage: REAL_BINDINGS_ERROR,
      runningVersion: 'v26.7.0',
      expectedMajor: null,
    })

    expect(withoutTarget).toContain('the version this checkout was installed with')
    expect(withoutTarget).not.toContain('node@null')
  })
})
