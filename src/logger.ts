import pino from 'pino'

// Every pretty line carries the full local date, not just the time of day
// (LOGDATUM916, 2026-09-16). pino-pretty's default is `HH:MM:ss.l`, and the
// dashboard.log is size-rotated (20 MB, weeks per generation), so one file
// spans many days: a bare-time WARN could not be tied to a day, and the pid
// prefix cannot disambiguate either, because pids are reused across restarts
// in the container. `SYS:standard` = `yyyy-mm-dd HH:MM:ss.l o` in the host's
// time zone, i.e. the offset is on the line too.
export const PRETTY_OPTIONS = { colorize: true, translateTime: 'SYS:standard' } as const

// --- token redaction (pino layer) ---
//
// Secrets reach the structured log two ways: as OBJECT fields (an auth
// header or an `apiKey` field is logged verbatim) and as FREE TEXT (a URL
// with a `?token=` query, or an error message embedding a bearer token) --
// and free text also sits INSIDE object values, child bindings and Error
// fields. The tool-capture hook redacts its own transcript, but nothing under
// src/ redacted these paths, so dashboard.log kept the tokens. Three layers:
//
//  1. pino's built-in `redact` for known FIELD NAMES -- this is what pino
//     itself does before serialization, so it covers the object form.
//  2. `redactLogMessage` for free text, applied to the FINAL message (after the
//     %s/%j placeholders are filled, so a secret passed as a format argument is
//     seen) through `hooks.logMethod`.
//  3. `formatters.log` walks the final log object (and a `child` wrapper the child
//     bindings) and runs `redactLogMessage` over every string value, nested
//     objects and arrays included; Errors are copied with message, stack, cause
//     and AggregateError.errors masked (same prototype and extra fields).
//
// No external dependency: all layers are plain regex/paths in this file.
//
// Known limits (a redactor is a safety net, not a guarantee; keep secrets out of log calls):
//  - Free text is matched by shape and by an explicit name list. Other token shapes (cloud access keys, Slack/Stripe/npm
//    tokens, Google API keys) and other Authorization schemes (Digest, Negotiate, AWS4-HMAC) are not recognised; `Basic`
//    is masked only in the `Authorization: Basic <base64>` header shape.
//  - A `name=value` value stops at whitespace, `&` `#` quotes, brackets, comma and semicolon, so a password containing
//    one of those is masked only up to it.
//  - The object walk covers plain objects, arrays and Errors (message, stack, cause, AggregateError.errors, own
//    fields). Class instances (URL, Map, Set, ...) are left to pino; a secret inside one is not found.
//  - %o / %O / %j arguments are masked as the text they are formatted into, not by field name.
//  - A %j / %o argument that JSON.stringify cannot handle (a circular value, a BigInt, a toJSON that throws) is logged as
//    "[Circular]" for the whole argument. Plain pino uses safe-stable-stringify there and would print the value with only
//    the cycle marked, a BigInt as a number, or its own "unable to serialize" text. Nothing leaks; the line is less detailed.
//  - The object walk stops at 10 levels: an object nested deeper is logged as the marker "[MaxDepth]" instead of its
//    content (a secret there cannot leak, but the content is not logged either).
//  - Bindings added later with setBindings() are not masked (child() bindings are).
//  - A secret split across several log calls, or hidden in an encoding other than plain text, is not recognised.

export const REDACTED = '[REDACTED]'

// Field paths pino masks. `paths` are dotted (object form, e.g. the
// `req` object of an incoming request); the bare names match top-level
// fields, `*.name` matches the same field one level down (`{ cfg: { token } }`).
// pino path keys are case-sensitive, so the capitalised header spelling is listed too.
// Deeper nesting of free text is covered by layer 3.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'headers.authorization',
  'headers.Authorization',
  'authorization',
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'refreshToken',
  '*.authorization',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.accessToken',
  '*.refreshToken',
]

