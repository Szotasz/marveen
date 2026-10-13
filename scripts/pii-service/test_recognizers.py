#!/usr/bin/env python3
"""Recognizer regression test for the PII service. Needs the service venv
(Presidio + the xx_ent_wiki_sm spaCy model), so it is not part of CI:

    .venv/bin/python test_recognizers.py

MUST: every listed value must be masked in MSG1/MSG2 (all data is synthetic).
CASES: generated texts with what must be masked and what must stay in clear.
NOISE: ordinary operator messages that must produce NO marker -- the old
multilingual NER tagged words like "Azt", "Csináld", "Mergelhető" as people.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import anonymize_text  # noqa: E402

MSG1 = 'Szia Marveen! Segíts egy ügyfélválaszt megírni.\n\nAz ügyfél neve Kovács Eszter, lakcíme 1234 Budapest, Minta utca 12. 3. emelet 5.\nE-mail címe: kovacs.eszter@example.com, telefonszáma: +36 30 123 4567\n(másik szám: 06 20 765 4321).\n\nA számlázási adatai: IBAN HU42 1177 3016 1111 1018 0000 0000,\nadóazonosító jele 8123456789, TAJ-száma 123 456 789.\n\nAz ügyfél férje, Nagy Péter (nagy.peter@example.org) szintén jelezte,\nhogy a szerződést átveszi. Debrecenben, a Teszt köz 7. szám alatt lakik.\n\nKérlek, fogalmazz egy udvarias e-mailt, amelyben tájékoztatjuk Kovács\nEsztert, hogy a szerződése jövő hétfőn lejár.'

MSG2 = 'Marveen, összefoglalót kérek a mai ügyfélhívásokról.\n\nDélelőtt Szabó Andrásné hívott (született: 1985. március 14., Szeged,\nanyja neve: Tóth Ilona). Azt kérte, hogy a levelet Szabó Andrásnénak\nküldjük a Teszt Kft. nevében, a 6720 Szeged, Példa tér 3/B címre.\nElérhetősége: szabo.andrasne(kukac)example.hu, telefon: 0670/555-1234,\nvagy 36-30-555-9876.\n\nBankszámlaszáma: 11773016-11111018-00000000. Az IBAN-ja szóközök nélkül:\nHU42117730161111101800000000. Adószáma: 12345678-1-42.\nTAJ-száma kötőjellel: 123-456-789. Személyi igazolvány száma: 123456AB.\n\nDélután Gál Bence ügyvezető jelentkezett a Minta Zrt.-től. Bencével\nmegbeszéltük, hogy a Gál Bencének szóló ajánlatot a bence.gal@example.net\ncímre küldjük. A céges autója rendszáma ABC-123, a szerver IP-címe\n192.0.2.45. Hívja vissza Bencét a (1) 555 0199 számon.\n\nKérlek, ne írd le külön a neveket, csak a lényeget: mindkettőjüknek\nküldjünk visszaigazolást péntekig.'

MUST = ['Kovács Eszter', '1234 Budapest, Minta utca 12. 3. emelet 5', 'kovacs.eszter@example.com', '+36 30 123 4567', '06 20 765 4321', 'HU42 1177 3016 1111 1018 0000 0000', '8123456789', '123 456 789', 'Nagy Péter', 'nagy.peter@example.org', 'Teszt köz 7', 'Szabó Andrásné', '1985. március 14.', 'Tóth Ilona', 'Szabó Andrásnénak', '6720 Szeged, Példa tér 3/B', 'szabo.andrasne(kukac)example.hu', '0670/555-1234', '36-30-555-9876', '11773016-11111018-00000000', 'HU42117730161111101800000000', '12345678-1-42', '123-456-789', '123456AB', 'Gál Bence', 'Bencével', 'Gál Bencének', 'bence.gal@example.net', 'ABC-123', '192.0.2.45', 'Bencét', '(1) 555 0199']

NOISE = ['van olyan megoldás, hogy a kész visszaadott szövegbe beírja az eredeti nevet ? Kvázi a Claude code maszkolva látja, de nekem az üzenetben helyesen jön vissza', 'A felismerés pontosságát (kimaradt adatok, félrefogott szavak) külön is meg tudom csinálni, ha kéred. Csináld meg előbb.', 'PR #1934 CI zöld, mindkét check átment (scan + test). Mergelhető. nem jó még mindig', 'Nem ment végbe szotasz oldalán a pull request ellenőrzés', 'Holnap 10:30-kor megbeszélés a Budapest Kossuth irodában, kód: ab-123, abc-123.', 'Kérlek nézd meg a PR #1934-et, és a 4500 Ft-os tételt.', 'Szia! Mi a helyzet a kanban kártyákkal? Készült valami új skill?', 'A 4500 Forint és 1200 Euro tétel, 4500 Ft a díj.', 'Katalógus érkezett. Nagyon jó. Annak örülök. Kissé fáradt.']

# (text, must be masked, must stay in clear) -- two generated rounds of ten;
# the second round was held out while fixing the first.
CASES = [
    ('Jó reggelt! Tegnap Horváth Zsuzsanna hívott a 06-30-222-3344 számról, hogy a John Deere 6R traktor szervizét áttenné csütörtökre. Az email címe horvath.zsuzsa@gmail.com.',
     ['Horváth Zsuzsanna', '06-30-222-3344', 'horvath.zsuzsa@gmail.com'],
     ['John Deere', 'Jó reggelt', 'csütörtökre']),
    ('Kérlek küldd ki az ajánlatot Molnár Lászlónak (Molnár Agro Kft., adószám: 23456789-2-13), cím: 7400 Kaposvár, Fő utca 45. Telefon: +36 1 234 5678.',
     ['Molnár Lászlónak', '23456789-2-13', '7400 Kaposvár, Fő utca 45', '+36 1 234 5678'],
     ['ajánlatot']),
    ('A pályázati adatlapon szereplő személy: dr. Varga Katalin, szül. 1972.05.03., anyja neve Kiss Mária, TAJ: 045 678 912, adóazonosító jel: 8401234567.',
     ['Varga Katalin', '1972.05.03', 'Kiss Mária', '045 678 912', '8401234567'],
     ['pályázati']),
    ('Szia! Mergelhető a PR, a CI zöld. Holnap 9-kor demo a Fendt 724-esről, utána ebéd. A kanban kártyát lezártam.',
     [],
     ['Mergelhető', 'Fendt', 'Szia', 'Holnap', 'demo']),
    ('Utalás: Takács Gábor, számlaszám 10403387-00028572-00000000, IBAN: HU93 1040 3387 0002 8572 0000 0000. Összeg: 1 250 000 Ft, közlemény: GÉP-2026/118.',
     ['Takács Gábor', '10403387-00028572-00000000', 'HU93 1040 3387 0002 8572 0000 0000'],
     ['1 250 000 Ft', 'GÉP-2026/118']),
    ('Ismét jelentkezett Péternek a sógora, Lakatos Ferenc. Ferenccel abban maradtunk, hogy a gépet a 4025 Debrecen, Piac utca 12/A alá szállítjuk. Rendszám: AA BC-456.',
     ['Péternek', 'Lakatos Ferenc', 'Ferenccel', '4025 Debrecen, Piac utca 12/A', 'AA BC-456'],
     ['sógora', 'szállítjuk']),
    ('A szerver 10.0.0.15 címen fut, a backup 203.0.113.7-re megy. Port 3420, verzió 1.42.0. Nincs benne személyes adat.',
     ['10.0.0.15', '203.0.113.7'],
     ['3420', '1.42.0']),
    ('Elérhetőségek: Szilágyi Béla, bela.szilagyi[at]freemail.hu, mobil: 0036 70 987 6543; Németh Andrea – andrea.nemeth@ceg.hu – 06 1 456 7890.',
     ['Szilágyi Béla', 'bela.szilagyi[at]freemail.hu', '0036 70 987 6543', 'Németh Andrea', 'andrea.nemeth@ceg.hu', '06 1 456 7890'],
     []),
    ('Nagy kérés lenne, ha a Kiss utcai telephelyen is megnéznéd a gépet. Fekete színű, Simon Kft. gyártotta. Varga úrnak szólj.',
     ['Varga'],
     ['Nagy kérés', 'Kiss utcai', 'Fekete színű', 'Simon Kft.']),
    ('Személyi igazolvány: 987654CD, jogosítvány: AB123456, útlevél: BE1234567. Született Győrben, 1990. december 1-jén. Lakcím: 9021 Győr, Baross Gábor út 3. 2/7.',
     ['987654CD', 'AB123456', 'BE1234567', '1990. december 1', '9021 Győr, Baross Gábor út 3. 2/7'],
     ['Győrben']),
    ('Bálinttal beszéltem, Juhász Bálinttal. Holnap küldi a Claas Axion 870 adatlapját a juhasz.balint@agro-example.hu címre.',
     ['Bálinttal', 'Juhász Bálinttal', 'juhasz.balint@agro-example.hu'],
     ['Claas Axion 870', 'Holnap']),
    ('Ügyfél: Kelemen Józsefné, 3300 Eger, Széchenyi István utca 21. fszt. 2. Tel.: 06 (36) 555-123.',
     ['Kelemen Józsefné', '3300 Eger, Széchenyi István utca 21. fszt. 2', '06 (36) 555-123'],
     []),
    ('A tanuló adatai: Fodor Lilla, oktatási azonosító 72345678901, szül.: 2008. 02. 29., anyja: Bíró Edit.',
     ['Fodor Lilla', '72345678901', '2008. 02. 29', 'Bíró Edit'],
     []),
    ('Ma 14:00-kor review. A Szabó-féle módszert érdemes lenne kipróbálni a kanban auditban. Nincs itt semmi név.',
     [],
     ['review', 'kanban', 'Nincs']),
    ('Kérem utaljon a HU12 1200 1008 0012 3456 0010 0002 számlára, kedvezményezett: Pintér Tibor. Bankkártya: 4111 1111 1111 1111.',
     ['HU12 1200 1008 0012 3456 0010 0002', 'Pintér Tibor', '4111 1111 1111 1111'],
     []),
    ('Írtam Évának és Gergőnek is. Éva szerint a Nagy-féle traktor kész, Gergő a Fehérvári úton várja.',
     ['Évának', 'Gergőnek', 'Éva', 'Gergő'],
     ['Fehérvári úton']),
    ('Hívjon vissza a +36-20/123-45-67 számon vagy írjon: info.kovacs@pelda.hu. Céges: Kovács és Társa Bt.',
     ['+36-20/123-45-67', 'info.kovacs@pelda.hu'],
     ['Kovács és Társa Bt.']),
    ('Szőcs Anita 1985-ben született, a lakcímkártyáján: 1111 Budapest, Bartók Béla út 66. IV. em. 12.',
     ['Szőcs Anita', '1111 Budapest, Bartók Béla út 66. IV. em. 12'],
     []),
    ('Kiss Péter és Kissné Tóth Anna mindketten aláírták. Péterék a Fő téren laknak, 2 gyerekkel.',
     ['Kiss Péter', 'Kissné Tóth Anna', 'Péterék'],
     ['Fő téren']),
    ('Nagyon köszönöm! Sándor napja van ma, de nem tudom ki az. Simon szerint jó, Barna pedig maradjon a szín.',
     [],
     ['Nagyon', 'Sándor napja', 'Barna']),
]

# A forwarded complaint thread (mail headers, CRM table, log lines, JSON,
# free-text notes): 33 of 66 values leaked before the round that added it.
STRESS = '=== 1. levél (beérkezett: 2026. október 9., 08:14) ===\nFeladó: Varga Zsófia Annamária <varga.zsofi82@example.com>\nCímzett: ugyfelszolgalat@pelda-kft.example\nMásolat: dr. Horváth Gergely <horvath.gergely@ugyved-iroda.example>\n\nTisztelt Ügyfélszolgálat!\n\nVarga Zsófia vagyok (leánykori nevem: Kiss Zsófia), 1982. 07. 23-án\nszülettem Pécsett, anyám neve Molnár Katalin. Jelenleg a 7621 Pécs,\nKirály utca 45. II/6. alatt lakom, de a levelezési címem: 7601 Pécs,\nPf. 123. Az ügyintéző, Takács Dóra, múlt kedden azt mondta telefonon\n(+36 (72) 555-0142), hogy a hátralékomat elengedik. Most mégis\nfizetési felszólítást kaptam.\n\nA szerződésszámom: SZ-2025-0098765. Az ügyfélazonosítóm: ÜGY-445566.\nA bankszámlám: 10918001-00000012-34567890, az IBAN-om pedig\nHU93 1091 8001 0000 0012 3456 7890. Utalásnál a kártyámat használtam:\n4111 1111 1111 1111, lejárat 08/28, CVV 123. Ezt most már\nletiltattam.\n\nEgészségügyi okokból (cukorbetegség, 2-es típus, inzulinkezelés; a\nkezelőorvosom dr. Papp Lajos, Pécsi Klinikai Központ) nem tudtam\nhatáridőre fizetni, szeptemberben két hétig kórházban voltam. A TAJ-\nszámom 987 654 321, az adóazonosító jelem 8765432109. Ha kell, a\nzárójelentést elküldöm.\n\nÜdvözlettel:\nVarga Zsófia\nMobil: 06 30 / 555 - 7788  |  Otthoni: 72/555-0199\nFacebook: facebook.example/zsofi.varga.82\n\n=== 2. levél (belső, 2026. október 9., 11:40) ===\nFeladó: Takács Dóra <takacs.dora@pelda-kft.example>\nCímzett: Marveen\n\nSzia! Emlékszem a hívásra, de nem ígértem elengedést. Zsófi (így\nhívjuk a belső rendszerben) sokat telefonál, a hívásazonosító:\nCALL-20261006-7731. A hívás 14:22-kor volt, a számról: 0036 30 555 7788.\nSzerintem a férje, Varga Tibor (tibor.varga@example.org, +36-20-555-4321)\nis érintett, mert ő a társigénylő. Kérlek, ne említsd neki az orvosi\nrészleteket!\n\n=== Belső jegyzet / CRM-export ===\n| Ügyfél          | Születés   | Telefon          | E-mail                  | Rendszám | Státusz |\n|-----------------|------------|------------------|-------------------------|----------|---------|\n| Varga Zsófia    | 1982-07-23 | +36305557788     | varga.zsofi82@example.com | MNO-456  | nyitott |\n| Varga Tibor     | 1979-11-02 | +36205554321     | tibor.varga@example.org | PQR-789  | figyelt |\n| Szűcs-Barta Eszter | 1990-01-15 | 06-1-555-0123 | eszter@szucs-barta.example | AB-CD-123 | lezárt  |\n\n=== Rendszernapló (másolva a támogatástól) ===\n2026-10-09 11:52:03 INFO  login ok user=zvarga ip=198.51.100.23 ua="Mozilla/5.0"\n2026-10-09 11:52:41 WARN  payment declined card=****1111 amount=48900 HUF\n2026-10-09 11:53:10 INFO  api call Authorization: Bearer sk-test-FAKE1234567890abcdef\n2026-10-09 11:54:02 ERROR smtp send failed to=varga.zsofi82 [at] example [dot] com\n{"customer":{"name":"Varga Zsófia","dob":"1982-07-23","phone":"+36305557788",\n"address":{"zip":"7621","city":"Pécs","street":"Király utca 45."}},\n"iban":"HU93109180010000001234567890","note":"cukorbeteg, kórház 2026.09."}\n\n=== Szóbeli megjegyzések a hívásról (nem formázott) ===\nZsófi azt mondta, hogy a nővére, Kiss Réka (Budapest, Teszt sétány 8., 1111)\nfizeti majd a tartozást, az ő száma 06 1 555 0777, e-mailje\nreka.kiss at example pont hu. Réka azt is említette, hogy az anyjuk, Molnár\nKatalinné, Zsófiával él együtt, és "Kati néni" nem szeret telefonálni.\nA jelszó, amit Zsófi diktált a portálhoz: Pecs1982!Zsofi (ezt persze\nmeg kell változtatni). A PIN kódja 4821. Személyi igazolvány: 345678AB,\nútlevél: XA1234567.\n\n=== Feladat ===\n4. Mindezt angolul is add meg Mr. Jonathan Smith (j.smith@example.co.uk,\n   +44 20 7946 0123) számára, aki a külföldi leányvállalatnál dolgozik.\n'

STRESS_MUST = ['Annamária', 'varga.zsofi82@example.com', 'ugyfelszolgalat@pelda-kft.example', 'horvath.gergely@ugyved-iroda.example', 'Horváth Gergely', 'Kiss Zsófia', '1982. 07. 23', 'Molnár Katalin', 'Király utca 45. II/6', 'Pf. 123', 'Takács Dóra', '+36 (72) 555-0142', 'SZ-2025-0098765', 'ÜGY-445566', '10918001-00000012-34567890', 'HU93 1091 8001 0000 0012 3456 7890', '4111 1111 1111 1111', '08/28', 'CVV 123', 'cukorbetegség', 'inzulinkezelés', 'Papp Lajos', 'Pécsi Klinikai Központ', '987 654 321', '8765432109', '06 30 / 555 - 7788', '72/555-0199', 'facebook.example/zsofi.varga.82', 'takacs.dora@pelda-kft.example', 'Zsófi', 'CALL-20261006-7731', '0036 30 555 7788', 'Varga Tibor', 'tibor.varga@example.org', '+36-20-555-4321', '1982-07-23', '1979-11-02', '1990-01-15', '+36305557788', '+36205554321', 'MNO-456', 'PQR-789', 'Szűcs-Barta Eszter', '06-1-555-0123', 'eszter@szucs-barta.example', 'AB-CD-123', 'zvarga', '198.51.100.23', 'sk-test-FAKE1234567890abcdef', 'varga.zsofi82 [at] example [dot] com', 'HU93109180010000001234567890', 'cukorbeteg', 'Kiss Réka', 'Teszt sétány 8', '06 1 555 0777', 'reka.kiss at example pont hu', 'Katalinné', 'Zsófiával', 'Kati néni', 'Pecs1982!Zsofi', '4821', '345678AB', 'XA1234567', 'Jonathan Smith', 'j.smith@example.co.uk', '+44 20 7946 0123']

STRESS_KEEP = ['2026-10-09 11:52:03', '48900 HUF', 'Mozilla/5.0', 'Tisztelt Ügyfélszolgálat', 'Marveen', 'Státusz', '14:22', '2026. október 9']


def main() -> int:
    failed = False
    for text in (MSG1, MSG2):
        anonymized, _ = anonymize_text(text)
        for value in MUST:
            if value in text and value in anonymized:
                print(f"LEAK: {value!r} not masked")
                failed = True
    for text in NOISE:
        _, mapping = anonymize_text(text)
        if mapping:
            print(f"FALSE POSITIVE in {text[:40]!r}: {list(mapping.values())}")
            failed = True
    for text, must, keep in CASES + [(STRESS, STRESS_MUST, STRESS_KEEP)]:
        anonymized, _ = anonymize_text(text)
        for value in must:
            if value in anonymized:
                print(f"LEAK: {value!r} not masked")
                failed = True
        for value in keep:
            if value not in anonymized:
                print(f"OVERMASK: {value!r} was masked")
                failed = True
    print("FAIL" if failed else "recognizers: all pass")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
