#!/usr/bin/env node
// Kapu-leltar: melyik kapunak van tesztje, es melyiknek van NEGATIV KONTROLLJA.
//
// flotta-dontes 2026-10-15 ("Legyen"). A kartya harom mert esete
// mind ugyanaz: a kapu FUTOTT, zold volt, es kozben nem azt nezte, amit hittunk --
// egyszer a sajat szkriptje nem volt lefedve, egyszer egy mezot nem olvasott,
// egyszer az ut koltozott el alatta. Egyik sem latszott a zold eredmenyen.
//
// A VEDELEM, ami ezt elkapja, egyetlen dolog: a NEGATIV KONTROLL. Nem az, hogy a
// kapu atengedi a tisztat (az egy mukodo kapu es egy vak kapu eseten egyforma),
// hanem hogy a REGI, HIBAS logikaval vagy a rossz bemenettel PIROSRA valt.
//
// Ez a szkript nem dont helyetted: megmeri, hol all ez ma. Ket szamot ad, es
// mindkettot kulon kell olvasni:
//   - van-e EGYALTALAN teszt, ami hivatkozik a kapura;
//   - van-e benne negativ kontroll (jelolt: "NEGATIV KONTROLL" / "negative control").
//
// A jelolesre azert van szukseg, mert a negativ kontroll gepileg nem ismerheto
// fel: egy "expect(...).toBe(false)" lehet negativ kontroll is, meg egy hetkoznapi
// allitas is. A jelolo a szerzo szandeka, es ez a szandek az, amit szamon tartunk.
//
// Hasznalat:
//   node scripts/kapu-leltar.mjs            # jelentes, exit 0
//   node scripts/kapu-leltar.mjs --strict   # exit 1, ha barmelyik kapunak NINCS tesztje
//   node scripts/kapu-leltar.mjs --json

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Hol keressuk a kapukat. A "kapu" itt az, ami egy MUVELET UTJABAN all es
// nemet tud mondani: hook-ok, *gate* nevu szkriptek, es a hozzajuk tartozo lib.
const KAPU_HELYEK = [
  { dir: 'scripts/hooks', minta: /\.(py|mjs|sh|ts)$/ },
  { dir: 'scripts', minta: /gate.*\.(py|mjs|sh|ts)$/i },
  { dir: 'scripts/lib', minta: /^(homoglyph|magyar).*\.(py|mjs)$/i },
  { dir: 'src/web', minta: /gate.*\.ts$/i },
]

// Ami nevében gate, de nem kapu: a kapukat TELEPITO vagy DIAGNOSZTIZALO szkript,
// es maguk a tesztek. Ezeket kihagyjuk, kulonben a leltar sajat magat meri.
const NEM_KAPU = /^(install-|test_|.*\.test\.|.*-doctor\.|.*-backtest\.)/

const TESZT_HELYEK = ['scripts/__tests__', 'src/__tests__']
const NEGATIV_JELOLOK = [
  'NEGATIV KONTROLL', 'NEGATÍV KONTROLL', 'negativ kontroll', 'negatív kontroll',
  'negative control', 'NEGATIVE CONTROL',
]

function listaz(dir, minta) {
  const teljes = join(ROOT, dir)
  if (!existsSync(teljes)) return []
  return readdirSync(teljes)
    .filter((f) => minta.test(f) && !NEM_KAPU.test(f))
    .filter((f) => {
      try { return statSync(join(teljes, f)).isFile() } catch { return false }
    })
    .map((f) => join(dir, f))
}

function tesztFajlok() {
  const out = []
  for (const d of TESZT_HELYEK) {
    const teljes = join(ROOT, d)
    if (!existsSync(teljes)) continue
    for (const f of readdirSync(teljes)) {
      const p = join(teljes, f)
      try { if (!statSync(p).isFile()) continue } catch { continue }
      let szoveg
      try { szoveg = readFileSync(p, 'utf-8') } catch { continue }
      out.push({ path: relative(ROOT, p), szoveg })
    }
  }
  return out
}

// A puszta substring keves: a "test_garmin_run_gate.py" tartalmazza a
// "garmin_run_gate.py"-t, tehat a kapu SAJAT TESZTJENEK A NEVE ugy nez ki, mint
// egy hivatkozas rea egy harmadik fajlbol. Merve 2026-10-15: igy a leltar olyan
// kapura mondta, hogy van tesztje, amire nem volt. Szohatart kerunk a nev ele.
function emlitiA(szoveg, nev) {
  let i = szoveg.indexOf(nev)
  while (i >= 0) {
    const elotte = i === 0 ? '' : szoveg[i - 1]
    if (!/[A-Za-z0-9_-]/.test(elotte)) return true
    i = szoveg.indexOf(nev, i + 1)
  }
  return false
}

