// BASHSANDBOX1022: headless Chrome cannot run inside Claude Code's Bash sandbox. Measured on the
// 2.1.306 Seatbelt profile: past the crashpad and ProcessSingleton denials (which allowWrite on the
// user temp dir plus allowUnixSockets get through) Chrome dies on a CHECK in base/mac/mac_util.mm,
// because the profile allows only a fixed list of sysctl names (hw.model, kern.hv_vmm_present,
// kern.boottime and 8 more read EPERM in the sandbox and fine on the host) and no setting widens it.
// A sandboxed agent's report PDF is therefore rendered HERE, by the dashboard, outside the sandbox
// -- and narrowly, so this does not become the network or file route the sandbox closed:
//   - only an existing .html file in, only a .pdf out, both under the agent's sandbox write roots
//     (realpath'd, so a symlink cannot walk out), size- and time-limited; the output directory is
//     checked again right before the PDF is moved into place;
//   - the HTML is read into memory once and served to Chrome from a one-document origin on
//     127.0.0.1 (every other path 404s), NOT opened as a file: a file:// page may pull other local
//     files into the PDF as subresources (an <iframe>/<object> of a file the agent itself is denied
//     reading -- security review of #2149), while an http page may not load file:// at all. The
//     test renders such a page both ways and checks the secret text reaches the PDF only via file://.
//     A self-contained report (data: images and fonts, as the fleet's renderer writes them) is
//     unaffected; a relative src/href is not served;
//   - a fixed argv, no shell, a throwaway profile;
//   - the network shut for the render: every request goes to a dead proxy on 127.0.0.1:9 with
//     loopback included (<-loopback>) except the document's own origin, every other hostname
//     resolves to NOTFOUND, and non-proxied WebRTC UDP is off. Scripts DO run: --blink-settings=
//     scriptEnabled=false made --print-to-pdf exit 0 without writing a PDF (Chrome 155, measured),
//     so the page's own fetch() is shut by the same network flags instead. The test renders a page
//     whose images, stylesheet and script all name a local listening server and shows it receives
//     nothing -- and that without these flags it does.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'

export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const MAX_HTML_BYTES = 10 * 1024 * 1024
export const MAX_PDF_BYTES = 50 * 1024 * 1024
export const RENDER_TIMEOUT_MS = 90_000