// The parameter / field names whose value is a secret. An EXPLICIT list (case-insensitive), not a pattern: it keeps
// `max_tokens`, `next_page_token` and `tokenizer` untouched.
// One literal array: the regex alternation and the key-name set below are both built from it, so they cannot drift apart.
// Every entry is lowercase [a-z0-9_] (a test holds this), which is why it can go into a regex unescaped.
export const SECRET_NAMES = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'password',
  'secret',
  'client_secret',
  'authorization',
] as const
const SECRET_NAMES_RX = SECRET_NAMES.join('|')
// A value stops at whitespace, a query/fragment delimiter, a quote, a bracket, a comma or a semicolon.
const PARAM_RX = new RegExp(`(?<![A-Za-z0-9_])(${SECRET_NAMES_RX})=[^\\s&#"'<>,;()\\[\\]{}]+`, 'gi')
const JSON_FIELD_RX = new RegExp(`("(?:${SECRET_NAMES_RX})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, 'gi')

/**
 * Masks free-text secrets in a log message string. Replaces, in order:
 *  - `Bearer <token>` (any case; a token is at least 16 characters of the token alphabet, separated by
 *    horizontal whitespace; shorter words such as "Bearer token" are prose and stay)
 *  - `Authorization: Basic <base64>` (the header shape only; the bare word "Basic" is prose)
 *  - `name=value` for the names token, access_token, refresh_token, id_token, api_key, apikey, password,
 *    secret, client_secret, authorization (a value runs to the next whitespace, `&`, `#`, quote, bracket,
 *    comma or semicolon; `max_tokens=`, `next_page_token=` and a bare `token=` with no value stay)
 *  - the same names as JSON string fields: `"token":"..."`
 *  - known token SHAPES even when unadorned: `sk-ant-...`, GitHub (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`,
 *    `github_pat_...`), a Telegram bot token (`123456789:AA...`), a JWT (`eyJ...`.`...`.`...`)
 * Unmatched text is returned byte-for-byte unchanged.
 */
export function redactLogMessage(msg: string): string {
  if (typeof msg !== 'string' || msg === '') return msg
  let out = msg
  // `Bearer <value>` -- the keyword is kept as typed (so the line still reads "Bearer [REDACTED]").
  out = out.replace(/\b(Bearer)[ \t]+[A-Za-z0-9\-._~+/]{16,}=*/gi, (_m, kw: string) => `${kw} ${REDACTED}`)
  // `Authorization: Basic <base64>` -- header shape only.
  out = out.replace(/\b(Authorization[ \t]*[:=][ \t]*Basic)[ \t]+[A-Za-z0-9+/_-]{8,}=*/gi, (_m, head: string) => `${head} ${REDACTED}`)
  out = out.replace(PARAM_RX, (_m, name: string) => `${name}=${REDACTED}`)
  out = out.replace(JSON_FIELD_RX, `$1${REDACTED}$2`)
  // Known token shapes, unadorned. `gh[pousr]_` covers ghp_ (personal), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server), ghr_ (refresh); `gh_` itself is not a token prefix and does not match.
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED)
  out = out.replace(/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED)
  out = out.replace(/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, REDACTED)
  // Telegram bot token: 8-10 digits, a colon, 35 token characters (also inside `.../bot<token>/sendMessage`).
  out = out.replace(/(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, REDACTED)
  // JWT: three base64url segments, the first starting with the `{"` header prefix `eyJ`.
  out = out.replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, REDACTED)
  return out
}

const MAX_DEPTH = 10

