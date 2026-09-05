/**
 * MIOCLISKILL831 -- a `marveen skill` parancs TISZTA magja: kanonikus JSON,
 * HMAC-alairas, attesztacio-osszeallitas. Se halozat, se fajlrendszer, se
 * process.env -- igy tesztelheto anelkul, hogy barmit telepitenenk vagy
 * hivnank. A mellekhatasok a skill-cli-fs.ts-ben ulnek, a parancs-vaz a
 * scripts/skill.ts-ben (ugyanaz a harmas, mint a remote-enroll-nel).
 *
 * A KONTRAKT NEM ITT SZULETIK: a mio-attestation v1 alakot a marveen-io
 * upload-api/attestation.ts hatarozza meg, es a kanonikalizalas a mio-upload
 * kliens PONTOS python-hivasa: json.dumps(sort_keys=True,
 * separators=(",",":"), ensure_ascii=False) a hmac mezo NELKUL.
 *
 * ES EZT NEM PROZABAN KOTJUK OSSZE, HANEM ADATTAL: a megosztott
 * teszt-vektorok (attestation-vectors.json) ugyanazok, amiket a Python
 * kliens es a Deno szerver is hasznal. Ha a harom implementacio barmelyike
 * elcsuszik, a vektor-teszt bukik -- nem egy code review-n mulik.
 */
import { createHash, createHmac } from 'node:crypto'

export const ATTESTATION_VERSION = 1

export interface AttestationCheck {
  id: 'prompt_injection' | 'pii'
  result: 'clean' | 'flagged'
  hits: number
}

export interface Attestation {
  v: number
  key_id: string
  member_id: string
  content_sha256: string
  scanner: { name: string; version: string; rulepack: string }
  checks: AttestationCheck[]
  scanned_at: string
  hmac: string
}

/**
 * Kanonikus JSON: rekurzivan rendezett OBJEKTUM-kulcsok, tomor elvalasztok,
 * a nem-ASCII karakterek escape NELKUL. A TOMBOK sorrendje NEM valtozik --
 * a python json.dumps sem rendezi at a listakat, es a `checks` sorrendje
 * resze az alairt uzenetnek.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}

/** Az alairt uzenet: az attesztacio a `hmac` mezo NELKUL, kanonikus alakban. */
export function attestationPayload(att: Omit<Attestation, 'hmac'>): string {
  return canonicalJson(att)
}

export function signAttestation(att: Omit<Attestation, 'hmac'>, attestKey: string): string {
  return createHmac('sha256', attestKey).update(attestationPayload(att), 'utf8').digest('hex')
}

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface ScanSummary {
  scanner: { name: string; version: string; rulepack: string }
  /** Hany talalat esett az egyes kategoriakba. */
  injectionHits: number
  piiHits: number
}

/**
 * Attesztacio osszeallitasa. A `checks` MINDIG mindket kategoriat tartalmazza,
 * es a szerver `allChecksClean` ellenorzese miatt egy flagged ag SOSEM jut el
 * ide: a CLI mar a felkuldes elott tagad. A fuggveny megis kepes flagged
 * allapotot leirni, mert egy attesztacio, ami csak "tiszta"-t tud mondani,
 * nem allitas, hanem dekoracio.
 */
export function buildAttestation(input: {
  keyId: string
  memberId: string
  contentSha256: string
  scan: ScanSummary
  scannedAt: string
  attestKey: string
}): Attestation {
  const torzs: Omit<Attestation, 'hmac'> = {
    v: ATTESTATION_VERSION,
    key_id: input.keyId,
    member_id: input.memberId,
    content_sha256: input.contentSha256,
    scanner: input.scan.scanner,
    checks: [
      {
        id: 'prompt_injection',
        result: input.scan.injectionHits > 0 ? 'flagged' : 'clean',
        hits: input.scan.injectionHits,
      },
      { id: 'pii', result: input.scan.piiHits > 0 ? 'flagged' : 'clean', hits: input.scan.piiHits },
    ],
    scanned_at: input.scannedAt,
  }
  return { ...torzs, hmac: signAttestation(torzs, input.attestKey) }
}

/**
 * A `scanned_at` alakja kotott a szerveren:
 * ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$ -- a JS toISOString
 * ezredmasodperceket ad, ami megfelel, de a Z-t kotelezo megtartani.
 */
export function attestationTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
