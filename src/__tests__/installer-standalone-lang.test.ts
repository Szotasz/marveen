/**
 * MARVEENLANG1763 (Szotasz/marveen#1763): the README's one-liner
 *   curl -fsSL .../main/install-linux.sh -o install.sh && bash install.sh
 * stopped at once on line 27, `source "$(dirname "$0")/install-lang.sh"`: a script
 * downloaded on its own has no install-lang.sh next to it. The Windows/WSL wrapper
 * (/tmp/marveen-install.sh) hit the same line.
 *
 * What each part proves, on the REAL install-linux.sh: its exact prefix up to the
 * end of the language loader (the bytes a user runs), followed by an immediate
 * exit, so nothing past the loader ever runs on this host. A local HTTP server
 * plays raw.githubusercontent.com and serves this checkout's install-lang.sh.
 * - From an EMPTY directory, the README's exact command shape (curl -o install.sh
 *   && bash install.sh), and the Windows/WSL wrapper's shape (downloaded into a
 *   tmp dir as marveen-install.sh, run from another cwd), get past the loader: the language works (hu and en),
 *   the file came from the ref in MARVEEN_REF (default main), the temp copy is
 *   removed.
 * - With install-lang.sh next to the script (a checkout, the Bridge), it is
 *   sourced from there and nothing is downloaded: unchanged behaviour.
 * - A 404 or a file without `_t()` stops with a bilingual message and exit 1,
 *   nothing sourced, nothing left behind.
 * - Pins: one Bridge derive anchor, the clone uses the same ref, bash -n.
 * Runs with the `bash` on PATH (bash 5 on the Linux CI, 3.2 on macOS) and also
 * /bin/bash when it is a different binary.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = readFileSync(join(ROOT, 'install-linux.sh'), 'utf8')
const LANG = readFileSync(join(ROOT, 'install-lang.sh'), 'utf8')
const END = '# end of the install-lang loader (MARVEENLANG1763)\n'

// The real script up to the end of the loader, then stop: what a user runs, minus
// every install step.
const PREFIX = `${SCRIPT.slice(0, SCRIPT.indexOf(END) + END.length)}printf 'LANG_OK:%s\\n' "$(_t section_1)"\nexit 0\n`

// ASYNC on purpose: the HTTP server below lives in THIS process, and spawnSync
// would block its event loop, so curl would wait forever (deadlock).
function run(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string> }) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => { stdout += d })
    c.stderr.on('data', (d) => { stderr += d })
    const t = setTimeout(() => c.kill('SIGKILL'), 20_000)
    c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }) })
  })
}

let server: Server
let base = ''
const hits: string[] = []
let mode: 'ok' | '404' | 'garbage' = 'ok'

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url || '')
    const m = /^\/([^/]+)\/(install-lang\.sh|install-linux\.sh)$/.exec(req.url || '')
    if (!m || mode === '404') { res.statusCode = 404; res.end('404: Not Found'); return }
    if (m[2] === 'install-linux.sh') { res.end(PREFIX); return }
    res.end(mode === 'garbage' ? '<html>not a script</html>\n' : LANG)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
})
afterAll(() => { server.close() })

const shells = (() => {
  const list = ['bash']
  try {
    const onPath = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
    if (existsSync('/bin/bash') && onPath && realpathSync(onPath) !== realpathSync('/bin/bash')) list.push('/bin/bash')
  } catch { /* bash on PATH only */ }
  return list
})()

