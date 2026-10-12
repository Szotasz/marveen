import { describe, it, expect } from 'vitest'
import { prettyFactory } from 'pino-pretty'
import { PRETTY_OPTIONS } from '../logger.js'

// LOGDATUM916: a dashboard.log line has to say which DAY it was written on.
// The size-rotated file spans weeks, and the pid prefix is reused across
// container restarts, so a bare `[14:45:30.920]` WARN could not be placed.
// Rendered through the real pino-pretty, not by re-reading the option string.

describe('logger pretty line format', () => {
  const render = (time: number) =>
    prettyFactory({ ...PRETTY_OPTIONS, colorize: false })(
      JSON.stringify({ level: 40, time, pid: 70, msg: 'Scheduled injection never started a turn' }) + '\n',
    )

  it('prefixes every line with the full date, time, and UTC offset', () => {
    const line = render(Date.UTC(2026, 8, 15, 12, 45, 30, 920))
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\] WARN \(70\): /)
  })

  it('tells apart the same time of day on two different days', () => {
    const day = 24 * 60 * 60 * 1000
    const t = Date.UTC(2026, 8, 15, 12, 45, 30, 920)
    const stamp = (l: string) => l.slice(0, l.indexOf(']') + 1)
    expect(stamp(render(t))).not.toEqual(stamp(render(t + day)))
  })
})
