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
    // Stricter than the vector asks of the install side (reason and line): the
    // rule reported here is one the reference reports on that same line. Without
    // it, dropping the marker or the tab rule changes nothing observable, because
    // the key rule refuses the same line with the same reason.
    expect(c.expect.findings.filter((f) => f.line === got!.line).map((f) => f.rule)).toContain(got!.rule)
  })
})

describe('frontmatter shapes the shared vector does not tell apart yet (proposed to the publishing side)', () => {
  // The vector's two cases of a block header with text after the indicator have
  // no body line, so they are refused even if that text is let through. With an
  // indented body under it, only the header rule refuses them. The expectation
  // is the reference's own rule (its block header pattern), read from its code.
  const cases: Array<[string, string]> = [
    ['an indentation indicator, with a body', '---\ndescription: |2\n  text\n---\n'],
    ['a comment after the indicator, with a body', '---\ndescription: > # c\n  text\n---\n'],
    ['text after the indicator, with a body', '---\ndescription: > folded\n  text\n---\n'],
    ['a chomping indicator and then text, with a body', '---\nname: |- x\n  text\n---\n'],
  ]
  it.each(cases)('a block header with %s is refused', (_name, text) => {
    expect(scanPackageText(Buffer.from(text, 'utf8'))).toEqual({
      reason: 'forbidden_frontmatter_key',
      rule: 'frontmatter-value',
      line: 2,
    })
  })

  it('the plain block headers with a body pass', () => {
    for (const header of ['|', '>', '|-', '>+', '| ']) {
      expect(scanPackageText(Buffer.from(`---\ndescription: ${header}\n  text\n---\n`, 'utf8'))).toBeNull()
    }
  })
})
