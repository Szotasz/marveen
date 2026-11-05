// The Vault page was hard-coded Hungarian, much of it unaccented ("Hozzarendeles",
// "Titkositott kulcsok es API tokenek", "Nincs szinkronizalando kotes"), with no
// English. These tests pin that its texts go through lang keys, in both languages.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseFragment } from 'parse5'

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

describe('the Vault page: the SSH part', () => {
  it('the hard-coded and unaccented texts are gone', () => {
    for (const gone of ['>Cimke<', 'SSH Szerverek', '-- Nincs kulcs --', 'Kulcs telepítése –', 'kulcspárok – ezeket']) {
      expect(PAGE, gone).not.toContain(gone)
    }
    for (const gone of ['-- Nincs kulcs --', "'Hiányzó'", 'Szerver szerkesztése –', "'Generálás sikertelen'", "'Hálózati hiba'", "'Másolva!'",
      ' Másolás\'', '<publikus kulcs ide>', '(kulcs nem elérhető)', "'Új szerver'", '-- Válassz', "'Szerver hozzáadása'", "'Hiba a mentéskor'",
      "'Szerver frissítve'", "'Szerver hozzáadva'", 'title="Törlés"', 'title="Szerkesztés"', 'title="Kulcs hozzárendelése"', 'title="Telepítési útmutató"',
      'title="Publikus kulcs másolása"']) {
      expect(VAULT_JS, gone).not.toContain(gone)
    }
  })

  it('the key store is named "SSH key store"; inside it the button is just "New key", like "New server" below', () => {
    expect(PAGE).not.toContain('Kulcstárol')
    expect(PAGE).not.toContain('Új kulcs generálása')
    expect(value(HU, 'vault.ssh.keys.title')).toBe('SSH-kulcstároló')
    expect(value(EN, 'vault.ssh.keys.title')).toBe('SSH key store')
    expect(value(HU, 'vault.ssh.keys.new_btn')).toBe('Új kulcs')
    expect(value(EN, 'vault.ssh.keys.new_btn')).toBe('New key')
    for (const key of ['vault.ssh.keygen.saved_hint', 'vault.ssh.install.key_hint', 'vault.ssh.install.no_key']) {
      expect(value(HU, key), key).toContain('SSH-kulcstároló')
      expect(value(EN, key), key).toContain('SSH key store')
    }
  })

  it('the three "new" buttons and the key button of the server form have a translated hint', () => {
    for (const [id, key] of [['vaultPageNewBtn', 'vault.new_key_btn_title'], ['sshKeyNewBtn', 'vault.ssh.keys.new_btn_title'],
      ['sshNewBtn', 'vault.ssh.servers.new_btn_title'], ['sshKeyNewFromFormBtn', 'vault.ssh.form.new_key_title']]) {
      const tag = PAGE.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? ''
      expect(tag, id).toContain(`data-i18n-title="${key}"`)
      expect(tag, id).toContain(`title="${value(HU, key)}"`)
      expect(value(HU, key), key).toBeTruthy()
      expect(value(EN, key), key).toBeTruthy()
    }
    // the form's button also picks the new key for this server, so its hint says so
    expect(value(HU, 'vault.ssh.form.new_key_title')).toContain('ennél a szervernél')
    expect(value(EN, 'vault.ssh.form.new_key_title')).toContain('for this server')
  })

  it('the install guide keeps the user in the sentence: the text around it is two keys', () => {
    expect(PAGE).toContain('<span data-i18n="vault.ssh.install.run_before">')
    expect(PAGE).toContain('<strong id="sshInfoUser"></strong><span data-i18n="vault.ssh.install.run_after">')
  })

  it('the copy button of the keygen modal puts its translated label back, escaped', () => {
    expect(VAULT_JS).toContain("' + escapeHtml(t('common.copy'))")
  })
})

describe('the Vault page: no untranslated text is left', () => {
  // Text that may stand without a lang key, each with its reason.
  const ALLOWED: Record<string, string> = {
    'Vault': 'the page title: the page header sets it from vault.page_title',
    'Titkosított API-kulcsok, tokenek és SSH-kulcsok': 'the page subtitle: the page header sets it from vault.page_subtitle',
    'AES-256': 'the cipher name, the same in every language',
    'i': 'the info button glyph',
  }
  type Node = { nodeName: string; value?: string; attrs?: { name: string }[]; childNodes?: Node[]; content?: Node }

  it('every text on the page sits in an element with a lang key, in <code>, or on the reasoned list', () => {
    const offenders: string[] = []
    const walk = (node: Node, keyed: boolean) => {
      const own = (node.attrs || []).some(a => a.name === 'data-i18n' || a.name === 'data-i18n-html')
      const inside = keyed || own || node.nodeName === 'code' || node.nodeName === 'svg'
      if (node.nodeName === '#text') {
        const text = (node.value || '').trim()
        if (/\p{L}/u.test(text) && !keyed && !(text in ALLOWED)) offenders.push(text)
        return
      }
      for (const child of node.childNodes || []) walk(child, inside)
      if (node.content) walk(node.content, inside)
    }
    walk(parseFragment(PAGE) as unknown as Node, false)
    expect(offenders).toEqual([])
  })
})

describe('the add-server form says which field is missing', () => {
  const save = between(VAULT_JS, "addBtn?.addEventListener('click', async () => {", 'const isEdit = !!_sshEditingId')

  it('the old catch-all toast is gone', () => {
    expect(save, 'save handler not found').not.toBe('')
    expect(save).not.toContain('Név, IP és felhasználó megadása kötelező')
  })

  it('the first empty required field gets the focus and its own translated toast, before any request', () => {
    const order = ["!name ? ['sshNameInput', 'vault.ssh.form.name_required']", "!host ? ['sshHostInput', 'vault.ssh.form.host_required']", "!user ? ['sshUserInput', 'vault.ssh.form.user_required']"]
    let at = -1
    for (const step of order) {
      const i = save.indexOf(step)
      expect(i, step).toBeGreaterThan(at)
      at = i
    }
    expect(save).toContain('if (missing) { document.getElementById(missing[0]).focus(); showToast(t(missing[1])); return }')
    expect(save).not.toMatch(/\bfetch\(/)
    for (const key of ['name_required', 'host_required', 'user_required']) {
      expect(value(HU, `vault.ssh.form.${key}`)).not.toBeNull()
      expect(value(EN, `vault.ssh.form.${key}`)).not.toBeNull()
    }
  })
})
