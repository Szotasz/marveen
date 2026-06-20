// CSRF origin gate for state-changing (non-safe) HTTP requests.
//
// The dashboard's primary auth is the bearer token (see dashboard-auth.ts); this
// origin check is defence-in-depth against a malicious website the user happens
// to be visiting trying to drive the dashboard via the browser. We block writes
// whose Origin is foreign.
//
// The static allowlist (localhost / 127.0.0.1 / WEB_HOST / DASHBOARD_PUBLIC_URL)
// can't know every hostname the dashboard is reached by -- in particular a
// reverse proxy such as Tailscale Serve exposes it on `https://<machine>.<tailnet>.ts.net`.
// A request from that PWA is genuinely SAME-ORIGIN (the page and the fetch share
// the ts.net origin), so it is NOT CSRF and must be allowed. We detect that by
// comparing the Origin's host to the host the server was actually addressed by:
// the `Host` header, or `X-Forwarded-Host` when behind a proxy. A real
// cross-site attacker's Origin host matches neither, so it stays blocked.

export function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

// True when the request is same-origin: the Origin's host equals the host the
// server was reached on (Host, or the first X-Forwarded-Host hop).
export function originMatchesServedHost(
  origin: string,
  host: string | undefined,
  xForwardedHost: string | undefined,
): boolean {
  let originHost: string
  try { originHost = new URL(origin).host } catch { return false }
  if (!originHost) return false
  if (host && originHost === host) return true
  if (xForwardedHost) {
    const xf = xForwardedHost.split(',')[0]?.trim()
    if (xf && originHost === xf) return true
  }
  return false
}

// Decide whether a state-changing request must be rejected as cross-origin.
// Safe methods, requests without an Origin (many same-origin browsers omit it),
// allowlisted origins, and same-origin (served-host-matching) requests all pass.
export function isBlockedCrossOriginWrite(
  method: string,
  origin: string | undefined,
  host: string | undefined,
  xForwardedHost: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (isSafeMethod(method)) return false
  if (!origin) return false
  if (allowedOrigins.has(origin)) return false
  if (originMatchesServedHost(origin, host, xForwardedHost)) return false
  return true
}
