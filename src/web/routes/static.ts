import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile } from '../http-helpers.js'
import { MIME } from '../http-helpers.js'
import { BRAND_NAME } from '../../config.js'
import type { RouteContext } from './types.js'

// Substitute the configured brand into the PWA manifest's user-visible fields
// (name/short_name) so an install that sets BRAND_NAME shows its own name on
// the installed home-screen icon. Replaces only those two quoted string values
// in place, preserving the file's exact formatting (whitespace + trailing
// newline), so a stock install (brandName == the shipped default) serves the
// file BYTE-FOR-BYTE unchanged. Keyed on the exact `"name"` / `"short_name"`
// keys (the `"name"` rule cannot match `"short_name"`). Pure + side-effect-free
// so it is provable independent of the request pipeline; a manifest missing the
// keys is returned untouched rather than throwing.
export function buildManifest(raw: string, brandName: string): string {
  return raw
    .replace(/^(\s*"name"\s*:\s*)"[^"]*"/m, (_m, p: string) => `${p}${JSON.stringify(`${brandName} Dashboard`)}`)
    .replace(/^(\s*"short_name"\s*:\s*)"[^"]*"/m, (_m, p: string) => `${p}${JSON.stringify(brandName)}`)
}

// Returns a short version token derived from app.js mtime+size so the
// script URL changes whenever the file changes, busting browser cache.
function appJsVersion(webDir: string): string {
  try {
    const s = statSync(join(webDir, 'app.js'))
    return `${s.mtimeMs.toString(36)}-${s.size.toString(36)}`
  } catch {
    return '0'
  }
}

function serveIndexHtml(ctx: RouteContext, webDir: string): void {
  const { req, res } = ctx
  try {
    const filePath = join(webDir, 'index.html')
    const s = statSync(filePath)
    const etag = `"${s.mtimeMs}-${s.size}-${appJsVersion(webDir)}"`
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    const html = readFileSync(filePath, 'utf-8').replace(
      /(<script\s+src=")\/app\.js(")/,
      `$1/app.js?v=${appJsVersion(webDir)}$2`,
    )
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      ETag: etag,
      'Cache-Control': 'no-cache',
    })
    res.end(html)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
}

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path } = ctx

  if (path === '/' || path === '/index.html') { serveIndexHtml(ctx, webDir); return true }
  if (path === '/style.css') { serveFile(req, res, join(webDir, 'style.css')); return true }
  if (path === '/app.js') { serveFile(req, res, join(webDir, 'app.js')); return true }
  if (path === '/manifest.json') {
    try {
      const raw = readFileSync(join(webDir, 'manifest.json'), 'utf-8')
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' })
      res.end(buildManifest(raw, BRAND_NAME))
    } catch {
      res.writeHead(404); res.end('Not found')
    }
    return true
  }
  if (path === '/sw.js') { serveFile(req, res, join(webDir, 'sw.js')); return true }

  if (path.startsWith('/lang/')) {
    const langFile = path.replace('/lang/', '')
    // Allowlist: only the two known language files (no path traversal).
    if (langFile === 'hu.js' || langFile === 'en.js') {
      serveFile(req, res, join(webDir, 'lang', langFile))
      return true
    }
    res.writeHead(404); res.end()
    return true
  }

  if (path.startsWith('/avatars/')) {
    const avatarFile = path.replace('/avatars/', '')
    const avatarPath = join(webDir, 'avatars', avatarFile)
    if (existsSync(avatarPath)) { serveFile(req, res, avatarPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path.startsWith('/icons/')) {
    const iconFile = path.replace('/icons/', '')
    const iconPath = join(webDir, 'icons', iconFile)
    if (existsSync(iconPath)) { serveFile(req, res, iconPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  return false
}