// A field whose NAME is a secret name has its value masked at any depth (token, accessToken, access_token, api-key,
// clientSecret, ... all normalise to the same key), whatever the value looks like.
const SECRET_KEY_SET = new Set(SECRET_NAMES.map((n) => n.replace(/[_-]/g, '')))
function isSecretKey(key: string | symbol): boolean {
  return typeof key === 'string' && SECRET_KEY_SET.has(key.toLowerCase().replace(/[_-]/g, ''))
}
function maskByKey(key: string | symbol, value: unknown): unknown | undefined {
  return isSecretKey(key) && value !== undefined && value !== null ? REDACTED : undefined
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function redactValue(v: unknown, path: Set<object>, depth: number): unknown {
  if (typeof v === 'string') return redactLogMessage(v)
  if (v === null || typeof v !== 'object') return v
  if (path.has(v)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  path.add(v)
  try {
    if (v instanceof Error) return maskError(v, path, depth)
    if (Array.isArray(v)) return v.map((x) => redactValue(x, path, depth + 1))
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v)) {
        const val = (v as Record<string, unknown>)[k]
        out[k] = maskByKey(k, val) ?? redactValue(val, path, depth + 1)
      }
      return out
    }
    return v // Date, Buffer, Map, class instances: left to pino
  } finally {
    path.delete(v)
  }
}

/**
 * A masked COPY of an Error: same prototype (so `instanceof TypeError` and the err serializer keep working), every own
 * property copied (message and stack masked; `cause`, AggregateError `errors` and extra fields such as `code` masked
 * recursively). The original is never touched.
 */
export function maskError(err: Error, path: Set<object> = new Set(), depth = 0): Error {
  const copy = Object.create(Object.getPrototypeOf(err)) as Error
  for (const key of Reflect.ownKeys(err)) {
    const d = Object.getOwnPropertyDescriptor(err, key)
    if (!d) continue
    // Read through the original (V8 keeps `stack` as an accessor bound to the error, so copying the descriptor
    // would copy a getter that answers undefined on the copy) and store a plain data property.
    const raw = Reflect.get(err, key, err)
    const value = maskByKey(key, raw) ?? redactValue(raw, path, depth + 1)
    Object.defineProperty(copy, key, { value, writable: true, enumerable: d.enumerable, configurable: true })
  }
  return copy
}

/** The final log object / child bindings with every string value masked (a copy). */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  return redactValue(obj, new Set(), 0) as Record<string, unknown>
}

// pino's own message formatter (quick-format-unescaped 4.x, MIT, as pino calls it for a string message): %s %d %f %i %j %o %O
// and %%, extra arguments beyond the placeholders are dropped, a placeholder with no usable argument is left as it is.
// Ported so the message can be FORMATTED first and masked afterwards without changing what pino would have logged.
function stringifyForFormat(o: unknown): string {
  try { return JSON.stringify(o) } catch { return '"[Circular]"' }
}
export function formatLikePino(f: string, args: unknown[]): string {
  const argLen = args.length
  if (argLen === 0) return f
  let str = ''
  let a = 0
  let lastPos = -1
  const flen = f.length
  for (let i = 0; i < flen;) {
    if (f.charCodeAt(i) === 37 && i + 1 < flen) {
      lastPos = lastPos > -1 ? lastPos : 0
      switch (f.charCodeAt(i + 1)) {
        case 100: // d
        case 102: // f
          if (a >= argLen) break
          if (args[a] == null) break
          if (lastPos < i) str += f.slice(lastPos, i)
          str += Number(args[a])
          lastPos = i + 2
          i++
          break
        case 105: // i
          if (a >= argLen) break
          if (args[a] == null) break
          if (lastPos < i) str += f.slice(lastPos, i)
          str += Math.floor(Number(args[a]))
          lastPos = i + 2
          i++
          break
        case 79: // O
        case 111: // o
        case 106: // j
          if (a >= argLen) break
          if (args[a] === undefined) break
          if (lastPos < i) str += f.slice(lastPos, i)
          if (typeof args[a] === 'string') {
            str += "'" + (args[a] as string) + "'"
          } else if (typeof args[a] === 'function') {
            str += (args[a] as { name?: string }).name || '<anonymous>'
          } else {
            str += stringifyForFormat(args[a])
          }
          lastPos = i + 2
          i++
          break
        case 115: // s
          if (a >= argLen) break
          if (lastPos < i) str += f.slice(lastPos, i)
          str += String(args[a])
          lastPos = i + 2
          i++
          break
        case 37: // %
          if (lastPos < i) str += f.slice(lastPos, i)
          str += '%'
          lastPos = i + 2
          i++
          a--
          break
      }
      ++a
    }
    ++i
  }
  if (lastPos === -1) return f
  if (lastPos < flen) str += f.slice(lastPos)
  return str
}

