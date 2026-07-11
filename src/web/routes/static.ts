import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile, MIME } from '../http-helpers.js'
import { PROJECT_ROOT, BRAND_NAME } from '../../config.js'
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
    const html = readFileSync(filePath, 'utf-8')
      .replace(
        /(<script\s+src=")\/app\.js(")/,
        `$1/app.js?v=${appJsVersion(webDir)}$2`,
      )
      // Bake the iOS home-screen label into apple-mobile-web-app-title so an
      // installed PWA shows the configured main-agent name (BRAND_NAME), not the
      // bundled "Marveen" default. Done server-side (not JS) so it is reliable
      // at "Add to Home Screen" time regardless of script timing.
      .replace(
        /(<meta name="apple-mobile-web-app-title" content=")[^"]*(">)/,
        `$1${escapeAttr(BRAND_NAME)}$2`,
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

// Resolve the stored main-agent avatar's MIME type (null if none stored, so we
// keep the static fallback icons). Mirrors the /api/marveen/avatar route's
// extension probe order.
function detectAvatarType(): string | null {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (existsSync(join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`))) return MIME[ext]
  }
  return null
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path } = ctx

  if (path === '/' || path === '/index.html') { serveIndexHtml(ctx, webDir); return true }
  if (path === '/style.css') { serveFile(req, res, join(webDir, 'style.css')); return true }
  if (path === '/app.js') { serveFile(req, res, join(webDir, 'app.js')); return true }
  if (path === '/manifest.json') {
    // Brand the manifest (name/short_name -> BRAND_NAME, byte-preserving for the
    // shipped default via buildManifest) and, when a main-agent avatar is stored,
    // repoint the install icons at the live avatar so the home-screen / PWA icon
    // matches the browser favicon (<link rel="icon" href="/api/marveen/avatar">).
    // The declared icon MIME type is detected from the stored file -- Chrome drops
    // icons whose type lies. Falls back to the static manifest if anything fails.
    try {
      const branded = buildManifest(readFileSync(join(webDir, 'manifest.json'), 'utf-8'), BRAND_NAME)
      const avatarType = detectAvatarType()
      if (!avatarType) {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' })
        res.end(branded)
      } else {
        const manifest = JSON.parse(branded)
        manifest.icons = [
          { src: '/api/marveen/avatar', sizes: '192x192', type: avatarType, purpose: 'any' },
          { src: '/api/marveen/avatar', sizes: '512x512', type: avatarType, purpose: 'any' },
        ]
        res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' })
        res.end(JSON.stringify(manifest))
      }
    } catch {
      serveFile(req, res, join(webDir, 'manifest.json'))
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
