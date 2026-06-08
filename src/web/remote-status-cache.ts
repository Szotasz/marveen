// Short-TTL cache for remote-agent status so the synchronous dashboard
// endpoints (`/api/agents`, polled on load; `/api/agents/activity`, polled every
// 3s) do not issue a fresh blocking ssh call on every request. A remote ssh
// round-trip against a sleeping laptop can take up to the ConnectTimeout/
// ServerAlive bound (~5s), and Node's event loop is single-threaded, so an
// uncached call would freeze the dashboard for ALL agents (local included).
//
// With a few-second TTL each remote agent is probed at most once per window;
// every other poll reads the cache and returns instantly. NOTE: the miss path
// fetches SYNCHRONOUSLY -- a cold miss against a sleeping laptop blocks that one
// request for the full ssh timeout (~5-8s). The TTL bounds this to once per
// window per agent (the dominant fix), so the dashboard is not frozen on every
// poll, but it is not non-blocking. A throwing fetch (host unreachable) never
// escapes: the last-known value is returned if we have one, otherwise the
// caller-supplied fallback. Local agents are never cached -- their tmux calls
// are sub-millisecond, so they always fetch fresh.
//
// (Fully async/non-blocking refresh via child_process.spawn is a deferred idea.)
export class RemoteStatusCache<T> {
  private store = new Map<string, { value: T; at: number }>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Return a fresh-enough cached value, or call `fetch()` once, cache, and
   * return it. If `fetch` throws, return the last-known value when present, else
   * `fallback` (when provided) -- the error never propagates to the HTTP layer.
   */
  getOrRefresh(key: string, nowMs: number, fetch: () => T, fallback?: T): T {
    const entry = this.store.get(key)
    if (entry && nowMs - entry.at < this.ttlMs) return entry.value
    try {
      const value = fetch()
      this.store.set(key, { value, at: nowMs })
      return value
    } catch {
      if (entry) return entry.value
      return fallback as T
    }
  }

  /** Drop a key (e.g. when an agent is deleted or its remote config cleared). */
  invalidate(key: string): void {
    this.store.delete(key)
  }
}
