/**
 * API path versioning helpers.
 *
 * Strategy (per architecture decision, 2026-08-23):
 *   - Canonical paths: /api/v1/<resource>  (e.g. /api/v1/memories)
 *   - Legacy paths:    /api/<resource>      (deprecated, kept as alias)
 *
 * The normalizePath() function strips the /v1 segment so every downstream
 * handler sees /api/<resource> regardless of which form the caller used.
 * Legacy callers receive Deprecation + Sunset response headers.
 *
 * A future /api/v2/* can be handled by adding a v2Dispatcher in web.ts and
 * routing before this normaliser runs -- the normaliser only touches v1.
 */

export const API_V1_PREFIX = '/api/v1'
export const API_PREFIX = '/api'

/** RFC 8594 Sunset date for the legacy /api/* alias. */
export const SUNSET_DATE = 'Wed, 31 Dec 2026 23:59:59 GMT'

export interface NormalizedPath {
  /** The canonical /api/<resource> path that route handlers consume. */
  path: string
  /**
   * true  -> caller used the legacy /api/<resource> form (no version prefix).
   *          Emit Deprecation + Sunset headers.
   * false -> caller used /api/v1/<resource>  (current canonical form).
   *          No deprecation headers.
   */
  deprecated: boolean
  /**
   * 'v1' when the caller supplied /api/v1/*, null for legacy /api/* calls,
   * undefined for non-API paths (static assets, federation, etc.).
   */
  apiVersion: 'v1' | null | undefined
}

/**
 * Normalise a raw request path for the versioned API.
 *
 * /api/v1/memories  -> { path: '/api/memories', deprecated: false, apiVersion: 'v1' }
 * /api/memories     -> { path: '/api/memories', deprecated: true,  apiVersion: null }
 * /static/app.js    -> { path: '/static/app.js',deprecated: false, apiVersion: undefined }
 */
export function normalizePath(rawPath: string): NormalizedPath {
  if (rawPath === API_V1_PREFIX || rawPath.startsWith(API_V1_PREFIX + '/')) {
    return {
      path: API_PREFIX + rawPath.slice(API_V1_PREFIX.length),
      deprecated: false,
      apiVersion: 'v1',
    }
  }
  if (rawPath === API_PREFIX || rawPath.startsWith(API_PREFIX + '/')) {
    return {
      path: rawPath,
      deprecated: true,
      apiVersion: null,
    }
  }
  return { path: rawPath, deprecated: false, apiVersion: undefined }
}

/**
 * Add RFC 8594 Deprecation + Sunset headers to a response that was served
 * via the legacy /api/* alias.
 *
 * Only call this AFTER writeHead / setHeader -- never after res.end().
 * Safe to call multiple times (idempotent via setHeader).
 */
export function applyDeprecationHeaders(res: { setHeader(name: string, value: string): void }): void {
  res.setHeader('Deprecation', 'true')
  res.setHeader('Sunset', SUNSET_DATE)
  res.setHeader('Link', '</api/v1>; rel="successor-version"')
}
