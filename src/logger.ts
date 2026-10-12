import pino from 'pino'

// Every pretty line carries the full local date, not just the time of day
// (LOGDATUM916, 2026-09-16). pino-pretty's default is `HH:MM:ss.l`, and the
// dashboard.log is size-rotated (20 MB, weeks per generation), so one file
// spans many days: a bare-time WARN could not be tied to a day, and the pid
// prefix cannot disambiguate either, because pids are reused across restarts
// in the container. `SYS:standard` = `yyyy-mm-dd HH:MM:ss.l o` in the host's
// time zone, i.e. the offset is on the line too.
export const PRETTY_OPTIONS = { colorize: true, translateTime: 'SYS:standard' } as const

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: PRETTY_OPTIONS }
      : undefined,
})
