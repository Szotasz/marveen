import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALLERS = ['install-macos.sh', 'install-linux.sh'] as const

// hu: MERT eset (2026-08-31): egy MASODIK telepites ugyanarra a gepre elnemitotta
//     az elsot. A telepito a csatorna-allapotot a FIX $HOME/.claude/channels/
//     <provider> utra irja, es ott FELTETEL NELKUL felulirja a .env-et (bot-token)
//     es az access.json-t. A masodik telepites igy
//       - atvette az elso bot-tokenjet (az elso bot senkit nem szolgalt ki), es
//       - kitorolte az access.json "groups" tartalmat -- a munkacsoportbol erkezo
//         uzenetek (99 db, aug 11 -- aug 31 17:29) egy csapasra eldobodtak,
//         mert a plugin ismeretlen csoportot csendben eldob.
//     Ket kulon hiba, ket kulon javitas kell:
//       A) a konyvtar legyen telepitesenkent kulon, es
//       B) a mar meglevo access.json ne irodjon felul (parositasok, csoportok).
// en: A second install on the same host silently took over the first one's bot
//     token and wiped its access.json groups. Fix A: per-install directory.
//     Fix B: never overwrite an existing access.json.
describe('telepito: csatorna-allapot konyvtar telepitesenkent', () => {
  function extractResolver(sh: string): string {
    const m = sh.match(/resolve_channel_state_dir\(\)\s*\{[\s\S]*?\n\}/)
    if (!m) throw new Error('resolve_channel_state_dir() not found')
    return m[0]
  }

  function resolve(sh: string, provider: string, agentId: string): string {
    const script = ['set -u', 'HOME=/home/tester', extractResolver(sh),
      `resolve_channel_state_dir '${provider}' '${agentId}'`].join('\n')
    return execFileSync('bash', ['-c', script], { encoding: 'utf-8' }).trim()
  }

  for (const installer of INSTALLERS) {
    describe(installer, () => {
      const sh = readFileSync(join(REPO_ROOT, installer), 'utf-8')

      it('ket telepites ket kulon konyvtarat kap', () => {
        expect(resolve(sh, 'telegram', 'marveen')).toBe('/home/tester/.claude/channels/telegram-marveen')
        expect(resolve(sh, 'telegram', 'jarvis')).toBe('/home/tester/.claude/channels/telegram-jarvis')
      })

      it('agent-azonosito nelkul a regi globalis ut marad (visszafele kompatibilitas)', () => {
        expect(resolve(sh, 'telegram', '')).toBe('/home/tester/.claude/channels/telegram')
      })

      it('providerenkent kulon', () => {
        expect(resolve(sh, 'slack', 'marveen')).toBe('/home/tester/.claude/channels/slack-marveen')
      })

      it('a CHANNEL_DIR ebbol a feloldasbol szarmazik, nem fix $HOME utbol', () => {
        const line = sh.split('\n').find((l) => l.startsWith('CHANNEL_DIR='))
        expect(line, 'CHANNEL_DIR assignment not found').toBeTruthy()
        expect(line).toContain('resolve_channel_state_dir')
        expect(line).not.toContain('$HOME/.claude/channels/$CHANNEL_PROVIDER')
      })

      // B) A meglevo access.json a parositasokat ES a jovahagyott csoportokat
      //    hordozza. Egy ujratelepites (vagy egy masodik telepites) nem irhatja
      //    felul -- az csendben elnemitja a mar mukodo csatornakat.
      it('a meglevo access.json-t nem irja felul', () => {
        const writes = sh.split('\n')
          .map((l, i) => ({ l, i }))
          .filter((x) => /^\s*cat\s*>\s*"?\$CHANNEL_DIR\/access\.json"?/.test(x.l))
        expect(writes.length, 'access.json write not found').toBeGreaterThan(0)
        for (const w of writes) {
          const before = sh.split('\n').slice(Math.max(0, w.i - 6), w.i).join('\n')
          expect(before, `access.json write at line ${w.i + 1} is unguarded`)
            .toMatch(/if\s+\[\s+!\s+-f\s+"?\$CHANNEL_DIR\/access\.json"?\s+\]/)
        }
      })
    })
  }
})
