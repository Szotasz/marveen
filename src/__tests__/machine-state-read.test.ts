// machine-state IO: pins readMachineState's values from fixed /proc fixtures and the
// busy fraction from a previous CPU snapshot. Each failing section keeps its neighbours
// readable, vanished pids are skipped, and missing comm keeps the winning pid and RSS.
// All IO failing still returns unknown fields without throwing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  throwingPaths: new Set<string>(),
  throwReaddir: false,
  pageSize: vi.fn(() => 4096),
}))

vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    if (fake.throwingPaths.has(path) || !fake.files.has(path)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }
    return fake.files.get(path)!
  },
  readdirSync: (path: string) => {
    if (fake.throwReaddir || path !== '/proc') {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }
    return ['101', '202', '303', 'self']
  },
}))

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  return {
    ...real,
    pageSize: fake.pageSize,
    default: { ...real, pageSize: fake.pageSize },
  }
})

import { readMachineState } from '../web/machine-state.js'

const FIXTURE = new Map([
  ['/proc/stat', 'cpu  100 20 30 400 50 10 20 70 8 2\ncpu0  100 20 30 400 50 10 20 70 8 2\n'],
  ['/proc/meminfo', 'MemAvailable: 1048576 kB\nSwapTotal: 524288 kB\nSwapFree: 131072 kB\n'],
  ['/proc/pressure/memory', 'some avg10=1.25 avg60=0.50 avg120=0.25 total=12345\n'],
  ['/proc/pressure/cpu', 'some avg10=2.5 avg60=1.00 avg120=0.50 total=23456\n'],
  ['/proc/101/statm', '4096 256 0 0 0 0 0\n'],
  ['/proc/202/statm', '4096 768 0 0 0 0 0\n'],
  ['/proc/303/statm', '4096 512 0 0 0 0 0\n'],
  ['/proc/101/comm', 'small\n'],
  ['/proc/202/comm', 'largest\n'],
  ['/proc/303/comm', 'runner-up\n'],
])

const READABLE = {
  busyFrac: null,
  memAvailableMB: 1024,
  swapUsedMB: 384,
  psiMemSome10: 1.25,
  psiCpuSome10: 2.5,
  topRssPid: 202,
  topRssRssMB: 3,
  topRssComm: 'largest',
  cpu: { total: 700, idleAll: 450 },
}

describe('readMachineState (per-section IO isolation)', () => {
  beforeEach(() => {
    fake.files = new Map(FIXTURE)
    fake.throwingPaths.clear()
    fake.throwReaddir = false
    fake.pageSize.mockClear()
  })

  it('fills every field from readable files, with no busy fraction without a baseline', () => {
    expect(readMachineState(null)).toEqual(READABLE)
    expect(fake.pageSize).toHaveBeenCalledTimes(1)
  })

  it('computes busyFrac from the previous snapshot (dTotal 200, dIdle 100 -> 0.5)', () => {
    expect(readMachineState({ total: 500, idleAll: 350 })).toEqual({ ...READABLE, busyFrac: 0.5 })
  })

  it('an unreadable meminfo nulls only the memory and swap fields', () => {
    fake.throwingPaths.add('/proc/meminfo')
    expect(readMachineState(null)).toEqual({ ...READABLE, memAvailableMB: null, swapUsedMB: null })
  })

  it('unreadable memory pressure nulls only psiMemSome10', () => {
    fake.throwingPaths.add('/proc/pressure/memory')
    expect(readMachineState(null)).toEqual({ ...READABLE, psiMemSome10: null })
  })

  it('unreadable CPU pressure nulls only psiCpuSome10', () => {
    fake.throwingPaths.add('/proc/pressure/cpu')
    expect(readMachineState(null)).toEqual({ ...READABLE, psiCpuSome10: null })
  })

  it('an unlistable /proc nulls only the top-RSS fields', () => {
    fake.throwReaddir = true
    expect(readMachineState(null)).toEqual({ ...READABLE, topRssPid: null, topRssRssMB: null, topRssComm: null })
  })

  it('skips a vanished winning pid and uses the next largest process', () => {
    fake.throwingPaths.add('/proc/202/statm')
    expect(readMachineState(null)).toEqual({ ...READABLE, topRssPid: 303, topRssRssMB: 2, topRssComm: 'runner-up' })
  })

  it('an unreadable winning comm keeps its pid and RSS and all other sections', () => {
    fake.throwingPaths.add('/proc/202/comm')
    expect(readMachineState(null)).toEqual({ ...READABLE, topRssComm: null })
  })

  it('every IO read failing returns unknown fields without throwing', () => {
    fake.throwingPaths = new Set(FIXTURE.keys())
    fake.throwReaddir = true
    const { cpu, ...state } = readMachineState(null)
    expect(state).toEqual({
      busyFrac: null,
      memAvailableMB: null,
      swapUsedMB: null,
      psiMemSome10: null,
      psiCpuSome10: null,
      topRssPid: null,
      topRssRssMB: null,
      topRssComm: null,
    })
  })
})
