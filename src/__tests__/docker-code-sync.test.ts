// HOSTINGERDOCKER1107: docker/code-sync.py, the container's code copy into the install volume (Dani 72670: atomic,
// verified after the copy, a half-copied tree never starts). Runs the real script against temp layouts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const SCRIPT = join(__dirname, '..', '..', 'docker', 'code-sync.py')
let root = ''
let img = '', dst = '', meta = ''

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// The manifest the Dockerfile writes: "F <sha256> ./path" per file, "L <target> ./path" per symlink, sorted.
function buildImage(files: Record<string, string>, links: Record<string, string> = {}): void {
  rmSync(img, { recursive: true, force: true })
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(img, rel, '..'), { recursive: true })
    writeFileSync(join(img, rel), body)
  }
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(join(img, rel, '..'), { recursive: true })
    symlinkSync(target, join(img, rel))
  }
  const rows = walk(img).map((p) => {
    const rel = './' + relative(img, p)
    const target = links[relative(img, p)]
    return target !== undefined ? `L ${target} ${rel}` : `F ${createHash('sha256').update(readFileSync(p)).digest('hex')} ${rel}`
  }).sort()
  const manifest = rows.join('\n') + '\n'
  writeFileSync(join(meta, 'image.manifest'), manifest)
  writeFileSync(join(meta, 'image.id'), createHash('sha256').update(manifest).digest('hex') + '\n')
}

