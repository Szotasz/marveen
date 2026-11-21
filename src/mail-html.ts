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

/**
 * The images the signature references as cid:<cid>, read from the install's
 * signature folder (store/email-signature/images.json), so no install's own
 * names live in the shared code:
 *   [{"cid": "logo", "file": "logo.png", "contentType": "image/png"}]
 * No manifest means no inline images. A manifest that does not parse, or an
 * entry that is not a plain file name in that folder, is refused: a signed
 * letter must not go out half-built. Pure, so the rules are tested.
 */
export interface SignatureImage {
  cid: string
  file: string
  contentType: string
}

export function parseSignatureImages(json: string | null): SignatureImage[] {
  if (json === null) return []
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    throw new Error('mail-html: images.json is not valid JSON')
  }
  if (!Array.isArray(list)) throw new Error('mail-html: images.json must be an array')
  return list.map((e, i) => {
    const { cid, file, contentType } = (e ?? {}) as Record<string, unknown>
    const ok = (v: unknown) => typeof v === 'string' && v.trim() !== ''
    if (!ok(cid) || !ok(file) || !ok(contentType)) {
      throw new Error(`mail-html: images.json entry ${i} needs cid, file and contentType`)
    }
    if (/[\\/]/.test(file as string) || file === '.' || file === '..') {
      throw new Error(`mail-html: images.json entry ${i}: file must be a plain name in the signature folder`)
    }
    return { cid: cid as string, file: file as string, contentType: contentType as string }
  })
}
