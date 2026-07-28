import { describe, it, expect } from 'vitest'
import { parseCredentials } from '../graph-mail.js'

// parseCredentials is the pure, filesystem-free core of the credentials
// loader. The network paths (token mint, Graph calls) are exercised out of
// band against the live tenant; here we pin the parsing + validation contract.
describe('parseCredentials', () => {
  const full = [
    'TENANT_ID=3a682944-ae23-4489-b5ad-d2c7840c9458',
    'CLIENT_ID=db39e644-2a24-4fc6-9690-5f75f7e6ed02',
    'CLIENT_SECRET=xy~8Q~secretvalue',
    'MAILBOX=marveen@pecibt.hu',
  ].join('\n')

  it('parses a well-formed credentials file', () => {
    const c = parseCredentials(full)
    expect(c.tenantId).toBe('3a682944-ae23-4489-b5ad-d2c7840c9458')
    expect(c.clientId).toBe('db39e644-2a24-4fc6-9690-5f75f7e6ed02')
    expect(c.clientSecret).toBe('xy~8Q~secretvalue')
    expect(c.mailbox).toBe('marveen@pecibt.hu')
  })

  it('ignores comments and blank lines', () => {
    const c = parseCredentials(`# header comment\n\n${full}\n# trailing`)
    expect(c.mailbox).toBe('marveen@pecibt.hu')
  })

  it('strips surrounding quotes from values', () => {
    const c = parseCredentials(full.replace('CLIENT_SECRET=xy~8Q~secretvalue', 'CLIENT_SECRET="xy~8Q~secretvalue"'))
    expect(c.clientSecret).toBe('xy~8Q~secretvalue')
  })

  it('keeps = characters inside a value', () => {
    const c = parseCredentials(full.replace('CLIENT_SECRET=xy~8Q~secretvalue', 'CLIENT_SECRET=ab=cd=ef'))
    expect(c.clientSecret).toBe('ab=cd=ef')
  })

  it('throws listing every missing key', () => {
    expect(() => parseCredentials('MAILBOX=marveen@pecibt.hu')).toThrowError(/TENANT_ID.*CLIENT_ID.*CLIENT_SECRET/)
  })

  it('treats an empty value as missing', () => {
    expect(() => parseCredentials(full.replace('CLIENT_SECRET=xy~8Q~secretvalue', 'CLIENT_SECRET='))).toThrowError(
      /CLIENT_SECRET/,
    )
  })
})
