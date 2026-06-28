// Pure round-robin batch selector for bounding per-tick synchronous work.
//
// The channel-monitor and stuck-input watchers sweep EVERY running sub-agent
// synchronously each tick (tmux capture-pane via execFileSync, plus settle
// sleeps and Escape/Enter sends). On a large fleet (17+ agents) that pins the
// Node event loop for many seconds, so the HTTP server stops accepting and
// health probes read 000 -- the fleet's whole coordination API (inter-agent
// messages, status, schedules) stalls in those windows.
//
// Processing only a rotating BATCH of agents per tick bounds the worst-case
// block to `batchSize` agents' worth of sync work, while still covering every
// agent over a few ticks. The main channels session is always swept by the
// callers (never batched) because it is the single most critical session.
//
// Pure + deterministic so it is unit-tested in isolation; the watchers hold the
// rolling cursor in a module-level variable and feed it back each tick.
export function selectSweepBatch<T>(
  items: T[],
  cursor: number,
  batchSize: number,
): { batch: T[]; nextCursor: number } {
  const n = items.length
  if (n === 0) return { batch: [], nextCursor: 0 }
  // A non-positive budget would starve the sweep entirely; treat as "all".
  if (batchSize <= 0 || batchSize >= n) return { batch: items.slice(), nextCursor: 0 }
  const start = ((cursor % n) + n) % n
  const batch: T[] = []
  for (let i = 0; i < batchSize; i++) {
    batch.push(items[(start + i) % n])
  }
  return { batch, nextCursor: (start + batchSize) % n }
}
