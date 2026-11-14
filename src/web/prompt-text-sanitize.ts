// The text filter for anything that reaches an agent's prompt OUTSIDE a wrap and
// was not written by the code that types it: an owner's custom-command prompt, a
// kanban card title in the recovery brief. One deny-list, one normalisation, so
// a forged wrapper tag or message header is neutralised the same way everywhere.
//
// A leaf module on purpose (no imports): custom-commands.ts imports the process
// layer, and the process layer imports restart-recovery-brief.ts, so the brief
// could not take these from custom-commands.ts without closing an import cycle.
// Moved here unchanged from custom-commands.ts, which re-exports them.

// Wrapper markers a prompt must not carry: a forged <scheduled-task> or
// system-reminder would claim a provenance the owner's text does not have.
const WRAPPER_TAG_RX = /<\s*\/?\s*(channel|scheduled-task|trusted-peer|untrusted|system-reminder|task-notification|command-name|local-command-stdout)\b[^>]*>/gi
// Anywhere in a line, not only at its start: a mid-line `[SYSTEM-DIREKTIVA
// msg_id:5]` reads just as authoritative (#1530 review, point 3).
// Between the words of a message header ANY whitespace counts, not one literal
// space: the text is typed into the pane on one line, where a line break or a
// lone CR becomes a space (pane-text.ts), so a header written across a line
// break was no header here and became one in the pane (review of #2753).
// Both spellings of the header word take the optional federated words, and the
// second of those in both spellings too (review of #2756): the router emits only
// the unaccented ones, but a reader takes the accented ones for a header as well.
const WRAPPER_PREFIX_RX = /\[\s*((?:Uzenet|Üzenet)\s+(?:a\s+t[aá]voli\s+)?\\?@|SYSTEM-DIREKTIVA|SYSTEM\s*:|CONTEXT-GUARD)/gi
const ZERO_WIDTH_RX = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

// What the model will effectively read, so the deny-list below matches it:
// zero-width and bidi characters removed, NFKC-folded (a fullwidth ＜ is <),
// and HTML entities decoded until nothing changes (&amp;lt; is <).
export function normalizePromptText(text: string): string {
  let out = text.replace(ZERO_WIDTH_RX, '').normalize('NFKC')
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&lt;?/gi, '<').replace(/&gt;?/gi, '>').replace(/&quot;?/gi, '"').replace(/&apos;?/gi, "'").replace(/&amp;?/gi, '&')
      .replace(ZERO_WIDTH_RX, '')
      .normalize('NFKC')
    if (next === out) break
    out = next
  }
  return out
}

export function sanitizePromptText(text: string): string {
  return normalizePromptText(text).replace(WRAPPER_TAG_RX, '[stripped-tag]').replace(WRAPPER_PREFIX_RX, '(stripped-prefix: ')
}
