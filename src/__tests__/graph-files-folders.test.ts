import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Folder mode (SHAREPOINT_FOLDERS): an agent granted individual SharePoint
// folders, not the site. The pure parts decide WHICH item a path hits; the
// mocked-fetch part pins that every call goes through the folder's item id,
// that a path outside the grant never reaches the network, and that the
// configured folder itself cannot be deleted or overwritten.

const dir = mkdtempSync(join(tmpdir(), 'graph-folders-'))
const credsFile = join(dir, 'creds')
process.env.MARVEEN_MAIL_CREDS = credsFile

const BASE_CREDS = ['TENANT_ID=t', 'CLIENT_ID=c', 'CLIENT_SECRET=s'].join('\n')
const FOLDER_CREDS = `${BASE_CREDS}\nSHAREPOINT_DRIVE_ID=b!drive\nSHAREPOINT_FOLDERS=Beszerzes:01AAA;Projektek:01BBB\n`

type Mod = typeof import('../graph-files.js')
type Client = typeof import('../graph-client.js')
let m: Mod
let client: Client
const calls: Array<{ url: string; method: string }> = []
let baseFetch: (url: string, init?: RequestInit) => Promise<Response>

beforeAll(async () => {
  writeFileSync(credsFile, FOLDER_CREDS)
  client = await import('../graph-client.js')
  m = await import('../graph-files.js')
  baseFetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    calls.push({ url: url.replace(client.GRAPH_BASE, ''), method })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (url.includes('/children') || url.includes('/search(')) {
      return new Response(JSON.stringify({ value: [{ id: 'x', name: 'x' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: 'item', name: 'graph-name' }), { status: 200 })
  }
  vi.stubGlobal('fetch', baseFetch)
})

afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
})

describe('parseFolderMap', () => {
  it('parses name:id pairs with either separator', () => {
    expect(m.parseFolderMap('Beszerzes:01A; Projektek:01B, Penzugy:01C')).toEqual([
      { name: 'Beszerzes', id: '01A' },
      { name: 'Projektek', id: '01B' },
      { name: 'Penzugy', id: '01C' },
    ])
  })
  it('returns nothing for an empty value (folder mode off)', () => {
    expect(m.parseFolderMap('')).toEqual([])
    expect(m.parseFolderMap(' ; ,')).toEqual([])
  })
  it('allows a nested folder name and trims its slashes', () => {
    expect(m.parseFolderMap('/Gyartas/Beszerzes/:01A')).toEqual([{ name: 'Gyartas/Beszerzes', id: '01A' }])
  })
  it('refuses a pair without a colon, a name or an id', () => {
    expect(() => m.parseFolderMap('Beszerzes')).toThrowError(/no colon/)
    expect(() => m.parseFolderMap(':01A')).toThrowError(/name and an item id/)
    expect(() => m.parseFolderMap('Beszerzes:')).toThrowError(/name and an item id/)
  })
  it('refuses an id that is not one', () => {
    expect(() => m.parseFolderMap('Beszerzes:01 A')).toThrowError(/not a Graph item id/)
  })
  it('refuses a duplicate name, case-insensitively', () => {
    expect(() => m.parseFolderMap('Beszerzes:01A;beszerzes:01B')).toThrowError(/twice/)
  })
})

