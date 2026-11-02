// The Vault page was hard-coded Hungarian, much of it unaccented ("Hozzarendeles",
// "Titkositott kulcsok es API tokenek", "Nincs szinkronizalando kotes"), with no
// English. These tests pin that its texts go through lang keys, in both languages.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from)
  const j = i < 0 ? -1 : src.indexOf(to, i)
  return i < 0 || j < 0 ? '' : src.slice(i, j)
}
const PAGE = between(HTML, '<div class="page" id="vaultPage"', '<!-- === Token Usage Page === -->')
const VAULT_JS = between(APP, '// --- Vault management ---', '// --- External project paths management ---')
const value = (lang: string, key: string) => {
  const m = lang.match(new RegExp(`^  '${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm'))
  return m ? m[1] : null
}

describe('the Vault page: the API keys part', () => {
  it('the page and the Vault JS were found', () => {
    expect(PAGE.length).toBeGreaterThan(1000)
    expect(VAULT_JS.length).toBeGreaterThan(1000)
  })

  it('the unaccented, hard-coded texts are gone', () => {
    for (const gone of ['Hozzarendeles', 'Titkositott kulcsok es', 'atvizsgalasa', 'szinkronizalasa', 'titkositas', 'Tarolt kulcs',
      'Uj kulcs', 'Kereses a kulcsok', 'Meg nincs tarolt', 'Kulcs hozzarendelese', 'MCP titkok keresese', 'Nem talaltam',
      'Kivalasztottak importalasa', 'Kornyezeti']) {
      expect(PAGE, gone).not.toContain(gone)
    }
    for (const gone of ['Mentés sikertelen: ', ' kotes', 'Nincs vault kulcs', 'Nincs MCP szerver', 'hozzarendeles betoltesekor',
      'Minden mezo', 'Hozzarendelve!', 'Hiba tortent', 'Halozati hiba', "'Kereses...'", "'Szinkron...'", 'frissitve', 'szinkronizalando',
      'erzekeny ertek', 'fajlban', 'Nincs kivalasztott', "'Importalas...'", 'importalva', 'Hibak: ', 'Scan &amp; Import']) {
      expect(VAULT_JS, gone).not.toContain(gone)
    }
  })

  it('the part is named "API keys and tokens", with its own heading like the SSH parts', () => {
    expect(PAGE).toContain('<span data-i18n="vault.section.title">')
    expect(PAGE).toContain('data-i18n="vault.section.sub"')
    expect(value(HU, 'vault.section.title')).toBe('API-kulcsok és tokenek')
    expect(value(EN, 'vault.section.title')).toBe('API keys and tokens')
    expect(value(HU, 'vault.new_key_btn')).toBe('Új API-kulcs')
    expect(value(HU, 'connectors.vault_section')).toBe('Vault (API-kulcsok és tokenek)')
  })

  it('the storage stat card no longer reads "Helyi / Helyi": its label and its value are two keys', () => {
    expect(PAGE).toContain('<div class="stat-value" data-i18n="vault.stat.storage_value">')
    expect(value(HU, 'vault.stat.storage')).toBe('Tárolás')
    expect(value(HU, 'vault.stat.storage_value')).toBe('Helyi')
  })

  it('the Scan and Sync buttons put their translated label back, escaped', () => {
    expect(VAULT_JS).toContain("' + escapeHtml(t('vault.btn.scan'))")
    expect(VAULT_JS).toContain("' + escapeHtml(t('vault.btn.sync'))")
  })

  it('a scan with nothing to import always sets the empty text, so an earlier count is not left behind', () => {
    expect(VAULT_JS).toContain("empty.textContent = findings.length > 0 ? t('vault.scan.all_in_vault', { n: findings.length }) : t('vault.scan.empty')")
  })

  it('every vault.* key the page and its JS use is in both languages', () => {
    const used = new Set([
      ...[...PAGE.matchAll(/data-i18n(?:-placeholder|-title|-html)?="(vault\.[^"]+)"/g)].map(m => m[1]),
      ...[...VAULT_JS.matchAll(/\bt\('(vault\.[^']+)'/g)].map(m => m[1]),
    ])
    expect(used.size).toBeGreaterThan(30)
    for (const key of used) {
      expect(value(HU, key), `hu ${key}`).not.toBeNull()
      expect(value(EN, key), `en ${key}`).not.toBeNull()
    }
  })
})
