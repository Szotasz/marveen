import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attestationPayload,
  attestationTimestamp,
  buildAttestation,
  canonicalJson,
  signAttestation,
} from '../skill-cli-core.js'

/**
 * A HAROM IMPLEMENTACIOT ADAT KOTI OSSZE, NEM PROZA. Ezek ugyanazok a
 * vektorok, amiket a Python kliens (mio-upload) es a Deno szerver
 * (upload-api/attestation.ts) is hasznal; a fajl a marveen-io repobol
 * koltozott ide valtozatlanul. Ha barmelyik implementacio elcsuszik a
 * kanonikalizalasban vagy az alairasban, ITT bukik, nem egy code review-n.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const vektorok = JSON.parse(
  readFileSync(join(HERE, 'fixtures/attestation-vectors.json'), 'utf8'),
) as {
  key: string
  valid: { attestation: Record<string, unknown>; canonical_without_hmac: string }
  /**
   * MAS AZ ALAKJA, mint a `valid`-nak, es ezt kimondom, mert eloszor a NEVEBOL
   * kovetkeztettem ra: nem egy teljes attesztacio, hanem egy tetszoleges ertek
   * kanonikalizalasa + HMAC-ja -- pont a nem-ASCII kezelesre.
   */
  nonascii_algorithm_case?: { value: unknown; canonical: string; hmac: string }
}

function torzsHmacNelkul(att: Record<string, unknown>) {
  const { hmac: _elhagyva, ...tobbi } = att
  return tobbi
}

describe('attesztacio -- megosztott vektorok', () => {
  it('a kanonikus alak BAJTRA egyezik a vektorral', () => {
    expect(attestationPayload(torzsHmacNelkul(vektorok.valid.attestation) as never)).toBe(
      vektorok.valid.canonical_without_hmac,
    )
  })

  it('az HMAC egyezik a vektoreval', () => {
    expect(signAttestation(torzsHmacNelkul(vektorok.valid.attestation) as never, vektorok.key)).toBe(
      vektorok.valid.attestation.hmac,
    )
  })

  const nonascii = vektorok.nonascii_algorithm_case
  if (nonascii) {
    it('NEM-ASCII eset: a kanonikus alak es az HMAC is egyezik (ensure_ascii=False)', () => {
      expect(canonicalJson(nonascii.value)).toBe(nonascii.canonical)
      expect(
        createHmac('sha256', vektorok.key).update(canonicalJson(nonascii.value), 'utf8').digest('hex'),
      ).toBe(nonascii.hmac)
    })
  }

  it('KONTROLL: mas kulccsal MAS HMAC jon (a teszt tud bukni is)', () => {
    const torzs = torzsHmacNelkul(vektorok.valid.attestation) as never
    expect(signAttestation(torzs, vektorok.key + 'x')).not.toBe(vektorok.valid.attestation.hmac)
  })
})

describe('kanonikalizalas', () => {
  it('az OBJEKTUM-kulcsokat rendezi', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('a TOMB sorrendjet NEM rendezi at (a checks sorrendje resze az alairt uzenetnek)', () => {
    expect(canonicalJson([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]')
  })

  it('nincs szokoz az elvalasztok korul', () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}')
  })

  it('a nem-ASCII karakter NEM escape-elodik', () => {
    expect(canonicalJson({ n: 'árvíztűrő' })).toBe('{"n":"árvíztűrő"}')
  })
})

describe('attesztacio-osszeallitas', () => {
  const kozos = {
    keyId: 'mak_teszt',
    memberId: '6b1f0d3e-8a24-4c1b-9f70-2f1a3c5d7e90',
    contentSha256: 'a'.repeat(64),
    scannedAt: '2026-08-31T05:00:00Z',
    attestKey: 'teszt-kulcs',
  }
  const tisztaSzken = {
    scanner: { name: 'mio-scan', version: '1.0.0', rulepack: '2026-08-24' },
    injectionHits: 0,
    piiHits: 0,
  }

  it('tiszta szken -> mindket check clean, 0 hits', () => {
    const att = buildAttestation({ ...kozos, scan: tisztaSzken })
    expect(att.checks).toEqual([
      { id: 'prompt_injection', result: 'clean', hits: 0 },
      { id: 'pii', result: 'clean', hits: 0 },
    ])
  })

  it('talalatos szken -> a megfelelo check FLAGGED (az attesztacio nemet is tud mondani)', () => {
    const att = buildAttestation({ ...kozos, scan: { ...tisztaSzken, piiHits: 3 } })
    expect(att.checks.find((c) => c.id === 'pii')).toEqual({ id: 'pii', result: 'flagged', hits: 3 })
    expect(att.checks.find((c) => c.id === 'prompt_injection')?.result).toBe('clean')
  })

  it('az hmac a SAJAT torzsere ervenyes, es a torzs egy bitjere is erzekeny', () => {
    const att = buildAttestation({ ...kozos, scan: tisztaSzken })
    const { hmac, ...torzs } = att
    expect(signAttestation(torzs, kozos.attestKey)).toBe(hmac)
    expect(signAttestation({ ...torzs, content_sha256: 'b'.repeat(64) }, kozos.attestKey)).not.toBe(hmac)
  })
})

describe('idobelyeg', () => {
  it('a szerver alakjara illeszkedik (masodperc-pontos, Z-vel)', () => {
    const t = attestationTimestamp(new Date('2026-08-31T05:00:00.123Z'))
    expect(t).toBe('2026-08-31T05:00:00Z')
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })
})
