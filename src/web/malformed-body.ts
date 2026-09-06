/**
 * Was this thrown by a caller's broken request body, or by our own code?
 *
 * Until 2026-09-04 the dashboard's top-level catch could not tell: a POST
 * whose `content` field carried a raw newline or an unclosed quote blew up in
 * JSON.parse, and the caller got a 500 "Szerver hiba" with a log line holding
 * nothing but a character offset. Two writes were lost that way in one week
 * (a daily-log entry and a kanban POST) and neither sender could have noticed
 * -- `curl -s` exits 0 on a 500 just as happily as on a 200.
 *
 * A malformed body is a CLIENT error: 400, named route, no stack.
 */
export function isMalformedBodyError(err: unknown): boolean {
  return err instanceof SyntaxError && /JSON/i.test(String(err.message))
}
