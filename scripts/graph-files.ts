#!/usr/bin/env tsx
// Thin CLI over src/graph-files.ts for OneDrive and SharePoint, so the file
// side can be smoke-tested and operated by hand without writing code.
//
//   tsx scripts/graph-files.ts verify [--sharepoint]
//   tsx scripts/graph-files.ts ls [path] [--sharepoint]
//   tsx scripts/graph-files.ts get <remote path> [--sharepoint]        -> store/graph-downloads/
//   tsx scripts/graph-files.ts put <file in drop dir> --to <remote path> [--sharepoint]
//   tsx scripts/graph-files.ts mkdir <remote path> [--sharepoint]
//   tsx scripts/graph-files.ts rm <remote path> --yes [--sharepoint]
//   tsx scripts/graph-files.ts search "<query>" [--sharepoint]
//
// Without --sharepoint every command works on the agent's own OneDrive; with
// it, on the document library of the site named by SHAREPOINT_SITE (or by
// SHAREPOINT_DRIVE_ID). With SHAREPOINT_FOLDERS set, SharePoint paths must
// start with one of the configured folder names, and `ls` with no path lists
// those folders (see src/graph-files.ts, FOLDER MODE).
//
// A sub-agent with its own app registration points the CLI at its own
// credentials file: MARVEEN_MAIL_CREDS=<file> (and GRAPH_FILES_DROP_DIR /
// GRAPH_FILES_DOWNLOAD_DIR at its own folders).
//
// UPLOAD follows the same rule the mail CLI uses for attachments: the local
// file must sit inside the drop directory (GRAPH_FILES_DROP_DIR, default
// <repo>/store/graph-upload). Putting a file there is the deliberate act that
// authorises uploading it; an arbitrary path is refused.
//
// DOWNLOAD writes into <repo>/store/graph-downloads, never over an arbitrary
// path, for the same reason in the other direction.

import {
  createFolder,
  deleteItem,
  downloadFile,
  listChildren,
  search,
  uploadFile,
  verifyFilesAccess,
  type DriveTarget,
} from '../src/graph-files.js'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DROP_DIR = resolve(process.env.GRAPH_FILES_DROP_DIR ?? resolve(REPO_ROOT, 'store/graph-upload'))
const DOWNLOAD_DIR = resolve(process.env.GRAPH_FILES_DOWNLOAD_DIR ?? resolve(REPO_ROOT, 'store/graph-downloads'))

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function target(): DriveTarget {
  return has('sharepoint') ? 'sharepoint' : 'onedrive'
}
/** First positional argument after the command, ignoring --flags. */
function positional(): string | undefined {
  const rest = process.argv.slice(3)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      // --sharepoint and --yes are booleans; everything else eats its value.
      if (a !== '--sharepoint' && a !== '--yes') i++
      continue
    }
    return a
  }
  return undefined
}

/**
 * Resolve a local upload path inside the drop directory and refuse anything
 * outside it. Symlinks are resolved on both sides so a link planted in the
 * directory cannot reach out of it, and the separator on the prefix check
 * keeps a sibling like `<dir>-evil` from matching. Same shape as the mail
 * CLI's attachment guard, deliberately.
 */
function readUpload(rawPath: string): { name: string; bytes: Buffer } {
  mkdirSync(DROP_DIR, { recursive: true })
  const dir = realpathSync(DROP_DIR)
  let file: string
  try {
    file = realpathSync(resolve(dir, rawPath))
  } catch {
    throw new Error(`graph-files: nincs ilyen fajl a feltoltesi mappaban: ${rawPath}\n  mappa: ${dir}`)
  }
  if (file !== dir && !file.startsWith(dir + sep)) {
    throw new Error(
      `graph-files: a feltoltesi mappan kivuli fajlt nem toltok fel.\n` +
        `  kert:      ${file}\n  engedett:  ${dir}\n` +
        'Masold be a fajlt a mappaba (vagy allitsd a GRAPH_FILES_DROP_DIR valtozot), es probald ujra.',
    )
  }
  if (!statSync(file).isFile()) throw new Error(`graph-files: nem sima fajl: ${file}`)
  return { name: basename(file), bytes: readFileSync(file) }
}

function human(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'verify': {
      const r = await verifyFilesAccess(target())
      console.log(`OK -- ${r.target} elerheto (${r.drive})`)
      if (r.folders) console.log(`mappa-mod, mind elerheto: ${r.folders.join(', ')}`)
      break
    }
    case 'ls': {
      const path = positional() ?? ''
      const items = await listChildren(path, target())
      console.log(`${target()}:/${path}`)
      if (items.length === 0) {
        console.log('(ures)')
        break
      }
      for (const i of items) {
        const kind = i.folder ? 'mappa' : human(i.size)
        console.log(`  ${i.folder ? '[D]' : '[F]'} ${i.name}\t${kind}\t${i.lastModifiedDateTime ?? ''}`)
      }
      break
    }
    case 'get': {
      const path = positional()
      if (!path) {
        console.error('get requires a remote path')
        process.exit(2)
      }
      const bytes = await downloadFile(path, target())
      mkdirSync(DOWNLOAD_DIR, { recursive: true })
      const out = resolve(DOWNLOAD_DIR, basename(path))
      writeFileSync(out, bytes)
      console.log(`letoltve: ${out} (${human(bytes.byteLength)})`)
      break
    }
    case 'put': {
      const local = positional()
      const remote = flag('to')
      if (!local || !remote) {
        console.error('put requires <file in drop dir> and --to <remote path>')
        process.exit(2)
      }
      const { bytes } = readUpload(local)
      const item = await uploadFile(remote, bytes, target())
      console.log(`feltoltve: ${item.name ?? remote} (${human(bytes.byteLength)})`)
      if (item.webUrl) console.log(item.webUrl)
      break
    }
    case 'mkdir': {
      const path = positional()
      if (!path) {
        console.error('mkdir requires a remote path')
        process.exit(2)
      }
      const parts = path.split('/').filter(Boolean)
      const name = parts.pop() as string
      const item = await createFolder(name, parts.join('/'), target())
      console.log(`letrehozva: ${item.name ?? name}`)
      break
    }
    case 'rm': {
      const path = positional()
      if (!path) {
        console.error('rm requires a remote path')
        process.exit(2)
      }
      // A folder goes with everything inside it, and the way back is a
      // SharePoint-side recycle-bin operation, not ours. Needs --yes.
      if (!has('yes')) {
        console.error('rm requires --yes (mappa eseten a teljes tartalma is megy)')
        process.exit(2)
      }
      await deleteItem(path, target())
      console.log(`torolve: ${path}`)
      break
    }
    case 'search': {
      const q = positional()
      if (!q) {
        console.error('search requires a query')
        process.exit(2)
      }
      const items = await search(q, target())
      if (items.length === 0) {
        console.log('(nincs talalat)')
        break
      }
      for (const i of items) console.log(`  ${i.name}\t${human(i.size)}\t${i.webUrl ?? ''}`)
      break
    }
    default:
      console.error('usage: graph-files.ts <verify|ls|get|put|mkdir|rm|search> [options] (see file header)')
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
