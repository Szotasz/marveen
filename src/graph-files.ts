import { logger } from './logger.js'
import {
  GRAPH_BASE,
  UPLOAD_TIMEOUT,
  graphError,
  graphFetch,
  loadCredentials,
  userPath,
  withTimeout,
} from './graph-client.js'

// OneDrive and SharePoint files over Microsoft Graph, app-only, on the same
// client-credentials token as graph-mail and graph-calendar.
//
// TWO TARGETS, TWO PERMISSION MODELS, AND THEY ARE NOT INTERCHANGEABLE:
//
//   'onedrive'   -- the agent's own drive, /users/<mailbox>/drive. Reachable
//                   with the same mailbox scoping the mail side uses.
//   'sharepoint' -- a site's default document library, addressed by
//                   SHAREPOINT_SITE in the credentials file. With the
//                   Sites.Selected application permission the app has access
//                   to NO site until an administrator grants it per site, so
//                   a 403 here is the normal state before that grant, not a
//                   defect. The point of Sites.Selected is exactly that: open
//                   the one team site the shared folder lives in, nothing else.
//
// FOLDER MODE (SHAREPOINT_FOLDERS). An agent can be granted individual folders
// instead of the site (Files.SelectedOperations.Selected on each driveItem).
// Such an app may not read the site object or list the library root, so the
// path-from-root addressing above does not reach its folders. In folder mode
// the first path segment(s) name a configured folder, and the rest is
// addressed relative to that folder's item id:
//
//   SHAREPOINT_DRIVE_ID=b!xxxx
//   SHAREPOINT_FOLDERS=Beszerzes:01AAAA;Projektek:01BBBB
//   "Beszerzes/Cegmenedzser/a.md" -> /drives/b!xxxx/items/01AAAA:/Cegmenedzser/a.md:
//
// A path outside the configured folders is refused HERE, before any request:
// the answer would be a 403 or 404 anyway, and a local refusal names the
// allowed folders instead of a bare status. Listing the root returns the
// configured folders themselves. The folders are kept as the user named them,
// so the same path works for an agent in folder mode and for one with the
// whole site, as long as the folder sits at the library root under that name.
//
// PATH ADDRESSING is the part that bites. Graph addresses an item by path with
// a colon-delimited segment (`/root:/folder/file.txt:/content`), and the colons
// are structural: drop the trailing one and Graph reads the rest of the URL as
// part of the file name. buildItemUrl is pure and unit-tested for that reason.

const PREFIX = 'graph-files'

/** Graph's own ceiling for a simple PUT upload is 4 MiB; above it a session. */
export const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024
/**
 * Upload-session chunk size. Graph REQUIRES a multiple of 320 KiB for every
 * chunk but the last; 10 MiB is a multiple and a reasonable wire size.
 */
export const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024

export type DriveTarget = 'onedrive' | 'sharepoint'

export interface DriveItem {
  id: string
  name?: string
  size?: number
  webUrl?: string
  lastModifiedDateTime?: string
  /** Present on folders; `file` is present on files. Both absent on neither. */
  folder?: { childCount?: number }
  file?: { mimeType?: string }
  parentReference?: { path?: string; driveId?: string }
}

export interface SiteAddress {
  hostname: string
  /** Server-relative site path, always starting with a slash. */
  sitePath: string
}

/**
 * Split `pecibt.sharepoint.com:/sites/Marveen` into its two halves.
 * Pure: the separator is a colon that also appears in Graph's own path syntax,
 * and getting it wrong addresses a site that does not exist.
 */
export function parseSiteAddress(raw: string): SiteAddress {
  const value = raw.trim()
  if (!value) throw new Error(`${PREFIX}: SHAREPOINT_SITE is empty, no site is configured`)
  const idx = value.indexOf(':')
  const hostname = (idx === -1 ? value : value.slice(0, idx)).trim()
  let sitePath = (idx === -1 ? '' : value.slice(idx + 1)).trim()
  if (!hostname.includes('.')) {
    throw new Error(
      `${PREFIX}: SHAREPOINT_SITE must start with the host name, e.g. ` +
        `"contoso.sharepoint.com:/sites/Team" (got "${raw}")`,
    )
  }
  if (sitePath && !sitePath.startsWith('/')) sitePath = `/${sitePath}`
  return { hostname, sitePath }
}

/**
 * Percent-encode a drive-relative path segment by segment. A plain
 * encodeURIComponent on the whole path would eat the separators; leaving it
 * raw breaks on the spaces and accented characters that Hungarian file names
 * are full of.
 */
