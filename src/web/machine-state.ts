// Machine state for the event-loop-lag WARN line: CPU busy fraction, memory headroom, swap
// use, PSI pressure and the top-RSS process, read from /proc at the moment the loop was
// found blocked. When the dashboard is wedged the first question is "was the box the
// problem, or the code?" -- these numbers answer it right in the log line.
//
// Layout: every parser is PURE (string in -> value out, no fs) so tests can pin them with
// literal fixtures; readMachineState() is the single synchronous-IO wrapper. The reads run
// once per blocked 30s window only -- the statm scan is a few hundred microsecond-scale
// reads, acceptable there -- and never touch the healthy (non-blocked) path.
import { readFileSync, readdirSync } from 'node:fs'
import * as os from 'node:os'

// Aggregated jiffies of the `cpu ` line of /proc/stat: total = all fields, idleAll =
// idle + iowait (the buckets that mean "the CPU did nothing").
export interface CpuSnapshot { total: number; idleAll: number }

// Page size for the resident-pages -> MB conversion. os.pageSize() is newer than the
// oldest Node this runs on (absent on 22.x builds), so use it when present and fall back
// to 4096 -- the page size on every platform this dashboard ships to.
function pageSizeBytes(): number {
  const withPageSize = os as typeof os & { pageSize?: () => number }
  return typeof withPageSize.pageSize === 'function' ? withPageSize.pageSize() : 4096
}

// Parse the first line of /proc/stat (`cpu  user nice system idle iowait irq softirq
// steal guest guest_nice`, at least 5 numeric fields). The first token must be exactly
// `cpu` (not `cpu0`); any non-numeric token or a short line -> null. The total counts
// the first 8 fields only (user..steal): per proc(5), guest and guest_nice are already
// included in user and nice, so summing all fields would double-count guest time and
// skew busyFrac on hosts running virtual machines.
export function parseStatTotalLine(line: string): CpuSnapshot | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens[0] !== 'cpu') return null
  const fields = tokens.slice(1).map(Number)
  if (fields.length < 5 || fields.some((v) => !Number.isFinite(v))) return null
  const total = fields.slice(0, 8).reduce((sum, v) => sum + v, 0)
  const idleAll = fields[3] + fields[4]
  return { total, idleAll }
}

// Busy fraction between two snapshots: 1 - dIdle/dTotal, rounded to 3 decimals. null when
// the delta is unusable (no baseline, no movement, or an impossible idle delta -- the
// counters are /proc and best-effort, never trusted enough to produce a bogus number).
export function computeBusyFrac(prev: CpuSnapshot | null, cur: CpuSnapshot | null): number | null {
  if (prev === null || cur === null) return null
  const dTotal = cur.total - prev.total
  const dIdle = cur.idleAll - prev.idleAll
  if (dTotal <= 0 || dIdle < 0 || dIdle > dTotal) return null
  return Math.round((1 - dIdle / dTotal) * 1000) / 1000
}

// Parse /proc/meminfo (kB values -> MB, rounded). meminfo has no SwapUsed key: swap in use
// is SwapTotal - SwapFree (SwapCached is kernel bookkeeping, not usage). A missing or
// non-finite key -> null for just that field.
export function parseMeminfo(text: string): { memAvailableMB: number | null; swapUsedMB: number | null } {
  const kb = new Map<string, number>()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const key = parts[0].endsWith(':') ? parts[0].slice(0, -1) : parts[0]
    const v = Number(parts[1])
    if (Number.isFinite(v)) kb.set(key, v)
  }
  const memAvailable = kb.get('MemAvailable')
  const swapTotal = kb.get('SwapTotal')
  const swapFree = kb.get('SwapFree')
  return {
    memAvailableMB: memAvailable === undefined ? null : Math.round(memAvailable / 1024),
    swapUsedMB: swapTotal === undefined || swapFree === undefined
      ? null
      : Math.round((swapTotal - swapFree) / 1024),
  }
}

