/**
 * The root package is an application, not a library: it must never be published
 * to the npm registry by accident (a stray `npm publish` from the repo root would
 * upload the whole source tree, scripts and docs included). `"private": true` makes
 * npm refuse the publish (EPRIVATE, raised in libnpmpublish before any network
 * call). The open-source inventory is unaffected: it scans agents/*\/ only.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('root package.json', () => {
  it('is marked private, so npm refuses to publish it', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
    expect(pkg.private).toBe(true)
  })
})
