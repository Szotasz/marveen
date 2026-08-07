// Which machines are actually there, right now.
//
// Both GPU hosts are Windows boxes that sleep and update, and both firewall
// ICMP -- ping proves nothing, so the ollama API is the only honest signal
// (measured, plan section 2). air903max answers on two addresses; the prober
// takes the first that responds and remembers it, so a request does not pay
// for the dead one every time.
//
// The result is cached briefly. Not for speed: without a cache a burst of
// requests would each open its own probe, and a sleeping machine would collect
// a queue of four-second timeouts.

export interface ProbeResult {
  up: boolean
  address: string | null
  /** Only set when the probe failed, and said in words for the status page. */
  detail?: string
}

export const PROBE_TIMEOUT_MS = 4_000
export const HEALTH_TTL_MS = 15_000

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>

/**
 * Probe one host's addresses in order, first answer wins.
 *
 * A timeout and a refused connection are the same thing to the caller -- the
 * machine cannot serve -- but the detail says which, because "asleep" and
 * "ollama not running" have different fixes.
 */
export async function probeHost(
  addresses: string[],
  { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS }: { fetchImpl: FetchLike; timeoutMs?: number },
): Promise<ProbeResult> {
  const failures: string[] = []

  for (const address of addresses) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${address}/api/version`, { signal: controller.signal })
      if (res.ok) return { up: true, address }
      failures.push(`${address}: HTTP error`)
    } catch (err) {
      failures.push(`${address}: ${(err as Error).name === 'AbortError' ? 'timeout' : 'unreachable'}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return { up: false, address: null, detail: failures.join('; ') }
}

/**
 * A tiny cache in front of probeHost.
 *
 * `now` is injected so the expiry is testable without waiting fifteen seconds,
 * which is the sort of test that gets deleted for being slow.
 */
export function createHealthCache({
  fetchImpl,
  ttlMs = HEALTH_TTL_MS,
  now = () => Date.now(),
}: {
  fetchImpl: FetchLike
  ttlMs?: number
  now?: () => number
}) {
  const cache = new Map<string, { at: number; result: ProbeResult }>()
  const inFlight = new Map<string, Promise<ProbeResult>>()

  return {
    async get(host: string, addresses: string[]): Promise<ProbeResult> {
      const hit = cache.get(host)
      if (hit && now() - hit.at < ttlMs) return hit.result

      // One probe per host at a time: a burst must not turn into a burst of
      // four-second timeouts against a sleeping machine.
      const running = inFlight.get(host)
      if (running) return running

      const probe = probeHost(addresses, { fetchImpl })
        .then((result) => {
          cache.set(host, { at: now(), result })
          return result
        })
        .finally(() => inFlight.delete(host))

      inFlight.set(host, probe)
      return probe
    },
    /** For the status endpoint: what we last saw, without probing. */
    peek(): Record<string, ProbeResult> {
      return Object.fromEntries([...cache.entries()].map(([host, v]) => [host, v.result]))
    },
  }
}
