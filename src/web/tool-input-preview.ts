// APRO920 (b): the token-usage log's Bash rows say only "Bash" -- no command,
// no path, nothing to tell one Bash call apart from another. The tool-log-capture
// hook (scripts/hooks/tool-log-capture.py, _input_summary/_redact) already solves
// this for /api/tool-log, with secret-redaction the token-usage path needs too.
// This is a byte-for-byte port of that logic to TS, so token-usage.ts's transcript
// parser (which never sees the Python hook) can build the same preview. The
// Python source stays the norm (spec 8. döntés): keep the two in parity, verified
// by tool-input-preview-parity.test.ts running python3 on the SAME fixture.

// Patterns that could reveal secrets if stored verbatim. Mirrors
// tool-log-capture.py's _SECRET_PATTERNS exactly (TOOLLOGREDACT924, #1536 --
// the Python stays the norm; order matters: each pattern runs in sequence over
// the progressively-redacted text). See the Python for the why of each one.
// Each entry: the pattern, and whether it has a leading label capture group
// to preserve (group 1) -- mirrors Python's `pat.groups` check.
const SECRET_PATTERNS: Array<{ re: RegExp; hasGroup: boolean }> = [
  // Bearer / Basic authorization values
  { re: /(\b(?:bearer|basic)\s+)[A-Za-z0-9+/=_\-.]{8,}/gi, hasGroup: true },
  // Credentials embedded in a URL: https://user:pass@host and https://token@host
  { re: /(\bhttps?:\/\/)(?!\$)[^/\s:@]+:[^/\s@]+(?=@)/gi, hasGroup: true },
  { re: /(\bhttps?:\/\/)[A-Za-z0-9_\-]{20,}(?=@)/gi, hasGroup: true },
  // Spaced or = flags: --token X, --password 'X', --api-key=X ...
  { re: /(--(?:token|password|passwd|api-key|apikey|access-token|auth-token|secret)(?:\s+|=)['"]?)(?!\$)[^\s'"]{6,}/gi, hasGroup: true },
  // key=value / key: value, the value quoted or not, the key any name ending in a secret word
  { re: /(\b\w*(?:token|secret|passw(?:or)?d|api[_\-]?key|apikey|auth|credential|_key)['"]?\s*[=:]\s*['"]?)(?!\$)[^\s,'";&|]{6,}/gi, hasGroup: true },
  // Known token prefixes (the prefix is kept as the label)
  { re: /\b(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sbp_|sk-ant-|sk-|xoxb-|xoxp-|xapp-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_)[A-Za-z0-9_\-]{10,}/g, hasGroup: true },
  // Telegram bot token (<bot id>:<secret>), bare or inside an api.telegram.org URL
  { re: /(\b(?:bot)?\d{6,12}:)[A-Za-z0-9_\-]{30,}/g, hasGroup: true },
  // AWS access key id
  { re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, hasGroup: true },
  // A password given inline to a tool that takes it as -p (sshpass -p X, mysql -pX)
  { re: /(\bsshpass\s+-p\s*)(?:'[^']*'|"(?!\$)[^"]*"|(?!\$)[^\s'"]+)/g, hasGroup: true },
  { re: /(\b(?:mysql|mysqldump|mariadb)\b[^|;&\n]*?\s-p['"]?)(?!\$)[^\s'"]{4,}/g, hasGroup: true },
  // A JWT anywhere (header.payload.signature) -- no capture group
  { re: /\beyJ[\w\-]{8,}\.eyJ[\w\-]{8,}\.[\w\-]{8,}/g, hasGroup: false },
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