export function encodeDrivePath(path: string): string {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/**
 * Build the Graph URL for an item addressed by path, with an optional suffix
 * such as `/children` or `/content`.
 *
 * Root is special: `/root/children` is right and `/root:/:/children` is not,
 * so the empty path takes a different branch. Pure and tested.
 */
export function buildItemUrl(driveSegment: string, path: string, suffix = ''): string {
  const encoded = encodeDrivePath(path)
  if (!encoded) return `${driveSegment}/root${suffix}`
  return `${driveSegment}/root:/${encoded}:${suffix}`
}

/**
 * Byte ranges for an upload session. Pure, because an off-by-one here uploads
 * a corrupt file that Graph accepts without complaint.
 */
export function chunkRanges(size: number, chunkSize = UPLOAD_CHUNK_BYTES): Array<{ start: number; end: number }> {
  if (size <= 0) return []
  const ranges: Array<{ start: number; end: number }> = []
  for (let start = 0; start < size; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, size) - 1 })
  }
  return ranges
}

export interface FolderEntry {
  /** Drive-relative path of the folder as the agent addresses it, no slashes at the ends. */
  name: string
  /** Graph driveItem id of the folder. */
  id: string
}

/**
 * Parse SHAREPOINT_FOLDERS: `Name:itemId` pairs separated by `;` or `,`.
 * Pure and tested. The split is on the LAST colon of each pair, because a
 * folder path may not contain one but an id never does either, and a name like
 * "Gyartas/Beszerzes" is allowed (a nested grant). Duplicate names (case
 * insensitive, SharePoint names are) are refused: which id would win is not a
 * question the code should answer silently.
 */
export function parseFolderMap(raw: string): FolderEntry[] {
  const out: FolderEntry[] = []
  const seen = new Set<string>()
  for (const part of raw.split(/[;,]/)) {
    const pair = part.trim()
    if (!pair) continue
    const idx = pair.lastIndexOf(':')
    if (idx === -1) {
      throw new Error(`${PREFIX}: SHAREPOINT_FOLDERS entry "${pair}" has no colon, expected Name:itemId`)
    }
    const name = pair
      .slice(0, idx)
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean)
      .join('/')
    const id = pair.slice(idx + 1).trim()
    if (!name || !id) {
      throw new Error(`${PREFIX}: SHAREPOINT_FOLDERS entry "${pair}" needs both a name and an item id`)
    }
    if (/[\s/?#]/.test(id)) {
      throw new Error(`${PREFIX}: SHAREPOINT_FOLDERS item id "${id}" is not a Graph item id`)
    }
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(`${PREFIX}: SHAREPOINT_FOLDERS names "${name}" twice`)
    seen.add(key)
    out.push({ name, id })
  }
  return out
}

/**
 * Which configured folder a path falls in, and the remainder inside it.
 * Longest match wins, so "Gyartas/Beszerzes" beats "Gyartas" when both are
 * configured. Segment-wise and case-insensitive: "Beszerzes2/x" does NOT match
 * "Beszerzes". Null when the path is outside every folder (or is the root).
 */
export function matchFolder(folders: FolderEntry[], path: string): { folder: FolderEntry; rest: string } | null {
  const segs = path
    .split('/')
    .map((x) => x.trim())
    .filter(Boolean)
  let best: { folder: FolderEntry; rest: string; len: number } | null = null
  for (const f of folders) {
    const fs = f.name.split('/')
    if (fs.length > segs.length) continue
    if (!fs.every((x, i) => x.toLowerCase() === segs[i].toLowerCase())) continue
    if (!best || fs.length > best.len) best = { folder: f, rest: segs.slice(fs.length).join('/'), len: fs.length }
  }
  return best ? { folder: best.folder, rest: best.rest } : null
}

/**
 * Graph URL for a path relative to a folder addressed by item id. Same colon
 * rules as buildItemUrl: the folder itself takes the plain item form, a path
 * inside it is wrapped in both colons. Pure and tested.
 */
export function buildFolderItemUrl(driveSegment: string, folderId: string, rest: string, suffix = ''): string {
  const base = `${driveSegment}/items/${encodeURIComponent(folderId)}`
  const encoded = encodeDrivePath(rest)
  if (!encoded) return `${base}${suffix}`
  return `${base}:/${encoded}:${suffix}`
}

function outsideFoldersError(path: string, folders: FolderEntry[]): Error {
  return new Error(
    `${PREFIX}: "${path || '/'}" nincs a beallitott SharePoint-mappak kozott ` +
      `(engedett: ${folders.map((f) => f.name).join(', ')}). Ez az ugynok csak ezekhez a mappakhoz fer hozza.`,
  )
}

