// DOCKERUX1118 (Samu 80873): docker/hostinger-compose.yml is the file the "Deploy on Hostinger" button hands to
// Hostinger's Docker Manager, alone, from its raw URL. Its image tag is pinned to the release, so a release that does
// not update it would ship a button that installs the previous version: this test fails when the pinned default and
// package.json's version differ. The rest pins what the file must never have (the repository is not there).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

  it('has no build:, no relative path and no Caddy: the button loads this file alone', () => {
    const c = code(HOSTINGER)
    expect(c).not.toMatch(/^\s*build:/m)
    expect(c).not.toMatch(/\s\.\.?\//)
    expect(c).not.toMatch(/caddy/i)
  })

  it('publishes only the dashboard, and only on 127.0.0.1', () => {
    const c = code(HOSTINGER)
    const published = [...c.matchAll(/^\s*- "([^"]*:\d+)"$/gm)].map((m) => m[1])
    expect(published).toEqual(['127.0.0.1:3420:3420'])
    expect(c.match(/^\s*ports:/gm)).toHaveLength(1)
  })

  it('every variable has a default (Docker Manager may ask for none)', () => {
    for (const m of code(HOSTINGER).matchAll(/\$\{([A-Z_]+)([^}]*)\}/g)) expect(m[2].startsWith(':-'), m[1]).toBe(true)
  })

  it('the marveen service gets the main file\'s environment, without the tls profile\'s MARVEEN_DOMAIN', () => {
    expect(marveenEnvKeys(HOSTINGER)).toEqual(marveenEnvKeys(MAIN).filter((k) => k !== 'MARVEEN_DOMAIN'))
    expect(marveenEnvKeys(HOSTINGER).length).toBeGreaterThan(4)
  })
})
