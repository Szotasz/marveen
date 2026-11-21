import { describe, it, expect } from 'vitest'
import { escapeHtml, renderLetterHtml } from '../mail-html.js'
import { buildMessage, MAX_TOTAL_ATTACHMENT_BASE64_BYTES } from '../graph-mail.js'

const TPL = '<div style="x">{}</div>\n'
const SIG = '<table><td>old@example.com</td></table>'

describe('renderLetterHtml', () => {
  it('turns every line into a paragraph and an empty line into <br>', () => {
    const html = renderLetterHtml('Szia!\n\nMásodik sor', TPL, SIG)
    expect(html.split('\n').slice(0, 3)).toEqual([
      '<div style="x">Szia!</div>',
      '<div style="x"><br></div>',
      '<div style="x">Második sor</div>',
    ])
  })

  it('adds one spacer paragraph before the signature and ignores trailing newlines', () => {
    const html = renderLetterHtml('Köszönöm,\n\n', TPL, SIG)
    expect(html).toBe('<div style="x">Köszönöm,</div>\n<div style="x"><br></div>\n' + SIG)
  })

  it('escapes markup in the letter text', () => {
    expect(renderLetterHtml('a < b & c', TPL, SIG)).toContain('a &lt; b &amp; c')
  })

  it('keeps $&, $` and $\' in the letter text literal (no replacement patterns)', () => {
    const html = renderLetterHtml("Ár: 5 $& kedvezmény\nmásik $` sor $' vége", TPL, SIG)
    expect(html.split('\n').slice(0, 2)).toEqual([
      '<div style="x">Ár: 5 $&amp; kedvezmény</div>',
      "<div style=\"x\">másik $` sor $' vége</div>",
    ])
  })

  it('replaces the sending address in the signature only when both are given', () => {
    expect(renderLetterHtml('x', TPL, SIG, 'old@example.com', 'new@example.com')).toContain('new@example.com')
    expect(renderLetterHtml('x', TPL, SIG, 'old@example.com')).toContain('old@example.com')
  })

  it('refuses a template without a placeholder', () => {
    expect(() => renderLetterHtml('x', '<div></div>', SIG)).toThrowError(/placeholder/)
  })

  it('escapeHtml leaves quotes alone (text content, not attributes)', () => {
    expect(escapeHtml('"idézet"')).toBe('"idézet"')
  })
})

describe('buildMessage', () => {
  const img = { cid: 'vtlogo', name: 'logo.png', contentType: 'image/png', contentBytes: 'AAAA' }

  it('sends inline images as inline file attachments with their content id', () => {
    const m = buildMessage({ to: 'a@b.hu', subject: 's', body: '<p>x</p>', contentType: 'HTML', inlineImages: [img] })
    expect(m.attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'logo.png',
        contentType: 'image/png',
        contentBytes: 'AAAA',
        contentId: 'vtlogo',
        isInline: true,
      },
    ])
  })

  it('refuses inline images on a plain-text body', () => {
    expect(() => buildMessage({ to: 'a@b.hu', subject: 's', body: 'x', inlineImages: [img] })).toThrowError(/HTML/)
  })

  it('counts inline images into the attachment cap', () => {
    const big = { ...img, contentBytes: 'A'.repeat(MAX_TOTAL_ATTACHMENT_BASE64_BYTES + 1) }
    expect(() =>
      buildMessage({ to: 'a@b.hu', subject: 's', body: 'x', contentType: 'HTML', inlineImages: [big] }),
    ).toThrowError(/too large/)
  })

  it('leaves the subject out of a reply, because Graph builds the RE: subject', () => {
    expect(buildMessage({ to: 'a@b.hu', subject: 's', body: 'x', replyToId: 'id1' })).not.toHaveProperty('subject')
    expect(buildMessage({ to: 'a@b.hu', subject: 's', body: 'x' }).subject).toBe('s')
  })

  it('has no attachments key when there is nothing to attach', () => {
    expect(buildMessage({ to: 'a@b.hu', subject: 's', body: 'x' })).not.toHaveProperty('attachments')
  })
})