let cachedSiteDrive: { site: string; segment: string } | null = null

/** `/drives/<id>` for the configured SharePoint site, resolved once. */
async function sharepointDriveSegment(): Promise<string> {
  const creds = loadCredentials(PREFIX)
  // A configured drive id is used as-is: no site lookup, which a folder-only
  // grant could not perform anyway.
  if (creds.sharepointDriveId) return `/drives/${encodeURIComponent(creds.sharepointDriveId)}`
  if (!creds.sharepointSite) {
    throw new Error(
      `${PREFIX}: no SharePoint site configured. Add SHAREPOINT_SITE=<host>:/sites/<name> ` +
        'to the credentials file (this is a configuration gap, not a permission failure).',
    )
  }
  if (cachedSiteDrive?.site === creds.sharepointSite) return cachedSiteDrive.segment
  const { hostname, sitePath } = parseSiteAddress(creds.sharepointSite)
  const siteUrl = `/sites/${encodeURIComponent(hostname)}:${sitePath}`
  const res = await graphFetch(`${siteUrl}?$select=id,displayName`, { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `resolve site ${creds.sharepointSite}`, res)
  const site = (await res.json()) as { id?: string; displayName?: string }
  if (!site.id) throw new Error(`${PREFIX}: site ${creds.sharepointSite} returned no id`)
  const driveRes = await graphFetch(`/sites/${encodeURIComponent(site.id)}/drive?$select=id,name`, {
    prefix: PREFIX,
  })
  if (!driveRes.ok) throw await graphError(PREFIX, 'resolve site drive', driveRes)
  const drive = (await driveRes.json()) as { id?: string }
  if (!drive.id) throw new Error(`${PREFIX}: site ${creds.sharepointSite} has no default document library`)
  cachedSiteDrive = { site: creds.sharepointSite, segment: `/drives/${encodeURIComponent(drive.id)}` }
  logger.info({ site: creds.sharepointSite, displayName: site.displayName }, 'graph-files: site drive resolved')
  return cachedSiteDrive.segment
}

async function driveSegment(target: DriveTarget): Promise<string> {
  return target === 'sharepoint' ? sharepointDriveSegment() : `${userPath(PREFIX)}/drive`
}

/** Configured folders when the target is SharePoint in folder mode, else null. */
function folderMode(target: DriveTarget): FolderEntry[] | null {
  if (target !== 'sharepoint') return null
  const folders = parseFolderMap(loadCredentials(PREFIX).sharepointFolders)
  return folders.length > 0 ? folders : null
}

/**
 * The one place that turns (target, path, suffix) into a Graph URL. In folder
 * mode a path outside the folders is refused before any request, and
 * `allowFolderItself: false` refuses the configured folder itself (upload over
 * it, delete it): an agent granted a folder should not be able to remove it.
 */
async function itemUrl(
  target: DriveTarget,
  path: string,
  suffix = '',
  opts: { allowFolderItself?: boolean } = {},
): Promise<string> {
  const segment = await driveSegment(target)
  const folders = folderMode(target)
  if (!folders) return buildItemUrl(segment, path, suffix)
  const m = matchFolder(folders, path)
  if (!m) throw outsideFoldersError(path, folders)
  if (!m.rest && opts.allowFolderItself === false) {
    throw new Error(`${PREFIX}: "${m.folder.name}" egy beallitott gyokermappa, ezt a muveletet ra nem vegzem el`)
  }
  return buildFolderItemUrl(segment, m.folder.id, m.rest, suffix)
}

const ITEM_SELECT = '$select=id,name,size,webUrl,lastModifiedDateTime,folder,file,parentReference'

/** Folder mode root listing: the configured folders, each read by id. */
async function listConfiguredFolders(folders: FolderEntry[]): Promise<DriveItem[]> {
  const segment = await driveSegment('sharepoint')
  const out: DriveItem[] = []
  for (const f of folders) {
    const res = await graphFetch(`${buildFolderItemUrl(segment, f.id, '')}?${ITEM_SELECT}`, { prefix: PREFIX })
    if (!res.ok) throw await graphError(PREFIX, `folder ${f.name}`, res)
    const item = (await res.json()) as DriveItem
    // Show the configured name: it is the one the agent has to type.
    out.push({ ...item, name: f.name })
  }
  return out
}

/** Folder contents. Empty path means the drive root. */
export async function listChildren(path = '', target: DriveTarget = 'onedrive'): Promise<DriveItem[]> {
  const folders = folderMode(target)
  if (folders && !encodeDrivePath(path)) return listConfiguredFolders(folders)
  const url = `${await itemUrl(target, path, '/children')}?$top=200&${ITEM_SELECT}`
  const res = await graphFetch(url, { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `listChildren ${path || '/'}`, res)
  const json = (await res.json()) as { value?: DriveItem[] }
  return json.value ?? []
}

/** Metadata for one item addressed by path. */
export async function getItem(path: string, target: DriveTarget = 'onedrive'): Promise<DriveItem> {
  const res = await graphFetch(await itemUrl(target, path), { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `getItem ${path}`, res)
  return (await res.json()) as DriveItem
}

/** File bytes. Graph answers with a redirect to storage; fetch follows it. */
export async function downloadFile(path: string, target: DriveTarget = 'onedrive'): Promise<Buffer> {
  const res = await graphFetch(await itemUrl(target, path, '/content'), {
    prefix: PREFIX,
    timeoutMs: UPLOAD_TIMEOUT,
  })
  if (!res.ok) throw await graphError(PREFIX, `downloadFile ${path}`, res)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Upload a file, creating or replacing it. Picks the simple PUT under 4 MiB
 * and an upload session above it, because the simple PUT silently is not an
 * option there: Graph rejects it, and the useful error is the one that says
 * which branch was taken.
 */
export async function uploadFile(
  path: string,
  data: Buffer | string,
  target: DriveTarget = 'onedrive',
  contentType = 'application/octet-stream',
): Promise<DriveItem> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
  if (bytes.byteLength <= SIMPLE_UPLOAD_MAX_BYTES) {
    const res = await graphFetch(await itemUrl(target, path, '/content', { allowFolderItself: false }), {
      method: 'PUT',
      prefix: PREFIX,
      timeoutMs: UPLOAD_TIMEOUT,
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
    })
    if (!res.ok) throw await graphError(PREFIX, `uploadFile ${path}`, res)
    const item = (await res.json()) as DriveItem
    logger.info({ path, bytes: bytes.byteLength, target, mode: 'simple' }, 'graph-files: uploaded')
    return item
  }
  return uploadLargeFile(path, bytes, target)
}

async function uploadLargeFile(
  path: string,
  bytes: Buffer,
  target: DriveTarget,
): Promise<DriveItem> {
  const sessionUrl = await itemUrl(target, path, '/createUploadSession', { allowFolderItself: false })
  const sessionRes = await graphFetch(sessionUrl, {
    method: 'POST',
    prefix: PREFIX,
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  })
  if (!sessionRes.ok) throw await graphError(PREFIX, `createUploadSession ${path}`, sessionRes)
  const { uploadUrl } = (await sessionRes.json()) as { uploadUrl?: string }
  if (!uploadUrl) throw new Error(`${PREFIX}: createUploadSession returned no uploadUrl for ${path}`)

  let last: Response | null = null
  for (const { start, end } of chunkRanges(bytes.byteLength)) {
    const chunk = bytes.subarray(start, end + 1)
    // The session URL is pre-authorised: it carries its own token, and adding
    // the Bearer header here is both unnecessary and refused by some regions.
    last = await withTimeout(
      (signal) =>
        fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
          },
          body: new Uint8Array(chunk),
          signal,
        }),
      UPLOAD_TIMEOUT,
    )
    if (!last.ok && last.status !== 202) throw await graphError(PREFIX, `uploadFile chunk ${start}-${end}`, last)
  }
  const item = (last && last.status !== 202 ? ((await last.json()) as DriveItem) : null) ?? (await getItem(path, target))
  logger.info({ path, bytes: bytes.byteLength, target, mode: 'session' }, 'graph-files: uploaded')
  return item
}

