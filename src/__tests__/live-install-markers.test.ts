import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLiveMarkers, LIVE_MARKERS } from './setup/live-install-markers.js'
import { assertNotLiveInstall } from './setup/global-live-install-gate.js'

describe('live-install markers', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'live-markers-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function touch(marker: string): void {
    mkdirSync(join(root, 'store'), { recursive: true })
    writeFileSync(join(root, marker), '')
  }

  it('lists exactly three markers', () => {
    expect(LIVE_MARKERS).toHaveLength(3)
  })

  it('finds nothing in an empty root', () => {
    expect(findLiveMarkers(root)).toEqual([])
  })

  it('finds nothing when store/ exists but holds no marker', () => {
    mkdirSync(join(root, 'store'))
    expect(findLiveMarkers(root)).toEqual([])
  })

  it.each(LIVE_MARKERS)('finds exactly %s when it is the only marker', (marker) => {
    touch(marker)
    expect(findLiveMarkers(root)).toEqual([marker])
  })

  it('finds all markers when all are present', () => {
    for (const m of LIVE_MARKERS) touch(m)
    expect(findLiveMarkers(root).sort()).toEqual([...LIVE_MARKERS].sort())
  })
})

describe('global live-install gate', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'live-gate-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('does not throw for a clean root', () => {
    expect(() => assertNotLiveInstall(root)).not.toThrow()
  })

  it.each(LIVE_MARKERS)('throws REFUSING TO RUN TESTS naming %s', (marker) => {
    mkdirSync(join(root, 'store'), { recursive: true })
    writeFileSync(join(root, marker), '')
    expect(() => assertNotLiveInstall(root)).toThrow(/REFUSING TO RUN TESTS/)
    expect(() => assertNotLiveInstall(root)).toThrow(marker)
  })
})
