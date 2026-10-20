import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WORKSOURCE_HEARTBEAT_FILE,
  WORKSOURCE_HEARTBEAT_STALE_MS,
  worksourceHeartbeatAgeMsAt,
  worksourceReaderAliveAt,
} from '../web/worksource-queue.js'

// #560: the router's "serving" evidence now needs the reader's heartbeat.
describe('worksource reader heartbeat', () => {
  it('no heartbeat file means no reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-hb-'))
    expect(worksourceHeartbeatAgeMsAt(root)).toBeNull()
    expect(worksourceReaderAliveAt(root)).toBe(false)
  })

  it('a fresh heartbeat means a reader is draining the queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-hb-'))
    writeFileSync(join(root, WORKSOURCE_HEARTBEAT_FILE), '{}')
    expect(worksourceReaderAliveAt(root)).toBe(true)
  })

  it('a stale heartbeat is treated as a dead reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-hb-'))
    const file = join(root, WORKSOURCE_HEARTBEAT_FILE)
    writeFileSync(file, '{}')
    const old = (Date.now() - WORKSOURCE_HEARTBEAT_STALE_MS - 5_000) / 1000
    utimesSync(file, old, old)
    expect(worksourceReaderAliveAt(root)).toBe(false)
  })
})
