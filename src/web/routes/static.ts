import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile } from '../http-helpers.js'
import { MIME } from '../http-helpers.js'
import type { RouteContext } from './types.js'

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
  if (path === '/manifest.json') { serveFile(req, res, join(webDir, 'manifest.json')); return true }
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