const kapuk = KAPU_HELYEK.flatMap(({ dir, minta }) => listaz(dir, minta))
const tesztek = tesztFajlok()

// A jelolo MELLE ODA KELL IRNI, MELYIK KAPURA VONATKOZIK.
// Merve 2026-10-15, a sajat tesztemen, ket rossz valtozat utan:
//   - fajl-szintu kereses: ennek a leltarnak a sajat tesztfajlja tartalmaz egy
//     negativ kontrollt (a LELTARROL), es kozben megemliti az email-send-gate-et
//     meg a provenance-gate-et is. Mindketto "kontrollalt" lett volna.
//   - kozelsegi kereses (+/-1200 karakter): ugyanaz, negy kapura.
// Vagyis a muszer a SAJAT szovegebol gyartott leletet. A megoldas nem finomabb
// kuszob, hanem ATTRIBUCIO: a jelolo sora nevezze meg a kaput.
//     // NEGATIV KONTROLL (email-send-gate.mjs): ures cimzettel pirosnak kell lennie
// A szigor ara egy alacsony kezdo szam, es ez igy helyes: a 0 azt jelenti, hogy
// meg senki nem MONDTA KI, melyik tesztje a kontroll, nem azt, hogy nincs ilyen.
const JELOLO_ABLAK_SOR = 2

function vanAttribualtJelolo(szoveg, nev) {
  const sorok = szoveg.split('\n')
  for (let i = 0; i < sorok.length; i++) {
    if (!NEGATIV_JELOLOK.some((j) => sorok[i].includes(j))) continue
    const ablak = sorok.slice(i, i + 1 + JELOLO_ABLAK_SOR).join('\n')
    if (ablak.includes(nev)) return true
  }
  return false
}

const sorok = kapuk.map((kapu) => {
  const nev = basename(kapu)
  const hivatkozok = tesztek.filter((t) => emlitiA(t.szoveg, nev))
  const negativ = hivatkozok.filter((t) => vanAttribualtJelolo(t.szoveg, nev))
  return {
    kapu,
    tesztek: hivatkozok.map((t) => t.path),
    negativKontroll: negativ.map((t) => t.path),
  }
})

const nincsTeszt = sorok.filter((s) => s.tesztek.length === 0)
const nincsNegativ = sorok.filter((s) => s.tesztek.length > 0 && s.negativKontroll.length === 0)
const teljes = sorok.filter((s) => s.negativKontroll.length > 0)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ sorok, osszegzes: {
    kapu: sorok.length, nincsTeszt: nincsTeszt.length,
    nincsNegativKontroll: nincsNegativ.length, teljes: teljes.length,
  } }, null, 2))
} else {
  console.log(`KAPU-LELTAR -- ${sorok.length} kapu\n`)
  console.log(`  negativ kontrollal:      ${teljes.length}`)
  console.log(`  van teszt, kontroll nem: ${nincsNegativ.length}`)
  console.log(`  NINCS teszt:             ${nincsTeszt.length}\n`)
  if (nincsTeszt.length) {
    console.log('NINCS TESZT (ezek barmikor elnemulhatnak, es semmi nem szol):')
    for (const s of nincsTeszt) console.log(`  - ${s.kapu}`)
    console.log('')
  }
  if (nincsNegativ.length) {
    console.log('VAN TESZT, DE NINCS NEGATIV KONTROLL (a zold itt nem bizonyitek):')
    for (const s of nincsNegativ) console.log(`  - ${s.kapu}  (${s.tesztek.join(', ')})`)
    console.log('')
  }
  if (teljes.length) {
    console.log('NEGATIV KONTROLLAL:')
    for (const s of teljes) console.log(`  - ${s.kapu}  (${s.negativKontroll.join(', ')})`)
  }
}

// A --strict a TELJES HIANYRA all meg, a hianyzo kontrollra nem: a meglevo
// kapuk tobbsegenek ma nincs jelolt kontrollja, es egy olyan kapu, ami minden
// futasnal pirosat ad, nem kapu, hanem akadaly. A kontroll-hianyt a jelentes
// mutatja, es korrol korre fogy.
if (process.argv.includes('--strict') && nincsTeszt.length > 0) {
  console.error(`\nSTRICT: ${nincsTeszt.length} kapunak nincs tesztje.`)
  process.exit(1)
}