function sync(extraEnv: Record<string, string> = {}) {
  const r = spawnSync('python3', ['-I', SCRIPT], {
    env: { PATH: process.env.PATH ?? '', MARVEEN_IMAGE_DIR: img, MARVEEN_INSTALL_DIR: dst, MARVEEN_DOCKER_DIR: meta, ...extraEnv },
    encoding: 'utf8',
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'geri-codesync-'))
  img = join(root, 'image'); dst = join(root, 'install'); meta = join(root, 'meta')
  for (const d of [img, dst, meta]) mkdirSync(d, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('docker/code-sync.py', () => {
  it('first start: copies the code, verifies it, records the image id; the state next to it is untouched', () => {
    buildImage({ 'dist/index.js': 'v1', 'scripts/channels.sh': '#!/bin/bash', 'package.json': '{}' }, { 'node_modules/.bin/tsc': '../typescript/bin/tsc' })
    writeFileSync(join(dst, '.env'), 'SECRET=1\n')
    mkdirSync(join(dst, 'store')); writeFileSync(join(dst, 'store', 'claudeclaw.db'), 'db')
    const r = sync()
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(dst, 'dist', 'index.js'), 'utf8')).toBe('v1')
    expect(readFileSync(join(dst, '.image-id'), 'utf8').trim()).toBe(readFileSync(join(meta, 'image.id'), 'utf8').trim())
    expect(readFileSync(join(dst, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(join(dst, 'store', 'claudeclaw.db'), 'utf8')).toBe('db')
    expect(existsSync(join(dst, '.code-sync-pending'))).toBe(false)
    expect(readdirSync(dst).filter((e) => e.startsWith('.code-stage') || e.startsWith('.code-old'))).toEqual([])
  })

  it('the same image again: nothing is copied', () => {
    buildImage({ 'dist/index.js': 'v1' })
    expect(sync().code).toBe(0)
    writeFileSync(join(dst, 'dist', 'index.js'), 'touched by hand')
    const r = sync()
    expect(r.code).toBe(0)
    expect(r.out).toContain('code is current')
    expect(readFileSync(join(dst, 'dist', 'index.js'), 'utf8')).toBe('touched by hand')
  })

  it('a new image: the code is replaced, a code entry it no longer has goes, the state stays', () => {
    buildImage({ 'dist/index.js': 'v1', 'old-tool/x.sh': 'old' })
    expect(sync().code).toBe(0)
    mkdirSync(join(dst, 'workspace')); writeFileSync(join(dst, 'workspace', 'note.md'), 'mine')
    buildImage({ 'dist/index.js': 'v2' })
    const r = sync()
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(dst, 'dist', 'index.js'), 'utf8')).toBe('v2')
    expect(existsSync(join(dst, 'old-tool'))).toBe(false)
    expect(readFileSync(join(dst, 'workspace', 'note.md'), 'utf8')).toBe('mine')
  })

  it('the dashboard-written .claude/settings*.json are kept over the image\'s', () => {
    buildImage({ '.claude/settings.json': '{"image":1}', '.claude/settings.local.json': '{"image":1}', 'dist/index.js': 'v1' })
    mkdirSync(join(dst, '.claude'))
    writeFileSync(join(dst, '.claude', 'settings.json'), '{"hooks":"mine"}')
    const r = sync()
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(join(dst, '.claude', 'settings.json'), 'utf8')).toBe('{"hooks":"mine"}')
    expect(readFileSync(join(dst, '.claude', 'settings.local.json'), 'utf8')).toBe('{"image":1}')
  })

  it('a copy that does not match the manifest is refused before anything is swapped', () => {
    buildImage({ 'dist/index.js': 'v1' })
    writeFileSync(join(img, 'dist', 'index.js'), 'changed after the manifest')
    const r = sync()
    expect(r.code).toBe(3)
    expect(existsSync(join(dst, 'dist'))).toBe(false)
    expect(existsSync(join(dst, '.image-id'))).toBe(false)
  })

  it('a symlink with another target is a mismatch too', () => {
    buildImage({ 'a.txt': 'a' }, { 'link': 'a.txt' })
    rmSync(join(img, 'link')); symlinkSync('elsewhere', join(img, 'link'))
    expect(sync().code).toBe(3)
  })

  it('an interrupted sync (the marker left behind) is done again even when the id matches', () => {
    buildImage({ 'dist/index.js': 'v1' })
    expect(sync().code).toBe(0)
    writeFileSync(join(dst, 'dist', 'index.js'), 'half')
    writeFileSync(join(dst, '.code-sync-pending'), 'x\n')
    const r = sync()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('interrupted sync is redone')
    expect(readFileSync(join(dst, 'dist', 'index.js'), 'utf8')).toBe('v1')
    expect(existsSync(join(dst, '.code-sync-pending'))).toBe(false)
  })

  it('a tree that differs from the image after the swap: refused, the marker stays, no id recorded', () => {
    buildImage({ 'dist/index.js': 'v1', 'web/app.js': 'app' })
    // The module itself, with os.rename wrapped: the swapped-in dist/ gets one byte changed, as a broken disk would.
    const harness = [
      'import importlib.util, os, sys',
      `spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(SCRIPT)})`,
      'cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)',
      'real = os.rename',
      'def rename(a, b):',
      '    real(a, b)',
      '    if b.endswith("/dist") and ".code-stage" in a:',
      '        open(os.path.join(b, "index.js"), "a").write("x")',
      'cs.os.rename = rename',
      'sys.exit(cs.main())',
    ].join('\n')
    const r = spawnSync('python3', ['-I', '-c', harness], {
      env: { PATH: process.env.PATH ?? '', MARVEEN_IMAGE_DIR: img, MARVEEN_INSTALL_DIR: dst, MARVEEN_DOCKER_DIR: meta },
      encoding: 'utf8',
    })
    expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(4)
    expect(existsSync(join(dst, '.code-sync-pending'))).toBe(true)
    expect(existsSync(join(dst, '.image-id'))).toBe(false)
    // and the next (clean) start redoes it
    const again = sync()
    expect(again.code, again.out).toBe(0)
    expect(readFileSync(join(dst, 'dist', 'index.js'), 'utf8')).toBe('v1')
  })

  it('no image id: refuses', () => {
    buildImage({ 'dist/index.js': 'v1' })
    rmSync(join(meta, 'image.id'))
    expect(sync().code).toBe(2)
  })
})
