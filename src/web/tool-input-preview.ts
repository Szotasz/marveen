// APRO920 (b): the token-usage log's Bash rows say only "Bash" -- no command,
// no path, nothing to tell one Bash call apart from another. The tool-log-capture
// hook (scripts/hooks/tool-log-capture.py, _input_summary/_redact) already solves
// this for /api/tool-log, with secret-redaction the token-usage path needs too.
// This is a byte-for-byte port of that logic to TS, so token-usage.ts's transcript
// parser (which never sees the Python hook) can build the same preview. The
// Python source stays the norm (spec 8. döntés): keep the two in parity, verified
// by tool-input-preview-parity.test.ts running python3 on the SAME fixture.

// Patterns that could reveal secrets if stored verbatim. Mirrors
// tool-log-capture.py's _SECRET_PATTERNS exactly (order matters: each pattern
// runs in sequence over the progressively-redacted text).
// Each entry: the pattern, and whether it has a leading label capture group
// to preserve (group 1) -- mirrors Python's `pat.groups` check.
const KEY_WORDS = String.raw`(?:token|secret|passw(?:or)?d|api[_\-]?key|apikey|key|auth|credential)`
const SECRET_PATTERNS: Array<{ re: RegExp; hasGroup: boolean }> = [
  // Bearer / Authorization: Basic headers
  { re: /(bearer\s+)[A-Za-z0-9+/=_\-.]{8,}/gi, hasGroup: true },
  { re: /(authorization\s*:\s*basic\s+)[A-Za-z0-9+/=]{8,}/gi, hasGroup: true },
  // Credentials embedded in a URL: scheme://user:pass@host
  { re: /(\b[A-Za-z][A-Za-z0-9+.\-]*:\/\/)[^\s/@]+(?=@)/g, hasGroup: true },
  // JWT (header.payload.signature), wherever it stands -- no capture group
  { re: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g, hasGroup: false },
  // Quoted key=value / key: value pairs (the whole quoted value goes)
  { re: new RegExp(`(${KEY_WORDS}["']?\\s*[=:]\\s*)(?:"[^"]+"|'[^']+')`, 'gi'), hasGroup: true },
  // Generic unquoted key=value / key: value pairs (not one already redacted)
  { re: new RegExp(`(${KEY_WORDS}["']?\\s*[=:]\\s*)(?!\\[REDACTED\\])[^\\s,'";&|]{6,}`, 'gi'), hasGroup: true },
  // Space-separated secret flags: --token X, --api-key "X", --github-token X
  { re: /(--[A-Za-z0-9\-]*(?:token|secret|passw(?:or)?d|api-?key|key)\s+)(?:"[^"]+"|'[^']+'|[^\s'";&|]+)/gi, hasGroup: true },
  // -p <password> only for the clients where -p IS the password (not mkdir -p)
  { re: /(\b(?:mysql|mysqldump|mysqladmin|mariadb|sshpass)\b[^\n|;&]*?\s-p\s*)(?:"[^"]+"|'[^']+'|[^\s'";&|]+)/g, hasGroup: true },
  // GitHub/Anthropic/OpenAI/Slack/Supabase style tokens
  { re: /\b(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-|sk-ant-|xoxb-|xoxp-|sbp_)[A-Za-z0-9_-]{10,}/g, hasGroup: true },
  // Raw hex blobs >= 32 chars (likely hashed secrets) -- no capture group, full match replaced
  { re: /\b[0-9a-fA-F]{32,}\b/g, hasGroup: false },
]

/** Replace potential secret values with [REDACTED]. Mirrors _redact(). */
export function redact(text: string): string {
  for (const { re, hasGroup } of SECRET_PATTERNS) {
    text = text.replace(re, (match, g1) => (hasGroup && typeof g1 === 'string' ? g1 : '') + '[REDACTED]')
  }
  return text
}

/**
 * Build a short human-readable summary of a tool call's input, secrets
 * redacted. Mirrors _input_summary(tool_input, tool_name) exactly, including
 * its per-tool-family branches and truncation lengths (400 then 200 chars).
 */
export function toolInputPreview(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

  if (toolName === 'Bash' || toolName === 'bash') {
    return redact(str(obj.command).slice(0, 400)).slice(0, 200)
  }
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    return str(obj.file_path).slice(0, 200)
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const val = obj.url !== undefined ? obj.url : obj.query
    return redact(str(val).slice(0, 400)).slice(0, 200)
  }
  // Generic fallback: first string value found (insertion order, like Python dict).
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') {
      return redact(v.slice(0, 400)).slice(0, 200)
    }
  }
  return ''
}
