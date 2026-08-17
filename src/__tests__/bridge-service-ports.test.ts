import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  validateBridgeServicePorts,
  restrictOptionsWithServices,
  extractServicePorts,
  rewriteServicePorts,
  restrictOptions,
  MAX_BRIDGE_SERVICE_PORTS,
} from '../remote-enroll-core.js'
import { updateEnrolledServicePorts } from '../remote-enroll-fs.js'

// BRIDGEPORT817. The permitopen list in authorized_keys is the REAL boundary
// of the Bridge's service-tab feature; these tests pin the policy (validate),
// the grant shape (options builder), and the rewrite (only our line, options
// rebuilt from scratch). The live-sshd red probe -- a direct forward attempt
// with the key, no Bridge involved -- runs in the PR's verification, not here.

const WEB = 3420
const ID = '0f81a9a2-08d6-4f4c-9a09-93e35ad27182'
const B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIFakefakefakefakefakefakefakefakefakefake'
const OUR_LINE = `${restrictOptions(WEB)} ssh-ed25519 ${B64} marveen-remote:${ID}`
const FOREIGN_LINE = 'ssh-rsa AAAAB3Nza... someone@laptop'

describe('validateBridgeServicePorts (policy -- decided server-side)', () => {
  it('accepts a plain list, sorted and deduplicated, webPort implicit', () => {
    const v = validateBridgeServicePorts([8443, 4007, 4007, WEB], WEB)
    expect(v).toEqual({ ok: true, ports: [4007, 8443] })
  })

  it('refuses privileged ports on both sides of the boundary (22 included)', () => {
    expect(validateBridgeServicePorts([1023], WEB).ok).toBe(false)
    expect(validateBridgeServicePorts([1024], WEB)).toEqual({ ok: true, ports: [1024] })
    expect(validateBridgeServicePorts([22], WEB).ok).toBe(false)
    expect(validateBridgeServicePorts([65535], WEB)).toEqual({ ok: true, ports: [65535] })
    expect(validateBridgeServicePorts([65536], WEB).ok).toBe(false)
  })

  it('refuses non-integers and non-arrays', () => {
    expect(validateBridgeServicePorts([40.7], WEB).ok).toBe(false)
    expect(validateBridgeServicePorts(['4007' as unknown as number], WEB).ok).toBe(false)
    expect(validateBridgeServicePorts('4007', WEB).ok).toBe(false)
    expect(validateBridgeServicePorts(undefined, WEB).ok).toBe(false)
  })

  it('caps the list so an allowlist can never approximate a wildcard', () => {
    const max = Array.from({ length: MAX_BRIDGE_SERVICE_PORTS }, (_, i) => 5000 + i)
    expect(validateBridgeServicePorts(max, WEB).ok).toBe(true)
    expect(validateBridgeServicePorts([...max, 6000], WEB).ok).toBe(false)
  })
})

describe('restrictOptionsWithServices (the grant shape)', () => {
  it('keeps restrict + forced command, webPort first, explicit ports only', () => {
    expect(restrictOptionsWithServices(WEB, [4007, 8443])).toBe(
      'restrict,port-forwarding,permitopen="127.0.0.1:3420",permitopen="127.0.0.1:4007",permitopen="127.0.0.1:8443",command="/bin/false"',
    )
  })

  it('with no service ports it equals the enrollment default exactly', () => {
    expect(restrictOptionsWithServices(WEB, [])).toBe(restrictOptions(WEB))
  })

  it('never emits a wildcard, whatever the input', () => {
    const line = restrictOptionsWithServices(WEB, [4007])
    expect(line).not.toContain('*')
    expect(line.match(/permitopen="127\.0\.0\.1:\d+"/g)?.length).toBe(2)
  })
})

describe('extractServicePorts', () => {
  it('legacy single-port line yields no service ports', () => {
    expect(extractServicePorts(restrictOptions(WEB), WEB)).toEqual([])
  })
  it('multi-port options yield the sorted service set minus webPort', () => {
    expect(extractServicePorts(restrictOptionsWithServices(WEB, [8443, 4007]), WEB)).toEqual([4007, 8443])
  })
})