/** Create a folder under `parentPath` (empty parent means the root). */
export async function createFolder(
  name: string,
  parentPath = '',
  target: DriveTarget = 'onedrive',
): Promise<DriveItem> {
  const res = await graphFetch(await itemUrl(target, parentPath, '/children'), {
    method: 'POST',
    prefix: PREFIX,
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  })
  if (!res.ok) throw await graphError(PREFIX, `createFolder ${parentPath}/${name}`, res)
  const item = (await res.json()) as DriveItem
  logger.info({ name, parentPath, target }, 'graph-files: folder created')
  return item
}

/**
 * Delete an item (a folder goes with everything in it). Irreversible from this
 * side: it lands in the site or drive recycle bin, and getting it back is a
 * SharePoint-side operation, not ours. Callers decide; this records.
 */
export async function deleteItem(path: string, target: DriveTarget = 'onedrive'): Promise<void> {
  const url = await itemUrl(target, path, '', { allowFolderItself: false })
  const res = await graphFetch(url, { method: 'DELETE', prefix: PREFIX })
  if (!res.ok && res.status !== 204) throw await graphError(PREFIX, `deleteItem ${path}`, res)
  logger.info({ path, target }, 'graph-files: deleted')
}

/** Upper bounds for the folder-mode walk, so a huge tree cannot run away. */
export const WALK_MAX_FOLDERS = 500
export const WALK_MAX_RESULTS = 200