describe('matchFolder', () => {
  const folders = [
    { name: 'Gyartas', id: 'G' },
    { name: 'Gyartas/Beszerzes', id: 'GB' },
    { name: 'Projektek', id: 'P' },
  ]
  it('matches the folder itself with an empty rest', () => {
    expect(m.matchFolder(folders, 'Projektek')).toEqual({ folder: folders[2], rest: '' })
  })
  it('returns the remainder inside the folder', () => {
    expect(m.matchFolder(folders, '/Projektek/2026/a b.pdf')).toEqual({ folder: folders[2], rest: '2026/a b.pdf' })
  })
  it('prefers the longest configured folder', () => {
    expect(m.matchFolder(folders, 'Gyartas/Beszerzes/x.md')?.folder.id).toBe('GB')
    expect(m.matchFolder(folders, 'Gyartas/Mas/x.md')?.folder.id).toBe('G')
  })
  it('is case-insensitive', () => {
    expect(m.matchFolder(folders, 'projektek/x')?.folder.id).toBe('P')
  })
  it('matches whole segments only', () => {
    expect(m.matchFolder(folders, 'Projektek2/x')).toBeNull()
  })
  it('refuses dot and empty segments instead of matching on the first one', () => {
    for (const p of ['Projektek/../01CCCC', 'Projektek/../Titkos/b.md', 'Gyartas/Beszerzes/../../x', 'Projektek//x']) {
      expect(() => m.matchFolder(folders, p), p).toThrowError(/"\.\."/)
    }
  })
  it('does not match the root or an unlisted folder', () => {
    expect(m.matchFolder(folders, '')).toBeNull()
    expect(m.matchFolder(folders, 'Penzugy/x')).toBeNull()
  })
})

describe('buildFolderItemUrl', () => {
  it('uses the plain item form for the folder itself', () => {
    expect(m.buildFolderItemUrl('/drives/d', '01A', '', '/children')).toBe('/drives/d/items/01A/children')
  })
  it('wraps a path inside the folder in both colons', () => {
    expect(m.buildFolderItemUrl('/drives/d', '01A', 'Cegmenedzser/á b.md', '/content')).toBe(
      '/drives/d/items/01A:/Cegmenedzser/%C3%A1%20b.md:/content',
    )
  })
  it('keeps the trailing colon with no suffix', () => {
    expect(m.buildFolderItemUrl('/drives/d', '01A', 'x.md')).toBe('/drives/d/items/01A:/x.md:')
  })
})

describe('parseCredentials, SharePoint-only file', () => {
  it('does not require MAILBOX when a drive id is configured', () => {
    const c = client.parseCredentials(FOLDER_CREDS)
    expect(c.mailbox).toBe('')
    expect(c.sharepointDriveId).toBe('b!drive')
    expect(c.sharepointFolders).toBe('Beszerzes:01AAA;Projektek:01BBB')
  })
  it('still requires MAILBOX without any SharePoint target', () => {
    expect(() => client.parseCredentials(BASE_CREDS)).toThrowError(/mailbox/)
  })
})

