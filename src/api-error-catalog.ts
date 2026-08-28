// Canonical error token registry. All routes MUST use these values in the
// `error` field. The openapi.yaml enum is generated from this file via
// `npm run generate:error-schema`.
export const ERROR_TOKENS = [
  'not_found',
  'required',
  'invalid_value',
  'forbidden',
  'unauthorized',
  'conflict',
  'limit_exceeded',
  'internal_error',
  'parse_error',
  'not_supported',
  'timeout',
  'disabled',
  'managed_settings_missing',
  'upstream_error',
  // Domain tokens (canonicalized; a distinct token is justified):
  'sender_not_in_allowlist', // not forbidden: actionable differently -- add to allowlist vs acquire permission
  'federation_disabled',     // not not_supported: actionable differently -- admin enable vs API version change
  'unknown_query_parameter', // not invalid_value: parameter NAME unknown (remove/rename), vs VALUE wrong (fix value)
] as const

export type ErrorToken = typeof ERROR_TOKENS[number]

export const VALID_TOKENS = new Set<string>(ERROR_TOKENS)

// Allowed (status, token) pairings. A token NOT listed for a given status is
// a violation. Statuses not listed here are unconstrained (pass-through).
export const ALLOWED_STATUS_TOKENS: Record<number, ReadonlyArray<ErrorToken>> = {
  400: [
    'required', 'invalid_value', 'parse_error', 'not_supported',
    'managed_settings_missing', 'not_found', 'unknown_query_parameter',
    'federation_disabled',
  ],
  401: ['unauthorized'],
  403: ['forbidden', 'sender_not_in_allowlist'],
  404: ['not_found'],
  // disabled = operation-state conflict (entity exists but is in disabled state);
  // same pattern as conflict (running operation on a non-running agent).
  409: ['conflict', 'disabled'],
  429: ['limit_exceeded'],
  500: ['internal_error'],
  502: ['upstream_error'],
  408: ['timeout'],
  503: ['timeout', 'upstream_error'],
}

// Returns null if valid, or a violation string if not.
export function checkErrorResponse(
  token: string,
  status: number,
): string | null {
  if (!VALID_TOKENS.has(token)) {
    return `unknown error token: '${token}'`
  }
  const allowed = ALLOWED_STATUS_TOKENS[status]
  if (allowed && !allowed.includes(token as ErrorToken)) {
    return `token '${token}' is not allowed with HTTP ${status} ` +
           `(allowed: ${allowed.join(', ')})`
  }
  return null
}