async function readmeRun(shell: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-standalone-'))
  const tmp = mkdtempSync(join(tmpdir(), 'marveen-tmpdir-'))
  const ref = env.MARVEEN_REF || 'main'
  // The README's command, pointed at the local server instead of raw.githubusercontent.com.
  const cmd = `curl -fsSL ${base}/${ref}/install-linux.sh -o install.sh && ${shell} install.sh`
  const r = await run(shell, ['-c', cmd], {
    cwd: dir,
    env: { PATH: process.env.PATH || '', HOME: dir, TMPDIR: tmp, TERM: 'xterm-256color', MARVEEN_RAW_BASE: base, ...env },
  })
  const leftovers = readdirSync(tmp)
  rmSync(dir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  return { ...r, leftovers }
}

describe.each(shells)('install-linux.sh run on its own (%s)', (shell) => {
  it('the README one-liner from an empty directory gets past the language loader (hu)', async () => {
    mode = 'ok'; hits.length = 0
    const r = await readmeRun(shell)
    expect(r.stderr).not.toMatch(/install-lang\.sh: No such file/)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('LANG_OK:[1/7] Előfeltételek ellenőrzése...')
    expect(hits).toEqual(['/main/install-linux.sh', '/main/install-lang.sh'])
    expect(r.leftovers).toEqual([])
  })

  it('English, and the language file comes from MARVEEN_REF', async () => {
    mode = 'ok'; hits.length = 0
    const r = await readmeRun(shell, { MARVEEN_LANG: 'en', MARVEEN_REF: 'feature-x' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('LANG_OK:[1/7] Checking prerequisites...')
    expect(hits).toEqual(['/feature-x/install-linux.sh', '/feature-x/install-lang.sh'])
  })

  it('the Windows/WSL wrapper shape (install-windows.ps1:107): downloaded into a tmp dir as marveen-install.sh and run from there', async () => {
    mode = 'ok'; hits.length = 0
    // stand-in for /tmp (never the real one), and a different cwd, as `wsl -- bash -c` has
    const fakeTmp = mkdtempSync(join(tmpdir(), 'marveen-fake-slash-tmp-'))
    const cwd = mkdtempSync(join(tmpdir(), 'marveen-wsl-cwd-'))
    const lang = mkdtempSync(join(tmpdir(), 'marveen-tmpdir-'))
    const target = join(fakeTmp, 'marveen-install.sh')
    const cmd = `curl -fsSL ${base}/main/install-linux.sh -o ${target} && ${shell} ${target}`
    const r = await run(shell, ['-c', cmd], {
      cwd,
      env: { PATH: process.env.PATH || '', HOME: cwd, TMPDIR: lang, TERM: 'xterm-256color', MARVEEN_RAW_BASE: base },
    })
    const inFakeTmp = readdirSync(fakeTmp)
    const left = readdirSync(lang)
    for (const d of [fakeTmp, cwd, lang]) rmSync(d, { recursive: true, force: true })
    expect(r.stderr).not.toMatch(/install-lang\.sh: No such file/)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('LANG_OK:[1/7] Előfeltételek ellenőrzése...')
    expect(hits).toEqual(['/main/install-linux.sh', '/main/install-lang.sh'])
    // nothing but the downloaded script next to it, and no temp copy left
    expect(inFakeTmp).toEqual(['marveen-install.sh'])
    expect(left).toEqual([])
  })

  it('install-lang.sh next to the script (checkout, Bridge): sourced from there, nothing downloaded', async () => {
    mode = 'ok'; hits.length = 0
    const dir = mkdtempSync(join(tmpdir(), 'marveen-checkout-'))
    writeFileSync(join(dir, 'install-linux.sh'), PREFIX)
    writeFileSync(join(dir, 'install-lang.sh'), LANG)
    const r = await run(shell, [join(dir, 'install-linux.sh')], {
      env: { PATH: process.env.PATH || '', HOME: dir, TERM: 'xterm-256color', MARVEEN_RAW_BASE: base },
    })
    rmSync(dir, { recursive: true, force: true })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('LANG_OK:[1/7] Előfeltételek ellenőrzése...')
    expect(hits).toEqual([])
  })

  it('a 404 stops with a bilingual message and exit 1, nothing left behind', async () => {
    hits.length = 0
    // the script itself is served; only the language file 404s
    mode = 'ok'
    const dir = mkdtempSync(join(tmpdir(), 'marveen-standalone-'))
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-tmpdir-'))
    writeFileSync(join(dir, 'install.sh'), PREFIX)
    mode = '404'
    const r = await run(shell, ['install.sh'], {
      cwd: dir,
      env: { PATH: process.env.PATH || '', HOME: dir, TMPDIR: tmp, TERM: 'xterm-256color', MARVEEN_RAW_BASE: base },
    })
    const left = readdirSync(tmp)
    rmSync(dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true })
    mode = 'ok'
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('LANG_OK')
    expect(r.stderr).toContain('Hiba: a telepito nyelvi fajlja (install-lang.sh) nem toltheto le')
    expect(r.stderr).toContain("Error: the installer's language file (install-lang.sh) could not be downloaded")
    expect(r.stderr).toContain('git clone --branch main https://github.com/Szotasz/marveen.git')
    expect(left).toEqual([])
  })

  it('a downloaded file that does not define _t is refused, not sourced', async () => {
    hits.length = 0
    const dir = mkdtempSync(join(tmpdir(), 'marveen-standalone-'))
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-tmpdir-'))
    writeFileSync(join(dir, 'install.sh'), PREFIX)
    mode = 'garbage'
    const r = await run(shell, ['install.sh'], {
      cwd: dir,
      env: { PATH: process.env.PATH || '', HOME: dir, TMPDIR: tmp, TERM: 'xterm-256color', MARVEEN_RAW_BASE: base },
    })
    const left = readdirSync(tmp)
    rmSync(dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true })
    mode = 'ok'
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('LANG_OK')
    expect(left).toEqual([])
  })
})

describe('pins', () => {
  it('the loader ends with its marker, once', () => {
    expect(SCRIPT.split(END).length - 1).toBe(1)
  })
  it('exactly one Bridge derive anchor (marveen-bridge-installer HELPER_ANCHOR)', () => {
    expect(SCRIPT.split('# shellcheck source=install-lang.sh').length - 1).toBe(1)
  })
  it('the self-reclone uses the same ref as the language file', () => {
    expect(SCRIPT).toContain('MARVEEN_REF="${MARVEEN_REF:-main}"')
    expect(SCRIPT).toContain('git clone --depth 1 --branch "$MARVEEN_REF" https://github.com/Szotasz/marveen.git "$TARGET_DIR"')
  })
  it('install-lang.sh defines _t at a line start (the marker the loader checks)', () => {
    expect(LANG).toMatch(/^_t\(\) \{/m)
  })
  it('the whole script parses', () => {
    const r = spawnSync('bash', ['-n', join(ROOT, 'install-linux.sh')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  })
})