describe('folder mode over the network seam', () => {
  it('addresses a file through the folder item id, without a site lookup', async () => {
    await m.downloadFile('Beszerzes/Cegmenedzser/a.md', 'sharepoint')
    expect(calls).toEqual([{ url: '/drives/b!drive/items/01AAA:/Cegmenedzser/a.md:/content', method: 'GET' }])
  })
  it('lists the configured folders at the root, under their configured names', async () => {
    const items = await m.listChildren('', 'sharepoint')
    expect(items.map((i) => i.name)).toEqual(['Beszerzes', 'Projektek'])
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['/drives/b!drive/items/01AAA', '/drives/b!drive/items/01BBB'])
  })
  it('lists inside a folder by id', async () => {
    await m.listChildren('Projektek', 'sharepoint')
    expect(calls[0].url.split('?')[0]).toBe('/drives/b!drive/items/01BBB/children')
  })
  it('refuses a path outside the folders before any request', async () => {
    await expect(m.downloadFile('Penzugy/x.pdf', 'sharepoint')).rejects.toThrowError(/Beszerzes, Projektek/)
    await expect(m.uploadFile('x.txt', 'a', 'sharepoint')).rejects.toThrowError(/nincs a beallitott/)
    expect(calls).toEqual([])
  })
  it('refuses a ".." path before any request, for every operation', async () => {
    // Without the check these were sent as /drives/b!drive/items/01CCCC:/content
    // and /drives/b!drive/items/Titkos/b.md:/content (fetch resolves the dots).
    await expect(m.downloadFile('Beszerzes/../01CCCC', 'sharepoint')).rejects.toThrowError(/"\.\."/)
    await expect(m.getItem('Beszerzes/../Titkos/b.md', 'sharepoint')).rejects.toThrowError(/"\.\."/)
    await expect(m.listChildren('Beszerzes/sub/../../Projektek', 'sharepoint')).rejects.toThrowError(/"\.\."/)
    await expect(m.uploadFile('Beszerzes/../x.txt', 'a', 'sharepoint')).rejects.toThrowError(/"\.\."/)
    await expect(m.deleteItem('Beszerzes/../01CCCC', 'sharepoint')).rejects.toThrowError(/"\.\."/)
    await expect(m.createFolder('Uj', 'Beszerzes/..', 'sharepoint')).rejects.toThrowError(/"\.\."/)
    expect(calls).toEqual([])
  })
  it('refuses to delete or overwrite a configured folder itself', async () => {
    await expect(m.deleteItem('Beszerzes', 'sharepoint')).rejects.toThrowError(/gyokermappa/)
    await expect(m.uploadFile('Projektek', 'a', 'sharepoint')).rejects.toThrowError(/gyokermappa/)
    expect(calls).toEqual([])
  })
  it('creates a subfolder under a configured folder', async () => {
    await m.createFolder('Uj', 'Beszerzes', 'sharepoint')
    expect(calls).toEqual([{ url: '/drives/b!drive/items/01AAA/children', method: 'POST' }])
  })
  it('refuses to create a folder at the root', async () => {
    await expect(m.createFolder('Uj', '', 'sharepoint')).rejects.toThrowError(/nincs a beallitott/)
  })
  it('searches by walking every folder, never the search endpoint or the root', async () => {
    // Graph search is not available under Files.SelectedOperations.Selected
    // (403), so folder mode lists children recursively and matches names.
    const tree: Record<string, unknown[]> = {
      '01AAA': [
        { id: 'sub1', name: 'Ajánlatok', folder: { childCount: 2 } },
        { id: 'f0', name: 'jegyzet.txt', file: {} },
      ],
      sub1: [{ id: 'f1', name: 'AJANLAT-23974.pdf', file: {} }],
      sub1page2: [{ id: 'f2', name: 'ajánlat-régi.xlsx', file: {} }],
      '01BBB': [],
    }
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      const rel = url.replace(client.GRAPH_BASE, '')
      calls.push({ url: rel, method: init?.method ?? 'GET' })
      if (rel.includes('page=2')) return new Response(JSON.stringify({ value: tree.sub1page2 }), { status: 200 })
      const id = decodeURIComponent(rel.split('/items/')[1].split('/')[0])
      const body: Record<string, unknown> = { value: tree[id] ?? [] }
      if (id === 'sub1') body['@odata.nextLink'] = `${client.GRAPH_BASE}/drives/b!drive/items/sub1/children?page=2`
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const items = await m.search('ajanlat', 'sharepoint')
    expect(items.map((i) => i.name)).toEqual(['Ajánlatok', 'AJANLAT-23974.pdf', 'ajánlat-régi.xlsx'])
    expect(calls.every((c) => !c.url.includes('/search(') && !c.url.includes('/root'))).toBe(true)
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      '/drives/b!drive/items/01AAA/children',
      '/drives/b!drive/items/01BBB/children',
      '/drives/b!drive/items/sub1/children',
      '/drives/b!drive/items/sub1/children',
    ])
    vi.stubGlobal('fetch', baseFetch)
  })
  it('verify checks every configured folder', async () => {
    const r = await m.verifyFilesAccess('sharepoint')
    expect(r.folders).toEqual(['Beszerzes', 'Projektek'])
    // The children of each folder, by id (a live run caught "/children"
    // passed as a path inside the folder, which Graph answers with 404).
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      '/drives/b!drive/items/01AAA/children',
      '/drives/b!drive/items/01BBB/children',
    ])
  })
  it('a SharePoint-only file refuses OneDrive with a clear message', async () => {
    await expect(m.listChildren('', 'onedrive')).rejects.toThrowError(/no MAILBOX/)
  })
})
