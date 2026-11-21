// Turn a plain-text letter into the house HTML format: every line becomes its
// own paragraph div (the owner's Outlook style, kept in
// store/email-signature/bekezdes-sablon.html), an empty line becomes a div
// holding <br>, and the graphic signature follows unchanged.
//
// The letter stays plain text up to this point on purpose: the outgoing gates
// read the text from the command line, so the HTML is built after them, not
// handed to them.

const PLACEHOLDER = '{}'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render `text` with the paragraph template and append the signature.
 * `signatureHtml` is used as-is, except that `fromOld` is replaced by
 * `fromNew` when both are given -- the signature names the sending address,
 * and the same signature file serves the old and the new mailbox.
 */
export function renderLetterHtml(
  text: string,
  paragraphTemplate: string,
  signatureHtml: string,
  fromOld?: string,
  fromNew?: string,
): string {
  const tpl = paragraphTemplate.trim()
  if (!tpl.includes(PLACEHOLDER)) {
    throw new Error(`mail-html: paragraph template has no ${PLACEHOLDER} placeholder`)
  }
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  // A function replacer, not a string: in a replacement string $&, $` and $'
  // are patterns, so a letter containing them would go out different from the
  // text the gates read and the approval binds.
  const fill = (html: string) => tpl.replace(PLACEHOLDER, () => html)
  const paragraphs = lines.map((line) => fill(line ? escapeHtml(line) : '<br>'))
  paragraphs.push(fill('<br>'))
  let signature = signatureHtml
  if (fromOld && fromNew) signature = signature.split(fromOld).join(fromNew)
  return `${paragraphs.join('\n')}\n${signature}`
}

/** The cid names the signature references, mapped to their image files. */
export const SIGNATURE_IMAGES: ReadonlyArray<{ cid: string; file: string; contentType: string }> = [
  { cid: 'vtlogo', file: 'logo.png', contentType: 'image/png' },
  { cid: 'vtfb', file: 'fb.png', contentType: 'image/png' },
  { cid: 'vtli', file: 'li.png', contentType: 'image/png' },
]