// `docOrigin` (host:port) is the one loopback origin let past the dead proxy: the document's own.
export function networkLockdownArgs(docOrigin: string | null): string[] {
  return [
    '--proxy-server=http://127.0.0.1:9',
    `--proxy-bypass-list=<-loopback>${docOrigin ? `;${docOrigin}` : ''}`,
    // 127.0.0.1 is excluded so the document's own origin resolves (the rule maps IP literals too:
    // without the exclusion the page failed with ERR_NAME_NOT_RESOLVED); its other ports still go
    // to the dead proxy, as only the document's host:port is in the bypass list.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

export function chromeArgs(profileDir: string, pdfOut: string, target: string, lockdown: string[] | null): string[] {
  return [
    '--headless', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${profileDir}`,
    ...(lockdown ?? []),
    `--print-to-pdf=${pdfOut}`, target,
  ]
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}
function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

// Where a PDF may be written: the realpath'd directory under one of the roots, a .pdf name, and not
// an existing symlink or directory (the file is replaced by rename, never written through a link).
export function resolvePdfPath(roots: string[], pdfPath: unknown): { pdf: string } | { error: string } {
  if (typeof pdfPath !== 'string') return { error: 'html_path and pdf_path must be strings' }
  if (pdfPath.includes('\0') || !isAbsolute(pdfPath)) return { error: 'html_path and pdf_path must be absolute paths' }
  if (!/\.pdf$/i.test(pdfPath)) return { error: 'pdf_path must end in .pdf' }
  const realRoots = roots.map(realOrNull).filter((r): r is string => r !== null)
  const dir = realOrNull(dirname(pdfPath))
  if (!dir || !statSync(dir).isDirectory()) return { error: 'the directory of pdf_path does not exist' }
  if (!realRoots.some((r) => inside(dir, r))) return { error: 'pdf_path is outside the agent\'s write roots' }
  const pdf = join(dir, basename(pdfPath))
  let existing: ReturnType<typeof lstatSync> | null = null
  try { existing = lstatSync(pdf) } catch { /* a new file */ }
  if (existing && !existing.isFile()) return { error: 'pdf_path exists and is not a regular file' }
  return { pdf }
}

export type RenderPaths = { html: string; pdf: string } | { error: string }

// Both paths must be absolute and land, after symlinks are resolved, under one of the roots.
export function resolveRenderPaths(roots: string[], htmlPath: unknown, pdfPath: unknown): RenderPaths {
  if (typeof htmlPath !== 'string' || typeof pdfPath !== 'string') return { error: 'html_path and pdf_path must be strings' }
  if (htmlPath.includes('\0') || pdfPath.includes('\0') || !isAbsolute(htmlPath) || !isAbsolute(pdfPath)) return { error: 'html_path and pdf_path must be absolute paths' }
  const realRoots = roots.map(realOrNull).filter((r): r is string => r !== null)
  if (!realRoots.length) return { error: 'the agent has no existing write root' }
  if (!/\.html?$/i.test(htmlPath)) return { error: 'html_path must end in .html or .htm' }
  const html = realOrNull(htmlPath)
  if (!html || !statSync(html).isFile()) return { error: 'html_path is not an existing file' }
  if (!realRoots.some((r) => inside(html, r))) return { error: 'html_path is outside the agent\'s write roots' }
  if (statSync(html).size > MAX_HTML_BYTES) return { error: `html_path is larger than ${MAX_HTML_BYTES} bytes` }
  const out = resolvePdfPath(realRoots, pdfPath)
  return 'error' in out ? out : { html, pdf: out.pdf }
}

type ChromeResult = { ok: true; pdf: Buffer } | { ok: false; error: string; busy?: boolean }

let running = 0
export const MAX_CONCURRENT_RENDERS = 2

// One Chrome print of `target` (a URL, or a path for the test's file:// control) into a private temp
// dir; resolves with the PDF bytes or an error message, never throws.
export function runChromePdf(target: string, lockdown: string[] | null, opts: { chrome?: string; timeoutMs?: number } = {}): Promise<ChromeResult> {
  const chrome = opts.chrome ?? DEFAULT_CHROME_PATH
  if (!existsSync(chrome)) return Promise.resolve({ ok: false, error: `Chrome not found at ${chrome}` })
  if (running >= MAX_CONCURRENT_RENDERS) return Promise.resolve({ ok: false, error: 'renderer busy, retry shortly', busy: true })
  running++
  const work = mkdtempSync(join(tmpdir(), 'marveen-pdf-'))
  const out = join(work, 'out.pdf')
  return new Promise((resolve) => {
    execFile(chrome, chromeArgs(join(work, 'profile'), out, target, lockdown),
      { timeout: opts.timeoutMs ?? RENDER_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, _stdout, stderr) => {
        try {
          if (!existsSync(out)) {
            resolve({ ok: false, error: `Chrome produced no PDF (${err ? (err.killed ? 'timed out' : `exit ${err.code ?? '?'}`) : 'exit 0'}): ${String(stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` })
            return
          }
          const size = statSync(out).size
          if (size > MAX_PDF_BYTES) { resolve({ ok: false, error: `the PDF is larger than ${MAX_PDF_BYTES} bytes` }); return }
          resolve({ ok: true, pdf: readFileSync(out) })
        } catch (e) {
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
        } finally {
          running--
          rmSync(work, { recursive: true, force: true })
        }
      })
  })
}

// Renders an HTML document held in memory: served once from 127.0.0.1 on a random port, the
// network otherwise shut. `lockdown: false` is the test's control only.
export async function renderHtmlToPdf(html: Buffer, opts: { chrome?: string; timeoutMs?: number; lockdown?: boolean } = {}): Promise<ChromeResult> {
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/doc.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const origin = `127.0.0.1:${(srv.address() as AddressInfo).port}`
    return await runChromePdf(`http://${origin}/doc.html`, opts.lockdown === false ? null : networkLockdownArgs(origin), opts)
  } finally {
    srv.close()
  }
}

// Writes rendered bytes to pdf_path after checking the destination AGAIN: the directory could have
// been swapped for a link to somewhere else while Chrome ran.
export function writeRenderedPdf(roots: string[], pdfPath: string, pdf: Buffer): { ok: true; pdf: string } | { ok: false; error: string } {
  const out = resolvePdfPath(roots, pdfPath)
  if ('error' in out) return { ok: false, error: out.error }
  atomicWriteFileSync(out.pdf, pdf)
  return { ok: true, pdf: out.pdf }
}
