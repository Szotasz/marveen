#!/usr/bin/env python3
"""Recognizer regression test for the PII service. Needs the service venv
(Presidio + the xx_ent_wiki_sm spaCy model), so it is not part of CI:

    .venv/bin/python test_recognizers.py

MUST: every listed value must be masked in MSG1/MSG2 (all data is synthetic).
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
    print("FAIL" if failed else "recognizers: all pass")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