// Layer 2 is pino's own `hooks.logMethod`: it runs for EVERY call shape --
// (msg), (obj, msg), (obj, msg, ...formatArgs) -- and for child loggers too,
// so no call site changes and no method is overwritten by hand. The message
// is first FORMATTED the way pino formats it (the %s/%j placeholders filled, extra arguments dropped as pino drops
// them) and only then masked as ONE string: masking the template and the arguments separately would shift the
// placeholders and could leak (`'token=%s user=%s'` with a secret and a name). An Error as the first argument becomes
// a masked copy; `{ err }` with no message (no message argument and no `msg` field) gets the masked err.message as its message
// (pino would take the raw one).
export const LOG_HOOKS: NonNullable<pino.LoggerOptions['hooks']> = {
  logMethod(inputArgs, method) {
    const args = [...inputArgs] as unknown[]
    const first = args[0]
    const hasObject = args.length > 0 && typeof first !== 'string'
    if (hasObject && first instanceof Error) args[0] = maskError(first)
    const mi = hasObject ? 1 : 0
    if (typeof args[mi] === 'string') {
      const message = formatLikePino(args[mi] as string, args.slice(mi + 1))
      args.splice(mi, args.length - mi, redactLogMessage(message))
    } else if (hasObject && args.length === 1 && first !== null && typeof first === 'object') {
      // Plain pino takes err.message as the message only when the caller gave none: no message argument and no `msg` field.
      const o = first as { err?: unknown; msg?: unknown }
      if (o.msg === undefined && o.err instanceof Error) args.push(redactLogMessage(o.err.message))
    }
    return method.apply(this, args as unknown as Parameters<typeof method>)
  },
}

// pino resets the `bindings` formatter for a child logger, so child bindings would reach the log unmasked. The
// root logger gets a `child` that masks the bindings first; every child inherits it (a child is Object.create(parent)),
// so grandchildren are covered too.
function withMaskedBindings(root: pino.Logger): pino.Logger {
  const originalChild = root.child as unknown as (this: unknown, bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => pino.Logger
  root.child = function (this: unknown, bindings: pino.Bindings, options?: pino.ChildLoggerOptions) {
    return originalChild.call(this, redactObject(bindings), options)
  } as unknown as typeof root.child
  return root
}

/**
 * The shipped logger. Without a destination it uses the pretty transport (dev)
 * or plain stdout (production); a destination stream is for tests, which then
 * run the very same options (redact + hooks + formatters) as the singleton below.
 */
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL ?? 'info',
    // Layer 1: field-name redaction done by pino before serialization.
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    // Layer 2: the final message, on every call shape and on child loggers.
    hooks: LOG_HOOKS,
    // Layer 3: string values anywhere in the log object and in child bindings.
    formatters: {
      log: (obj) => redactObject(obj),
      bindings: (bindings) => redactObject(bindings),
    },
    // `{ err }` objects: pino's standard error serializer, with message and stack masked.
    serializers: {
      err: (e: unknown) => {
        const o = pino.stdSerializers.err(e as Error)
        if (typeof o.message === 'string') o.message = redactLogMessage(o.message)
        if (typeof o.stack === 'string') o.stack = redactLogMessage(o.stack)
        return o
      },
    },
  }
  if (destination) return withMaskedBindings(pino(options, destination))
  return withMaskedBindings(
    pino({
      ...options,
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: PRETTY_OPTIONS }
          : undefined,
    }),
  )
}

export const logger = createLogger()
