import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile, MIME } from '../http-helpers.js'
import { PROJECT_ROOT, STORE_DIR, BRAND_NAME } from '../../config.js'
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

// Returns a short version token derived from a web asset's mtime+size so the
// asset URL changes whenever the file changes, busting browser cache.
function assetVersion(webDir: string, fileName: string): string {
  try {
    const s = statSync(join(webDir, fileName))
    return `${s.mtimeMs.toString(36)}-${s.size.toString(36)}`
  } catch {
    return '0'
  }
}

// Pure HTML rewrite step: injects ?v= cache-busting tokens and bakes the brand
// name into the iOS title meta. Exported for unit testing.
export function rewriteIndexHtml(html: string, appVer: string, cssVer: string, brandName: string): string {
  return html
    .replace(
      // Matches <script src="/app.js"> AND <script type="module" src="/app.js">
      // (any attributes between <script and src=). The \b prevents partial
      // word matches; [^>]* skips over type="module" or similar attributes.
      /(<script\b[^>]*\ssrc=")\/app\.js(")/,
      `$1/app.js?v=${appVer}$2`,
    )
    .replace(
      /(<link\s+rel="stylesheet"\s+href=")\/css\/index\.css(")/,
      `$1/css/index.css?v=${cssVer}$2`,
    )
    .replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(">)/,
      `$1${escapeAttr(brandName)}$2`,
    )
}

// Regex that validates a web/modules/*.js filename (path-traversal guard).
// Only bare alphanumeric+hyphen+underscore names ending in .js are accepted.
export const MODULE_FILENAME_PATTERN = /^[a-zA-Z0-9_-]+\.js$/

// Regex that validates a web/css/**/*.css path (path-traversal guard).
// Accepts bare filenames (tokens.css) and one subdir deep (components/btn.css).
// No dots, no encoded characters, no parent traversal.
export const CSS_FILENAME_PATTERN = /^(?:[a-z0-9-]+\/)?[a-z0-9-]+\.css$/

function serveIndexHtml(ctx: RouteContext, webDir: string): void {
  const { req, res } = ctx
  try {
    const filePath = join(webDir, 'index.html')
    const s = statSync(filePath)
    // Both versioned asset tokens are part of the index ETag: a cached
    // index.html must be invalidated whenever the rewritten ?v= URLs change.
    const cssVer = assetVersion(webDir, 'css/index.css')
    const etag = `"${s.mtimeMs}-${s.size}-${assetVersion(webDir, 'app.js')}-${cssVer}"`
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    const html = rewriteIndexHtml(
      readFileSync(filePath, 'utf-8'),
      assetVersion(webDir, 'app.js'),
      cssVer,
      BRAND_NAME,
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
    if (existsSync(join(STORE_DIR, `marveen-avatar${ext}`))) return MIME[ext]
  }
  return null
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path } = ctx

  if (path === '/' || path === '/index.html') { serveIndexHtml(ctx, webDir); return true }
  // app.js/style.css URLs are versioned (?v=mtime-size, rewritten into
  // index.html above), so a long max-age is safe: any content change produces
  // a new URL. index.html itself stays no-cache.
  if (path === '/style.css') { serveFile(req, res, join(webDir, 'style.css'), { cacheSeconds: 86400 }); return true }
  if (path === '/app.js') { serveFile(req, res, join(webDir, 'app.js'), { cacheSeconds: 86400 }); return true }
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
    if (existsSync(avatarPath)) { serveFile(req, res, avatarPath, { cacheSeconds: 3600 }); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path.startsWith('/icons/')) {
    const iconFile = path.replace('/icons/', '')
    const iconPath = join(webDir, 'icons', iconFile)
    if (existsSync(iconPath)) { serveFile(req, res, iconPath, { cacheSeconds: 3600 }); return true }
    res.writeHead(404); res.end()
    return true
  }

  // CSS design-system files (web/css/**/*.css).
  // Path-traversal guard: only lowercase alphanumeric+hyphen names, optionally
  // one subdir deep (e.g. components/btn.css, features/sidebar.css).
  // Served with a long max-age: index.html injects a ?v= cache-bust token via
  // rewriteIndexHtml so content changes always produce a new URL.
  if (path.startsWith('/css/')) {
    const cssFile = path.slice('/css/'.length)
    if (CSS_FILENAME_PATTERN.test(cssFile)) {
      const cssPath = join(webDir, 'css', cssFile)
      if (existsSync(cssPath)) {
        serveFile(req, res, cssPath, { cacheSeconds: 86400 })
        return true
      }
    }
    res.writeHead(404); res.end()
    return true
  }

  // ES modules extracted from app.js during modularization (issue #3).
  // Path-traversal guard: only bare filenames matching [a-zA-Z0-9_-]+.js
  // are accepted -- no slashes, no dots, no encoded characters.
  // Modules are served no-cache (ETag revalidation) because their URLs are
  // not versioned in index.html; a stale cached module after a deploy would
  // mismatched the freshly-fetched HTML and cause fatal init errors.
  if (path.startsWith('/modules/')) {
    const moduleFile = path.slice('/modules/'.length)
    if (MODULE_FILENAME_PATTERN.test(moduleFile)) {
      const modulePath = join(webDir, 'modules', moduleFile)
      if (existsSync(modulePath)) {
        serveFile(req, res, modulePath)
        return true
      }
    }
    res.writeHead(404); res.end()
    return true
  }

  return false
}
