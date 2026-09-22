/**
 * LATENSKULCSARGV920: a szolgáltatói kulcs NEM kerülhet a launch-parancsba literálként.
 *
 * MIÉRT EZ A KAPU: az ágens-indítás egy shell-sztring, amit a tmux `new-session -d -s <s> <cmd>`
 * ARGUMENTUMKÉNT kap. Ami abban a sztringben áll, az a folyamatlistában olvasható, amíg a pane
 * wrapper-shellje él. A flotta OAuth-tokenje már korábban is `$(cat fájl)` alakban ment (és a
 * `scripts/channels.sh` kommentje ki is mondja az okot); a BYO/deepseek/minimax/openrouter kulcsok
 * voltak az egyetlen kivételek.
 *
 * AMIT EZ A FÁJL MÉR: a mechanizmus (fájl-mód, a visszaadott alak, és hogy az érték nem szerepel
 * benne). A VÉGSŐ bizonyíték egy élő `ps`-mérés pozitív kontrollal, az a PR törzsében áll.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

let dir: string
const eredetiHome = process.env.HOME

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'launch-secret-'))
})
afterEach(() => {
  if (eredetiHome !== undefined) process.env.HOME = eredetiHome
  rmSync(dir, { recursive: true, force: true })
})

describe('launchSecretRef: a titok fájlba megy, a parancsba csak a hivatkozás', () => {
  it('a visszaadott alak `$(cat ...)`, és NEM tartalmazza az értéket', async () => {
    const { launchSecretRef } = await import('../web/agent-process.js')
    const TITOK = 'PROBA-ERTEK-amit-a-ps-ben-nem-akarunk-latni'
    const ref = launchSecretRef('proba.DEEPSEEK_API_KEY', TITOK)
    expect(ref).not.toContain(TITOK)
    expect(ref).toMatch(/^"\$\(cat '.*'\)"$/)
  })

  it('a fájl a titkot tartalmazza, és a MÓDJA 0600 (a tartalom nem olvasható másnak)', async () => {
    const { launchSecretRef, LAUNCH_SECRETS_DIR } = await import('../web/agent-process.js')
    const TITOK = 'PROBA-ERTEK-masodik'
    const ref = launchSecretRef('proba.MASODIK', TITOK)
    const utvonal = /\$\(cat '(.+)'\)/.exec(ref)?.[1] ?? ''
    expect(utvonal.startsWith(LAUNCH_SECRETS_DIR)).toBe(true)
    expect(readFileSync(utvonal, 'utf-8')).toBe(TITOK)
    expect(statSync(utvonal).mode & 0o777).toBe(0o600)
    expect(statSync(LAUNCH_SECRETS_DIR).mode & 0o777).toBe(0o700)
    rmSync(utvonal, { force: true })
  })

  it('egy MAR LETEZO, lazabb konyvtarat is VISSZASZIGORIT (nem csak letrehozaskor all a mod)', async () => {
    // A SAJAT MUTANSOM LELETE: a `mkdirSync` modja CSAK letrehozaskor hat. A konyvtar-mod
    // rontasa ezert eloszor ZOLDEN tulelt -- a konyvtar a korabbi futasokbol mar megvolt 0700-on.
    // Egy regebbi verziotol vagy kezi beavatkozastol lazabb konyvtar igy eszrevetlenul maradna.
    const { launchSecretRef, LAUNCH_SECRETS_DIR, LAUNCH_SECRETS_DIR_MODE } = await import('../web/agent-process.js')
    const { mkdirSync, chmodSync, statSync: st } = await import('node:fs')
    mkdirSync(LAUNCH_SECRETS_DIR, { recursive: true })
    chmodSync(LAUNCH_SECRETS_DIR, 0o777)
    expect(st(LAUNCH_SECRETS_DIR).mode & 0o777).toBe(0o777) // pozitiv kontroll: tenyleg laza volt
    const ref = launchSecretRef('proba.SZIGORITAS', 'x')
    expect(st(LAUNCH_SECRETS_DIR).mode & 0o777).toBe(LAUNCH_SECRETS_DIR_MODE)
    rmSync(/\$\(cat '(.+)'\)/.exec(ref)?.[1] ?? '', { force: true })
  })

  it('a titok NEVE nem tud kitörni a könyvtárból (útvonal-bejárás zárva)', async () => {
    const { launchSecretRef, LAUNCH_SECRETS_DIR } = await import('../web/agent-process.js')
    // A MERENDO TULAJDONSAG A KONYVTAR, NEM A NEV ALAKJA. Az elso probam azt allitotta, hogy a
    // nevben nincs `..` -- az viszont ARTATLAN, ha a `/` nem eli tul a szurest (a `..` ilyenkor
    // csak ket karakter egy fajlnevben). A tenyleges kerdes: hova kerul a fajl.
    for (const rossz of ['../../../etc/rosszindulatu', '..', '.', '/etc/passwd', '', 'a/../../b']) {
      const ref = launchSecretRef(rossz, 'x')
      const utvonal = /\$\(cat '(.+)'\)/.exec(ref)?.[1] ?? ''
      expect(dirname(utvonal), rossz).toBe(LAUNCH_SECRETS_DIR)
      expect(basename(utvonal), rossz).not.toContain('/')
      rmSync(utvonal, { force: true })
    }
    expect(existsSync('/etc/rosszindulatu')).toBe(false)
  })

  it('ugyanaz a név újraírja ugyanazt a fájlt (nem szemetel ágens-indításonként)', async () => {
    const { launchSecretRef } = await import('../web/agent-process.js')
    const a = launchSecretRef('proba.ISMETELT', 'elso')
    const b = launchSecretRef('proba.ISMETELT', 'masodik')
    expect(a).toBe(b)
    const utvonal = /\$\(cat '(.+)'\)/.exec(b)?.[1] ?? ''
    expect(readFileSync(utvonal, 'utf-8')).toBe('masodik')
    rmSync(utvonal, { force: true })
  })

  it('a SHELL tényleg visszaadja az értéket a hivatkozásból (a mechanizmus működik, nem csak szép)', async () => {
    // Enelkul a tobbi allitas csak azt merne, hogy a SZOVEG jol nez ki. Ez azt meri, hogy a
    // helyettesites vegrehajtva az EREDETI titkot adja -- vagyis az agens tenyleg megkapja a kulcsot.
    const { launchSecretRef } = await import('../web/agent-process.js')
    const { execFileSync } = await import('node:child_process')
    const TITOK = 'PROBA-ERTEK-shell-12345'
    const ref = launchSecretRef('proba.SHELL', TITOK)
    const kimenet = execFileSync('/bin/sh', ['-c', `printf %s ${ref}`], { encoding: 'utf-8' })
    expect(kimenet).toBe(TITOK)
    const utvonal = /\$\(cat '(.+)'\)/.exec(ref)?.[1] ?? ''
    rmSync(utvonal, { force: true })
  })

  it('A FORRASBAN nem all vissza a literal-alak (a BEKOTEST is meri, nem csak a fuggvenyt)', async () => {
    // MIERT KELL EZ KULON: a fenti allitasok a `launchSecretRef`-et es a `resolveProviderEnv`-et
    // merik. A javitas HATASA viszont EGY soron mulik mindket hivasi helyen -- ha valaki a hivoban
    // megint az erteket adja at, minden fenti teszt ZOLD marad, es a kulcs megint a `ps`-be kerul.
    // Ez az allitas ezert a FORRAST nezi, es a tiltott ALAKOT rogziti.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const forras = readFileSync(
      join(fileURLToPath(import.meta.url), '..', '..', 'web', 'agent-process.ts'),
      'utf-8',
    )
    // tiltott: `export ANTHROPIC_API_KEY="${...}"` / ANTHROPIC_AUTH_TOKEN ugyanigy
    const tiltott = /export ANTHROPIC_(API_KEY|AUTH_TOKEN)="\$\{/g
    const talalatok = forras.match(tiltott) ?? []
    expect(talalatok, `a titok ERTEKE nem interpolalodhat a launch-parancsba: ${talalatok.join(', ')}`).toHaveLength(0)

    // POZITIV KONTROLL A MINTARA: ha a regex maga romlana el, ez az allitas is elnemulna.
    const minta_proba = 'export ANTHROPIC_AUTH_TOKEN="${key}" && '
    expect(minta_proba.match(tiltott) ?? []).toHaveLength(1)

    // es a HELYES alaknak ott kell lennie mind a negy helyen (nem eleg, hogy a rossz eltunt)
    expect((forras.match(/launchSecretRef\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
