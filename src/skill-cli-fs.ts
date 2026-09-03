/**
 * MIOCLISKILL831 -- a `marveen skill` parancs MELLEKHATASAI: hol lakik a
 * konfig, hogyan tarolodik a titok, hova kerulnek a letoltott skillek.
 *
 * TAROLASI DONTES (spec, msg 16930/a): a FAJL az alapeset, 0600-zal, a
 * konyvtar 0700-zal. Ez nem uj konvencio a repoban -- a heartbeat.ts, a
 * channel-coordinator.ts es a db.ts is igy ir titkot. OS-kulcstartot NEM
 * feltetelezunk: a fo celpont fej nelkuli linux, ahol tobbnyire nincs is.
 * Ahol van, az kesobbi reteg lehet; a seam itt van (`tarolasiHatter()`), de
 * ebben a korben szandekosan EGY hatter van, es a kod ezt KI IS MONDJA
 * ahelyett, hogy csendben visszaesne ra.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FAJL_MOD = 0o600
const KONYVTAR_MOD = 0o700

export interface SkillCredentials {
  /** A tag azonositoja: a szerveren `member_id` = auth.users id textkent. */
  memberId: string
  keyId: string
  attestKey: string
  /** Pl. https://<ref>.supabase.co -- a fuggveny-vegpontok gyokere. */
  apiBase: string
  enrolledAt: string
}

/** A konfig gyokere. A kornyezeti valtozo a TESZTELHETOSEG miatt van, nem opciokent. */
export function skillHome(): string {
  return process.env.MARVEEN_SKILL_HOME || join(homedir(), '.marveen', 'skill')
}

export function credentialsPath(): string {
  return join(skillHome(), 'credentials.json')
}

/** Ebben a korben egyetlen hatter van, es ezt a hivo is latja. */
export function tarolasiHatter(): 'file-0600' {
  return 'file-0600'
}

function biztosKonyvtar(ut: string): void {
  if (!existsSync(ut)) mkdirSync(ut, { recursive: true, mode: KONYVTAR_MOD })
  else chmodSync(ut, KONYVTAR_MOD)
}

export function saveCredentials(cred: SkillCredentials): string {
  const ut = credentialsPath()
  biztosKonyvtar(dirname(ut))
  // A mode az OPEN-nel adva: ha a fajl mar letezett tagabb joggal, a
  // writeFileSync modja nem allitana vissza -- ezert a chmod is megvan.
  writeFileSync(ut, JSON.stringify(cred, null, 2) + '\n', { mode: FAJL_MOD })
  chmodSync(ut, FAJL_MOD)
  return ut
}

export class CredentialsPermissionError extends Error {
  constructor(readonly path: string, readonly mode: number) {
    super(
      `A hitelesito fajl jogosultsaga tul tag (${mode.toString(8)}): ${path}\n` +
        'A HMAC-titok mas felhasznalo szamara is olvashato lenne. Javitsd:\n' +
        `  chmod 600 ${path}`,
    )
  }
}

/**
 * Betoltes. FAIL-CLOSED a jogosultsagra: ha a fajl csoport- vagy
 * mindenki-olvashato, NEM hasznaljuk. A csendes hasznalat rosszabb lenne,
 * mint a hiba: a tag azt hinne, a titka vedve van, kozben nem.
 * (Az ellenorzes POSIX-jogokat felteteler; Windowson a mode-bitek nem
 * ertelmesek, ezert ott kihagyjuk -- kimondva, nem csendben.)
 */
export function loadCredentials(): SkillCredentials | null {
  const ut = credentialsPath()
  if (!existsSync(ut)) return null
  if (process.platform !== 'win32') {
    const mode = statSync(ut).mode & 0o777
    if (mode & 0o077) throw new CredentialsPermissionError(ut, mode)
  }
  return JSON.parse(readFileSync(ut, 'utf8')) as SkillCredentials
}

/**
 * Hova kerulnek a letoltott skillek. USER-HATOKOR az alapertelmezes
 * (`~/.claude/skills`), a `--project` kapcsoloval a munkakonyvtar
 * `.claude/skills` mappaja. A hivo dont; ez a fuggveny csak feloldja az utat.
 */
export function skillTargetDir(scope: 'project' | 'user', cwd = process.cwd()): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'skills')
    : join(cwd, '.claude', 'skills')
}

export interface SkillFile {
  /** Relativ ut a cel-konyvtaron belul, pl. `marveen-upload/SKILL.md`. */
  relPath: string
  content: string
}

/**
 * Skill-fajlok kiirasa. A relativ utat ELLENORIZZUK: egy `../` a szerver
 * valaszaban kulonben a cel-konyvtaron KIVULRE irna. A letoltott tartalom
 * nem megbizhato bemenet attol, hogy a sajat szerverunktol jon.
 */
export function writeSkillFiles(targetDir: string, files: SkillFile[]): string[] {
  const kiirt: string[] = []
  for (const f of files) {
    if (f.relPath.includes('..') || f.relPath.startsWith('/')) {
      throw new Error(`Elutasitott skill-utvonal (kilepne a cel-konyvtarbol): ${f.relPath}`)
    }
    const ut = join(targetDir, f.relPath)
    biztosKonyvtarNyilvanos(dirname(ut))
    writeFileSync(ut, f.content)
    kiirt.push(ut)
  }
  return kiirt
}

/** A skill-fajlok NEM titkok: a szokasos konyvtar-jog jar nekik, nem 0700. */
function biztosKonyvtarNyilvanos(ut: string): void {
  if (!existsSync(ut)) mkdirSync(ut, { recursive: true })
}
