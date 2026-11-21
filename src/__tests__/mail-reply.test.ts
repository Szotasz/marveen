import { describe, it, expect } from 'vitest'
import { checkReply, defaultReplyAddresses, replyParticipants, replySubject } from '../mail-reply.js'

// PR #2983 review (Dani B1): what a threaded reply may be addressed to, decided
// from the original. A pure module, so each rule is pinned without a mailbox.
const a = (address: string) => ({ emailAddress: { address } })
const ORIG = {
  subject: 'Ajanlat 23974',
  from: a('Vevo@Example.com'),
  replyTo: [a('ajanlat@example.com')],
  toRecipients: [a('me@example.net')],
  ccRecipients: [a('kolléga@example.net')],
}

describe('mail-reply', () => {
  it('participants: From, Reply-To, To and Cc, lower-cased', () => {
    expect([...replyParticipants(ORIG)].sort()).toEqual(
      ['ajanlat@example.com', 'kolléga@example.net', 'me@example.net', 'vevo@example.com'],
    )
  })
  it('Graph answers the Reply-To when there is one, else the From', () => {
    expect(defaultReplyAddresses(ORIG)).toEqual(['ajanlat@example.com'])
    expect(defaultReplyAddresses({ ...ORIG, replyTo: [] })).toEqual(['vevo@example.com'])
    expect(defaultReplyAddresses({})).toEqual([])
  })
  it('a reply to the default address, with participants in cc, may go', () => {
    expect(checkReply(ORIG, ['ajanlat@example.com'], ['vevo@example.com'])).toBeNull()
    expect(checkReply(ORIG, ['AJANLAT@example.com '], [], 'RE: Ajanlat 23974')).toBeNull()
  })
  it('an outsider anywhere is refused: a quoted original must not leave its thread', () => {
    expect(checkReply(ORIG, ['masik.ugyfel@example.org'], [])).toMatch(/nem resztvevo: masik\.ugyfel@example\.org/)
    expect(checkReply(ORIG, ['ajanlat@example.com'], ['masik@example.org'])).toMatch(/nem resztvevo/)
  })
  it('the address Graph may add has to be in the approved envelope', () => {
    expect(checkReply(ORIG, ['vevo@example.com'], [])).toMatch(/ajanlat@example\.com/)
  })
  it('the subject is the one Graph sets; another typed subject is refused', () => {
    expect(replySubject(ORIG)).toBe('RE: Ajanlat 23974')
    expect(checkReply(ORIG, ['ajanlat@example.com'], [], 'Ajanlat 23974')).toMatch(/RE: Ajanlat 23974/)
  })
  it('no recipient at all is refused', () => {
    expect(checkReply(ORIG, [], [])).toMatch(/nincs cimzettje/)
  })
})
