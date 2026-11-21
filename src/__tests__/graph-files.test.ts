import { describe, it, expect } from 'vitest'
import {
  SIMPLE_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
  buildItemUrl,
  chunkRanges,
  encodeDrivePath,
  parseSiteAddress,
} from '../graph-files.js'

// Graph addresses a file by path with structural colons
// (`/root:/mappa/fajl.txt:/content`). Everything below is the part that decides
// WHICH resource the call hits, and every one of these failures is quiet: a
// wrong encoding creates a file with a percent sign in its name, a missing
// trailing colon makes Graph read `/content` as part of the file name, and a
// bad chunk range uploads a corrupt file that Graph accepts without complaint.

describe('encodeDrivePath', () => {
  it('encodes segment by segment and keeps the separators', () => {
    expect(encodeDrivePath('Megosztott mappa/rajz.pdf')).toBe('Megosztott%20mappa/rajz.pdf')
  })

  it('survives accented Hungarian names', () => {
    expect(encodeDrivePath('árajánlat/kész.docx')).toBe('%C3%A1raj%C3%A1nlat/k%C3%A9sz.docx')
  })

  it('drops one leading and one trailing slash', () => {
    expect(encodeDrivePath('/a/b/')).toBe('a/b')
  })

  // fetch resolves dot segments, and encodeURIComponent leaves them alone, so a
  // ".." would send a different path than the one every local check read.
  it('refuses ".", ".." and empty segments', () => {
    for (const p of ['a/../b', '..', './a', 'a/.', 'a//b', 'a/ .. /b', 'Beszerzes/../../sites/x']) {
      expect(() => encodeDrivePath(p), p).toThrowError(/"\.\."/)
    }
  })

  it('keeps names that only contain dots', () => {
    expect(encodeDrivePath('a/...txt/..b')).toBe('a/...txt/..b')
  })

  it('returns empty for the root, in every spelling of it', () => {
    expect(encodeDrivePath('')).toBe('')
    expect(encodeDrivePath('/')).toBe('')
    expect(encodeDrivePath('   ')).toBe('')
  })
})

describe('buildItemUrl', () => {
  it('refuses a dot segment before building the URL', () => {
    expect(() => buildItemUrl('/me/drive', 'a/../b', '/content')).toThrowError(/"\.\."/)
  })

  const seg = '/drives/b!abc'

  it('uses the plain root form for the root, not an empty colon pair', () => {
    expect(buildItemUrl(seg, '', '/children')).toBe('/drives/b!abc/root/children')
    expect(buildItemUrl(seg, '/')).toBe('/drives/b!abc/root')
  })

  it('wraps a path in both colons', () => {
    expect(buildItemUrl(seg, 'mappa/fajl.txt', '/content')).toBe('/drives/b!abc/root:/mappa/fajl.txt:/content')
  })

  it('keeps the trailing colon even with no suffix', () => {
    expect(buildItemUrl(seg, 'mappa/fajl.txt')).toBe('/drives/b!abc/root:/mappa/fajl.txt:')
  })

  it('works against the OneDrive segment just as well', () => {
    expect(buildItemUrl('/me/drive', 'x.txt')).toBe('/me/drive/root:/x.txt:')
  })
})

describe('parseSiteAddress', () => {
  it('splits host and server-relative path', () => {
    expect(parseSiteAddress('pecibt.sharepoint.com:/sites/Marveen')).toEqual({
      hostname: 'pecibt.sharepoint.com',
      sitePath: '/sites/Marveen',
    })
  })

  it('adds the missing leading slash to the site path', () => {
    expect(parseSiteAddress('pecibt.sharepoint.com:sites/Marveen').sitePath).toBe('/sites/Marveen')
  })

  it('accepts a bare host, which addresses the root site', () => {
    expect(parseSiteAddress('pecibt.sharepoint.com')).toEqual({
      hostname: 'pecibt.sharepoint.com',
      sitePath: '',
    })
  })

  it('refuses an empty value rather than building a half URL', () => {
    expect(() => parseSiteAddress('   ')).toThrowError(/SHAREPOINT_SITE/)
  })

  it('refuses something that is not a host name', () => {
    expect(() => parseSiteAddress('/sites/Marveen')).toThrowError(/host name/)
  })
})

describe('chunkRanges', () => {
  it('returns nothing for an empty file', () => {
    expect(chunkRanges(0)).toEqual([])
  })

  it('returns one inclusive range for a file under the chunk size', () => {
    expect(chunkRanges(100, 1000)).toEqual([{ start: 0, end: 99 }])
  })

  it('covers every byte exactly once, with no gap and no overlap', () => {
    const size = 2500
    const ranges = chunkRanges(size, 1000)
    expect(ranges).toEqual([
      { start: 0, end: 999 },
      { start: 1000, end: 1999 },
      { start: 2000, end: 2499 },
    ])
    const covered = ranges.reduce((n, r) => n + (r.end - r.start + 1), 0)
    expect(covered).toBe(size)
  })

  it('does not emit an empty trailing range on an exact multiple', () => {
    expect(chunkRanges(2000, 1000)).toHaveLength(2)
  })

  it('uses a Graph-legal default chunk size (a multiple of 320 KiB)', () => {
    expect(UPLOAD_CHUNK_BYTES % (320 * 1024)).toBe(0)
  })
})

describe('upload mode boundary', () => {
  it('keeps the simple-PUT ceiling at Graph own 4 MiB', () => {
    expect(SIMPLE_UPLOAD_MAX_BYTES).toBe(4 * 1024 * 1024)
  })
})
