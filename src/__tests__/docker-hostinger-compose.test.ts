// DOCKERUX1118 (Samu 80873): docker/hostinger-compose.yml is the file the "Deploy on Hostinger" button hands to
// Hostinger's Docker Manager, alone, from its raw URL. Its image tag is pinned to the release, so a release that does
// not update it would ship a button that installs the previous version: this test fails when the pinned default and
// package.json's version differ. The rest pins what the file must never have (the repository is not there).
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const HOSTINGER = readFileSync(join(ROOT, 'docker', 'hostinger-compose.yml'), 'utf-8')
const MAIN = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf-8')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version
// The YAML without its comments (a comment may name what the file must not hold).
const code = (text: string) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
/** The environment keys of the marveen service: the indented `KEY:` lines between `environment:` and `ports:`. */
function marveenEnvKeys(text: string): string[] {
  const svc = code(text).slice(code(text).indexOf('\n  marveen:\n'))
  const env = svc.slice(svc.indexOf('    environment:\n'), svc.indexOf('    ports:\n'))
  return [...env.matchAll(/^ {6}([A-Z_]+):/gm)].map((m) => m[1])
}

describe('docker/hostinger-compose.yml', () => {
  it('pins the marveen image to package.json\'s version (the release step updates both)', () => {
    const m = /image: ghcr\.io\/szotasz\/marveen:\$\{MARVEEN_VERSION:-([^}]+)\}/.exec(HOSTINGER)
    expect(m?.[1]).toBe(VERSION)
    // the same image repository as the main compose file
    expect(MAIN).toContain('image: ghcr.io/szotasz/marveen:${MARVEEN_VERSION:-latest}')
  })

  it('has no build: and no relative path: the button loads this file alone', () => {
    const c = code(HOSTINGER)
    expect(c).not.toMatch(/^\s*build:/m)
    expect(c).not.toMatch(/\s\.\.?\//)
  })

  // DOCKERHTTPS1119: the optional HTTPS proxy is the main file's caddy service byte for byte, its config written from
  // MARVEEN_DOMAIN at start (no mounted file, which this file could not ship), and only under the tls profile.
  it('the caddy service is the main file\'s, byte for byte, behind the tls profile, with no mounted file', () => {
    const block = (text: string) => {
      const start = text.indexOf('  # DOCKERHTTPS1119: the TLS proxy')
      const end = text.indexOf('\nvolumes:\n', start)
      return start < 0 || end < 0 ? '' : text.slice(start, end).trimEnd()
    }
    expect(block(MAIN).length).toBeGreaterThan(0)
    expect(block(HOSTINGER)).toBe(block(MAIN))
    expect(block(MAIN)).toContain('    profiles: ["tls"]\n')
    expect(code(block(MAIN))).not.toMatch(/^\s*- \.{0,2}\//m)
    for (const text of [MAIN, HOSTINGER]) {
      expect(text).toMatch(/^ {2}caddy-data:$/m)
      expect(text).toMatch(/^ {2}caddy-config:$/m)
    }
  })

  // The start script as compose hands it to sh ($$ -> $), with the config path moved into a temp dir and caddy replaced
  // by printing the config it would run (measured once in the caddy:2 image: caddy adapt accepts it).
  it('the caddy start script writes the HTTPS config for a host name and refuses anything else', () => {
    const lines = MAIN.slice(MAIN.indexOf('    command:\n      - |\n') + '    command:\n      - |\n'.length).split('\n')
    const script = lines.slice(0, lines.findIndex((l) => !l.startsWith('        '))).map((l) => l.slice(8)).join('\n')
    const dir = mkdtempSync(join(tmpdir(), 'caddy-start-'))
    try {
      const runnable = script.replace(/\$\$/g, '$').replace(/\/config\/Caddyfile/g, join(dir, 'Caddyfile')).replace(/^exec caddy run .*$/m, `cat ${join(dir, 'Caddyfile')}`)
      const run = (domain: string) => spawnSync('/bin/sh', ['-c', runnable], { env: { PATH: process.env.PATH, MARVEEN_DOMAIN: domain }, encoding: 'utf-8' })
      const ok = run('srv2127946.hstgr.cloud')
      expect(ok.status).toBe(0)
      expect(ok.stdout).toBe('{\n\tlog {\n\t\tformat filter {\n\t\t\twrap console\n\t\t\tfields {\n\t\t\t\trequest>uri regexp "[?].*" ""\n\t\t\t}\n\t\t}\n\t}\n}\nsrv2127946.hstgr.cloud {\n\theader Strict-Transport-Security "max-age=31536000"\n\theader Referrer-Policy "no-referrer"\n\treverse_proxy marveen:3421\n}\n')
      for (const bad of ['', 'a b', 'x{y', 'evil.example}\n:80 {', 'a;b']) {
        const r = run(bad)
        expect(r.status, JSON.stringify(bad)).toBe(1)
        expect(r.stderr).toContain('MARVEEN_DOMAIN must be')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('publishes the dashboard only on 127.0.0.1; 80 and 443 only for the caddy service', () => {
    const c = code(HOSTINGER)
    const published = [...c.matchAll(/^\s*- "([^"]*:\d+)"$/gm)].map((m) => m[1])
    expect(published).toEqual(['127.0.0.1:3420:3420', '80:80', '443:443'])
    const caddy = c.slice(c.indexOf('\n  caddy:\n'))
    expect(caddy).toContain('- "80:80"')
    expect(caddy).toContain('- "443:443"')
    expect(c.match(/^\s*ports:/gm)).toHaveLength(2)
  })

  it('every variable has a default (Docker Manager may ask for none)', () => {
    for (const m of code(HOSTINGER).matchAll(/\$\{([A-Z_]+)([^}]*)\}/g)) expect(m[2].startsWith(':-'), m[1]).toBe(true)
  })

  it('the marveen service gets the main file\'s environment (MARVEEN_DOMAIN included, DOCKERHTTPS1119)', () => {
    expect(marveenEnvKeys(HOSTINGER)).toEqual(marveenEnvKeys(MAIN))
    expect(marveenEnvKeys(HOSTINGER)).toContain('MARVEEN_DOMAIN')
    expect(marveenEnvKeys(HOSTINGER).length).toBeGreaterThan(4)
  })
})