describe('rewriteServicePorts (only our line, options rebuilt from scratch)', () => {
  const FILE = `${FOREIGN_LINE}\n${OUR_LINE}\n`

  it('rewrites the target line, preserves every other byte, reports before/after', () => {
    const r = rewriteServicePorts(FILE, ID, WEB, [4007])
    expect(r.found).toBe(true)
    expect(r.before).toEqual([])
    expect(r.after).toEqual([4007])
    const lines = r.content.split('\n')
    expect(lines[0]).toBe(FOREIGN_LINE)
    expect(lines[1]).toBe(`${restrictOptionsWithServices(WEB, [4007])} ssh-ed25519 ${B64} marveen-remote:${ID}`)
    expect(r.content.endsWith('\n')).toBe(true)
  })

  it('narrowing back to [] restores the exact enrollment-default line', () => {
    const widened = rewriteServicePorts(FILE, ID, WEB, [4007]).content
    const narrowed = rewriteServicePorts(widened, ID, WEB, [])
    expect(narrowed.before).toEqual([4007])
    expect(narrowed.after).toEqual([])
    expect(narrowed.content).toBe(FILE)
  })

  it('a hand-edited options field cannot smuggle a grant through a rewrite', () => {
    // Someone edited OUR line to also permit 6666; the rewrite rebuilds the
    // options from scratch, so the smuggled grant does not survive.
    const tampered = FILE.replace(
      restrictOptions(WEB),
      `restrict,port-forwarding,permitopen="127.0.0.1:${WEB}",permitopen="127.0.0.1:6666",command="/bin/false"`,
    )
    const r = rewriteServicePorts(tampered, ID, WEB, [4007])
    expect(r.before).toEqual([6666])
    expect(r.content).not.toContain('6666')
  })

  it('unknown install id: found:false, content unchanged shape', () => {
    const r = rewriteServicePorts(FILE, 'f0000000-0000-4000-8000-000000000000', WEB, [4007])
    expect(r.found).toBe(false)
    expect(r.content).toBe(FILE)
  })

  it('a line carrying our comment but a foreign shape is not ours to rewrite', () => {
    const odd = `command="uptime" ssh-rsa ${B64} extra marveen-remote:${ID}\n`
    const r = rewriteServicePorts(odd, ID, WEB, [4007])
    expect(r.found).toBe(false)
    expect(r.content).toBe(odd)
  })
})

describe('updateEnrolledServicePorts (fs, temp dir)', () => {
  it('rewrites under lock, keeps 0600, reports before/after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-svc-ports-'))
    const authPath = join(dir, 'authorized_keys')
    writeFileSync(authPath, `${FOREIGN_LINE}\n${OUR_LINE}\n`, { mode: 0o600 })
    const r = await updateEnrolledServicePorts({ sshDir: dir, installId: ID, webPort: WEB, ports: [4007, 8443] })
    expect(r.found).toBe(true)
    expect(r.after).toEqual([4007, 8443])
    const content = readFileSync(authPath, 'utf8')
    expect(content).toContain('permitopen="127.0.0.1:4007"')
    expect(content.split('\n')[0]).toBe(FOREIGN_LINE)
    expect(statSync(authPath).mode & 0o777).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })

  it('missing file or missing line: found:false, nothing written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-svc-ports-'))
    const none = await updateEnrolledServicePorts({ sshDir: dir, installId: ID, webPort: WEB, ports: [4007] })
    expect(none.found).toBe(false)
    writeFileSync(join(dir, 'authorized_keys'), `${FOREIGN_LINE}\n`, { mode: 0o600 })
    const miss = await updateEnrolledServicePorts({ sshDir: dir, installId: ID, webPort: WEB, ports: [4007] })
    expect(miss.found).toBe(false)
    expect(readFileSync(join(dir, 'authorized_keys'), 'utf8')).toBe(`${FOREIGN_LINE}\n`)
    rmSync(dir, { recursive: true, force: true })
  })
})