/** Lowercase and strip accents, so "ajanlat" finds "Ajánlat". */
function foldName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Folder mode search: a breadth-first walk over the configured folders,
 * matching item NAMES (not file contents). Graph's driveItem search does not
 * work under Files.SelectedOperations.Selected (measured 403 on 2026-11-12;
 * Microsoft documents it as tenant-wide permissions only), and the tenant-wide
 * permissions would open every company file to the agent, so the owner's
 * administrator chose the walk (2026-11-13).
 */
async function walkSearch(segment: string, folders: FolderEntry[], query: string): Promise<DriveItem[]> {
  const needle = foldName(query.trim())
  const queue = folders.map((f) => f.id)
  const out: DriveItem[] = []
  let visited = 0
  while (queue.length > 0 && visited < WALK_MAX_FOLDERS && out.length < WALK_MAX_RESULTS) {
    const id = queue.shift() as string
    visited++
    let url: string | undefined = `${buildFolderItemUrl(segment, id, '', '/children')}?$top=200&${ITEM_SELECT}`
    while (url) {
      const res = await graphFetch(url, { prefix: PREFIX })
      if (!res.ok) throw await graphError(PREFIX, `search walk ${id}`, res)
      const json = (await res.json()) as { value?: DriveItem[]; '@odata.nextLink'?: string }
      for (const item of json.value ?? []) {
        if (item.folder) queue.push(item.id)
        if (item.name && foldName(item.name).includes(needle) && out.length < WALK_MAX_RESULTS) out.push(item)
      }
      const next = json['@odata.nextLink']
      url = next ? next.replace(GRAPH_BASE, '') : undefined
    }
  }
  if (queue.length > 0) {
    logger.warn({ visited, pending: queue.length, results: out.length }, 'graph-files: search walk hit its limit')
  }
  return out
}

/**
 * Search the drive. Whole-drive mode uses Graph's full-text and name search;
 * folder mode walks the configured folders and matches names only.
 */
export async function search(query: string, target: DriveTarget = 'onedrive'): Promise<DriveItem[]> {
  const segment = await driveSegment(target)
  const folders = folderMode(target)
  if (folders) return walkSearch(segment, folders, query)
  const q = `search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')?$top=100`
  const res = await graphFetch(`${segment}/root/${q}`, { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `search ${query}`, res)
  const json = (await res.json()) as { value?: DriveItem[] }
  return json.value ?? []
}

/**
 * Connectivity + scope smoke check, per target. Lists the root: proves the
 * token mints, the drive resolves and read access is present.
 *
 * For 'sharepoint' a 403 is the EXPECTED answer until an administrator grants
 * the app access to that specific site under Sites.Selected, so the error from
 * graphError names the permission case rather than leaving a bare number.
 */
export async function verifyFilesAccess(
  target: DriveTarget = 'onedrive',
): Promise<{ target: DriveTarget; drive: string; itemCount: number; folders?: string[] }> {
  const segment = await driveSegment(target)
  const folders = folderMode(target)
  if (folders) {
    // Every configured folder must answer, not just the first: a grant
    // missing on one folder is exactly the setup error this check is for.
    for (const f of folders) {
      const r = await graphFetch(`${buildFolderItemUrl(segment, f.id, '', '/children')}?$top=1&$select=id`, {
        prefix: PREFIX,
      })
      if (!r.ok) throw await graphError(PREFIX, `verifyFilesAccess folder ${f.name}`, r)
    }
    return { target, drive: segment, itemCount: folders.length, folders: folders.map((f) => f.name) }
  }
  const res = await graphFetch(`${buildItemUrl(segment, '', '/children')}?$top=1&$select=id`, { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `verifyFilesAccess ${target}`, res)
  const json = (await res.json()) as { value?: unknown[] }
  return { target, drive: segment, itemCount: json.value?.length ?? 0 }
}
