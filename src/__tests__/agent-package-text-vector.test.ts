import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { scanPackageText } from '../web/agent-package/verify.js'
import {
  PACKAGE_TEXT_VECTOR_SHA256,
  isInstallCase,
  loadTextVector,
  textVectorBytes,
} from './helpers/package-text-vector.js'

// The shared text vector binds the installer to the publishing side's text
// rules by DATA. Every install-stage case runs; the expectation is the reason
// and the line of the first finding (plan 10.1).

const vector = loadTextVector()
const installCases = vector.cases.filter(isInstallCase)

describe('shared package text vector: the copy', () => {
  it('is byte-identical to the pinned sha256', () => {
    expect(createHash('sha256').update(textVectorBytes()).digest('hex')).toBe(PACKAGE_TEXT_VECTOR_SHA256)
  })

  it('has install cases, and each one is either accepted or names exactly one reason', () => {
    expect(installCases.length).toBeGreaterThan(0)
    for (const c of installCases) {
      if ('ok' in c.expect) continue
      expect(c.expect.findings.length).toBeGreaterThan(0)
    }
  })
})

describe('shared package text vector: every install-stage case', () => {
  it.each(installCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const got = scanPackageText(Buffer.from(c.bytes_b64, 'base64'))
    if ('ok' in c.expect) {
      expect(got).toBeNull()
      return
    }
    expect(got).not.toBeNull()
    expect(got!.reason).toBe(c.expect.reason)
    expect(got!.line).toBe(c.expect.findings[0].line)
  })
})
