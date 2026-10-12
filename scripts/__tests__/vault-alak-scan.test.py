#!/usr/bin/env python3
"""PATSZIVARGAS912: a titok-alak szken KIMENET-SZERZODESE es a szuk mintai.

Miert alprocesszkent: amit ez az eszkoz KIIR, az maga a kockazat. Egy fuggveny-
szintu teszt a mintat merne, a szerzodest nem -- azt csak a valodi stdout meri.

A SZERZODES, amit ezek a tesztek pinnelnek:
  KIIR: a gyoker-listat, a kihagyott konyvtarneveket, a fajlnev-mintat, az
        atvizsgalt fajlok szamat, es kategoriankent az UTVONAL:SORSZAM-ot.
  SOSEM IR KI: magat az ERTEKET, semmilyen alakban. Meg az ERTEK-kategoriabol is
        CSAK a hely utazik.
  A "0 talalat" JELENTESE: a kiirt hatokoron belul nincs talalat. Ami azon kivul
        van, az NINCS MEGMERVE -- nem az, hogy tiszta.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCAN = os.path.join(HERE, '..', 'vault-alak-scan.py')

# SZINTETIKUS ertekek, egyik sem valodi titok. A '0'*40 alak szandekos: a valodi
# 40-jegyu hex sok kulonbozo karaktert tartalmaz, ez egyet -- ha valaha kiszivarog
# egy teszt-kimenetbe, az onmagat leplezi le vetomagkent.
HAMIS_PAT = 'sbp_' + '0' * 40
HAMIS_RESEND = 're_' + 'Z' * 30
HAMIS_CTX = 'ctx7sk-' + 'Y' * 24


def futtat(fak):
    """A szkent egy eldobhato fara engedi, es visszaadja (proc, json)."""
    tmp = tempfile.mkdtemp()
    for rel, tartalom in fak.items():
        p = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(tartalom)
    proc = subprocess.run([sys.executable, SCAN, tmp, '--json'],
                          capture_output=True, text=True)
    try:
        return proc, json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc, None


class KimenetSzerzodes(unittest.TestCase):
    def test_az_ertek_soha_nem_kerul_a_kimenetbe(self):
        """A LEGFONTOSABB TESZT. A 09-18-i szivargas ugy keletkezett, hogy egy
        titkot tartalmazo fajlt kontextus-sorokkal grepeltek, es az ertek az
        atiratba kerult. Ez az eszkoz megtalalja ugyanazt a titkot -- es NEM
        irhatja ki."""
        proc, data = futtat({'skills/a/SKILL.md': f'KEY = "{HAMIS_PAT}"\n'})
        self.assertIsNotNone(data, proc.stderr)
        self.assertEqual(len(data['ERTEK']), 1, 'a szken nem talalta meg')
        for hol, szoveg in (('stdout', proc.stdout), ('stderr', proc.stderr)):
            self.assertNotIn(HAMIS_PAT, szoveg, f'AZ ERTEK KISZIVARGOTT a {hol}-ra')
            # A prefix utani resz onmagaban is eleg lenne egy visszafejteshez.
            self.assertNotIn('0' * 40, szoveg, f'az ertek TORZSE kiszivargott a {hol}-ra')
        self.assertIn('skills/a/SKILL.md', proc.stdout, 'a HELYNEK viszont latszania kell')

    def test_a_hatokort_kiirja(self):
        """Egy szam, ami nem mondja meg mit nezett meg, tobbet allit, mint amit mert."""
        proc, data = futtat({'skills/a/SKILL.md': 'artatlan\n'})
        self.assertIn('gyokerek', data['hatokor'])
        self.assertIn('kihagyott', data['hatokor'])
        self.assertIn('nev_minta', data['hatokor'])
        self.assertEqual(len(data['hatokor']['gyokerek']), 1)

    def test_nulla_talalat_eseten_is_kiirja_a_hatokort(self):
        proc, data = futtat({'skills/a/SKILL.md': 'semmi erdekes\n'})
        self.assertEqual(len(data['ERTEK']), 0)
        self.assertEqual(proc.returncode, 0)
        self.assertGreaterEqual(data['atvizsgalt_fajlok'], 1)


class MintaSzukseg(unittest.TestCase):
    def test_a_harom_recept_alakot_megtalalja(self):
        proc, data = futtat({
            'skills/a/SKILL.md': 'export X="<vault: MARVEEN-PAT>"\n',
            'skills/b/SKILL.md': "echo 'X=CIMKE' | node vault-resolve.mjs | cut -d= -f2-\n",
            'skills/c/SKILL.md': 'curl -o /tmp/ki.json https://x/api/vault/PAT\n',
        })
        self.assertEqual(len(data['A_utasitas_alak']), 1)
        self.assertEqual(len(data['B_stdout_szivargas']), 1)
        self.assertEqual(len(data['C_lemezre_iras']), 1)

    def test_a_bak_fajlok_BENNE_vannak(self):
        """Egy biztonsagi masolat celja a visszaallitas: eppen az a fajl orzi a
        rossz alakot, amit egy 'allitsd vissza' mozdulat visszahozna."""
        proc, data = futtat({'skills/a/SKILL.md.bak-regi-0914': f'K = "{HAMIS_PAT}"\n'})
        self.assertEqual(len(data['ERTEK']), 1)

    def test_tobb_hitelesito_osztalyt_lat_nem_csak_a_supabase_PAT_ot(self):
        """A 09-14-i "0 ertek-talalat" azert allitott tobbet, mint amit mert,
        mert a minta CSAK `sbp_[0-9a-f]{40}` volt."""
        proc, data = futtat({
            'skills/a/SKILL.md': f'A="{HAMIS_RESEND}"\n',
            'skills/b/SKILL.md': f'B="{HAMIS_CTX}"\n',
        })
        self.assertEqual(len(data['ERTEK']), 2)

    def test_FANTOM_a_prefix_szo_kozepen_NEM_talalat(self):
        """Hatarolas nelkul a `re_` ag a `measure_actually_measured`-re is
        illeszkedett: 35 fantom 24 `.md` fajlban. Egy kronikusan hamis riasztas
        nem hianyt okoz, hanem erzeketlenseget."""
        proc, data = futtat({
            'skills/a/SKILL.md': 'a measure_actually_measured_dolog es a here_is_a_long_name\n',
            'skills/b/SKILL.md': 'task-manager-integration-osszefoglalo\n',
            'skills/c/SKILL.md': 'kulcseyJabcdefghijklmnopqrstuvwxyz012345\n',
        })
        self.assertEqual(len(data['ERTEK']), 0, 'fantom-talalat: a hatarolas elveszett')

    def test_onmagat_nem_meri(self):
        """A szken dokumentacioja mind a harom keresett alakot tartalmazza
        peldakent. Onmagara riasztva minden futas 3 allando fantomot adna."""
        tmp = tempfile.mkdtemp()
        cel = os.path.join(tmp, 'vault-alak-scan.py')
        with open(os.path.abspath(SCAN), encoding='utf-8') as f:
            forras = f.read()
        with open(cel, 'w', encoding='utf-8') as f:
            f.write(forras)
        proc = subprocess.run([sys.executable, os.path.abspath(SCAN), tmp, '--json'],
                              capture_output=True, text=True)
        data = json.loads(proc.stdout)
        # A MASOLAT nem onmaga (mas realpath), tehat MEGMERODIK -- ez mutatja,
        # hogy a forras tenyleg tartalmazza az alakokat, es hogy a kizaras
        # realpath szerint megy, nem fajlnev szerint.
        self.assertGreater(len(data['A_utasitas_alak']), 0,
                           'a masolatnak talalatot kell adnia, kulonben a kovetkezo allitas ures')
        sajat = subprocess.run([sys.executable, os.path.abspath(SCAN), os.path.dirname(os.path.abspath(SCAN)), '--json'],
                               capture_output=True, text=True)
        sajat_data = json.loads(sajat.stdout)
        onmaga = [x for x in sajat_data['A_utasitas_alak'] if x['fajl'].endswith('vault-alak-scan.py')]
        self.assertEqual(onmaga, [], 'a szken onmagara riasztott')


class Kilepokod(unittest.TestCase):
    def test_ertek_talalatra_1_egyebkent_0(self):
        proc, _ = futtat({'skills/a/SKILL.md': f'K="{HAMIS_PAT}"\n'})
        self.assertEqual(proc.returncode, 1)
        proc, _ = futtat({'skills/a/SKILL.md': 'artatlan\n'})
        self.assertEqual(proc.returncode, 0)
        # Recept-alak MAGABAN nem eles kitettseg, tehat nem bukatja a futast:
        # a ket allitas ("nincs ertek" / "nincs rossz recept") kulon all.
        proc, _ = futtat({'skills/a/SKILL.md': 'export X="<vault: CIMKE>"\n'})
        self.assertEqual(proc.returncode, 0)


class BeegetettKulcsnev(unittest.TestCase):
    """D) ag: az EGYETLEN dolog, amit a regi, koveteslen szken fedett es ez nem.

    Halmaz-kulonbsegkent merve 2026-09-18, es nem elmeleti: a teljes hatokoron
    ez az ag talalt egy VALODI beegetett kulcsot egy flotta-szintu skillben,
    amit az elotag-alapu ERTEK-minta elszalasztott (nincs ismert elotagja).
    """
    VALODI = 'phc_' + 'aB3xQ7zK9mN2pL5vR8tY4wE6uI0oS1dF'   # szintetikus, 32 egyedi-dus kar

    def test_ertekadast_fog(self):
        proc, data = futtat({'skills/a/telemetry.mjs': f'const POSTHOG_API_KEY = "{self.VALODI}";\n'})
        self.assertEqual(len(data['D_beegetett_kulcsnev']), 1)

    def test_JSON_mezot_is_fog_mert_a_titkok_java_konfigban_ul(self):
        """A `:` alak SZANDEKOSAN bent van: egy `=`-re szukitett minta pont a
        JSON/YAML konfigokra vakulna meg, ahol a hitelesitok java ul."""
        proc, data = futtat({'skills/a/conf.json': f'  "api_key": "{self.VALODI}",\n'})
        self.assertEqual(len(data['D_beegetett_kulcsnev']), 1)

    def test_PROZA_nem_talalat(self):
        """A szukites oka, merve: 17 nyers talalatbol 11 proza vagy placeholder
        volt. Egy hibauzenetet IDEZO mondat nem beegetett hitelesito."""
        proc, data = futtat({
            'skills/a/SKILL.md': f'uzenetet ad (PATH: "No such file"; token: "{self.VALODI}"), tehat\n',
            'skills/b/SKILL.md': f'a sor vegen meg egy token: "{self.VALODI}" all valahol\n',
        })
        self.assertEqual(len(data['D_beegetett_kulcsnev']), 0)

    def test_PLACEHOLDER_nem_talalat(self):
        proc, data = futtat({
            'skills/a/SKILL.md': 'export TOKEN="<vault: MARVEEN-PAT-CIMKE>"\n',
            'skills/b/SKILL.md': 'api_key = "your-api-key-here-xxxx"\n',
            'skills/c/SKILL.md': 'secret = "example-secret-value-1"\n',
        })
        self.assertEqual(len(data['D_beegetett_kulcsnev']), 0)

    def test_ALACSONY_ENTROPIA_nem_talalat(self):
        """Egy rovid, ismetlodo helykitolto nem kulcs. A kuszob alatti talalat
        NEM 'tiszta', csak NEM JELENTJUK -- ezert all a hatokor-kiirasban, hogy
        amit nem merunk, arrol nem allitunk semmit."""
        proc, data = futtat({'skills/a/SKILL.md': 'password = "aaaaaaaaaaaaaaaaaa"\n'})
        self.assertEqual(len(data['D_beegetett_kulcsnev']), 0)

    def test_a_D_ag_SEM_irja_ki_az_erteket(self):
        """A kimenet-szerzodes MINDEN kategoriara all, nem csak az ERTEK-re."""
        proc, data = futtat({'skills/a/telemetry.mjs': f'const API_KEY = "{self.VALODI}";\n'})
        self.assertEqual(len(data['D_beegetett_kulcsnev']), 1)
        for hol, szoveg in (('stdout', proc.stdout), ('stderr', proc.stderr)):
            self.assertNotIn(self.VALODI, szoveg, f'AZ ERTEK KISZIVARGOTT a {hol}-ra')
        self.assertIn('telemetry.mjs', proc.stdout)

    def test_a_D_talalat_is_bukatja_a_kilepokodot(self):
        proc, _ = futtat({'skills/a/telemetry.mjs': f'const API_KEY = "{self.VALODI}";\n'})
        self.assertEqual(proc.returncode, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