// Parse ONE /proc/pressure/{memory,cpu} file: the float after avg10= on the `some ` line
// (the "some" line is the stalled-some-tasks pressure over the last 10s; the `full ` line
// is a different, stricter signal). Missing line, missing avg10= or NaN -> null.
export function parsePressureSomeAvg10(text: string): number | null {
  for (const line of text.split('\n')) {
    if (!/^some\b/.test(line)) continue
    const m = /avg10=(\S+)/.exec(line)
    if (!m) return null
    const v = Number(m[1])
    return Number.isFinite(v) ? v : null
  }
  return null
}

// The entry with the most resident pages; empty input -> null.
export function findTopRss(entries: Array<{ pid: number; residentPages: number }>): { pid: number; residentPages: number } | null {
  let best: { pid: number; residentPages: number } | null = null
  for (const e of entries) {
    if (best === null || e.residentPages > best.residentPages) best = e
  }
  return best
}

export interface MachineState {
  busyFrac: number | null
  memAvailableMB: number | null
  swapUsedMB: number | null
  psiMemSome10: number | null
  psiCpuSome10: number | null
  topRssPid: number | null
  topRssRssMB: number | null
  topRssComm: string | null
}

// A reader turns the previous CPU snapshot into the current machine state plus the fresh
// snapshot (returned as `cpu` so the caller can chain the next call). Injectable so the
// monitor's tests can drive it with fakes.
export type MachineStateReader = (prevCpu: CpuSnapshot | null) => MachineState & { cpu: CpuSnapshot | null }

// The ONLY function here doing IO, all synchronous (it runs once per blocked 30s window).
// It NEVER throws: each section has its own try/catch and on error the corresponding
// fields stay null -- observability must not turn a warn into a crash.
export function readMachineState(prevCpu: CpuSnapshot | null): MachineState & { cpu: CpuSnapshot | null } {
  const st: MachineState & { cpu: CpuSnapshot | null } = {
    busyFrac: null,
    memAvailableMB: null,
    swapUsedMB: null,
    psiMemSome10: null,
    psiCpuSome10: null,
    topRssPid: null,
    topRssRssMB: null,
    topRssComm: null,
    cpu: null,
  }
  // CPU: first line of /proc/stat; busyFrac needs the previous window's snapshot.
  try {
    const firstLine = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0] ?? ''
    st.cpu = parseStatTotalLine(firstLine)
    st.busyFrac = computeBusyFrac(prevCpu, st.cpu)
  } catch { /* /proc unreadable: cpu/busyFrac stay null */ }
  // Memory: available headroom and swap in use.
  try {
    const { memAvailableMB, swapUsedMB } = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))
    st.memAvailableMB = memAvailableMB
    st.swapUsedMB = swapUsedMB
  } catch { /* meminfo unreadable: fields stay null */ }
  // PSI: an older kernel without /proc/pressure throws ENOENT -- caught, fields null.
  try {
    st.psiMemSome10 = parsePressureSomeAvg10(readFileSync('/proc/pressure/memory', 'utf8'))
  } catch { /* no /proc/pressure/memory: null */ }
  try {
    st.psiCpuSome10 = parsePressureSomeAvg10(readFileSync('/proc/pressure/cpu', 'utf8'))
  } catch { /* no /proc/pressure/cpu: null */ }
  // Top-RSS process: scan the numeric /proc entries, read each statm's resident field.
  // Pids die mid-scan: a per-pid failure skips that pid, never the section.
  try {
    const entries: Array<{ pid: number; residentPages: number }> = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      try {
        const statm = readFileSync(`/proc/${pid}/statm`, 'utf8')
        const residentPages = Number(statm.trim().split(/\s+/)[1])
        if (Number.isFinite(residentPages)) entries.push({ pid, residentPages })
      } catch { /* pid vanished mid-scan: skip it */ }
    }
    const top = findTopRss(entries)
    if (top) {
      st.topRssPid = top.pid
      st.topRssRssMB = Math.round((top.residentPages * pageSizeBytes()) / (1024 * 1024))
      try { st.topRssComm = readFileSync(`/proc/${top.pid}/comm`, 'utf8').trim() } catch { /* comm unreadable: keep pid/rss */ }
    }
  } catch { /* /proc unlistable: top-RSS fields stay null */ }
  return st
}
