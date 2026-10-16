import { describe, it, expect } from 'vitest'
import { driveListQuery, driveDownloadUrl } from '../google-api.js'

// Two decisions in the Drive client fail in ways that do not look like their
// own cause, which is why both are pure functions with tests rather than
// inline expressions:
//
//   1. A dropped `trashed = false` returns deleted files that look live.
//      Nothing in the response says a file is in the bin.
//   2. Reading a Google-native document through `?alt=media` answers 403.
//      That reads as a permission problem, and sends you off checking the
//      sharing settings of a file that was shared correctly all along.

describe('driveListQuery', () => {
  it('excludes trashed files when no query is given', () => {
    expect(driveListQuery()).toBe('trashed = false')
  })

  it('still excludes trashed files when a query IS given', () => {
    // The regression that matters: someone adds a filter and the bin comes
    // back with it.
    expect(driveListQuery("name contains 'arlista'")).toContain('trashed = false')
  })

  it('parenthesises the caller query so an OR cannot escape the trashed rule', () => {
    // Without the parentheses, `a or b` combines as `a or (b and trashed=false)`
    // -- and everything matching `a` returns, bin included.
    expect(driveListQuery("name contains 'a' or name contains 'b'"))
      .toBe("(name contains 'a' or name contains 'b') and trashed = false")
  })

  it('treats an empty string like no query at all', () => {
    // An empty filter must not produce `() and trashed = false`, which Drive
    // rejects -- and a rejected list call returns [], which reads as "no files".
    expect(driveListQuery('')).toBe('trashed = false')
  })
})

describe('driveDownloadUrl', () => {
  it('uses alt=media for ordinary binary files', () => {
    const url = driveDownloadUrl('abc123', 'application/pdf')
    expect(url).toContain('/files/abc123?alt=media')
    expect(url).not.toContain('/export')
  })

  it('uses the export endpoint for Google-native documents', () => {
    for (const native of [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ]) {
      const url = driveDownloadUrl('doc1', native)
      expect(url).toContain('/export?mimeType=text%2Fplain')
      expect(url).not.toContain('alt=media')
    }
  })

  it('falls back to alt=media when the mime type is unknown', () => {
    // An unknown type is far more likely to be a real file than a Google Doc,
    // and alt=media on a Doc fails loudly while export on a PDF fails too --
    // so the fallback should be the common case.
    expect(driveDownloadUrl('abc123')).toContain('alt=media')
  })

  it('escapes the file id, so an id with a slash cannot rewrite the path', () => {
    const url = driveDownloadUrl('a/b?c=d', 'application/pdf')
    expect(url).toContain('a%2Fb%3Fc%3Dd')
    expect(url).not.toContain('/files/a/b')
  })

  it('does not mistake a merely similar mime type for a Google-native one', () => {
    // `vnd.google-apps` is the prefix that matters; a substring match anywhere
    // would send a real file to the export endpoint and lose it.
    expect(driveDownloadUrl('x', 'application/x-vnd.google-apps.thing')).toContain('alt=media')
  })
})
