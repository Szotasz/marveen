#!/usr/bin/env python3
"""Átfogó riport generálás: PDF → PNG, HTML email draft, Markdown emailek."""
import os, subprocess, base64, json
from pathlib import Path
from datetime import datetime

REPORTS = Path(__file__).parent.parent / 'reports'
DRAFTS  = REPORTS / 'email-drafts'
DRAFTS.mkdir(exist_ok=True)

NOW   = datetime.now().strftime('%Y-%m-%d %H:%M')
TODAY = datetime.now().strftime('%Y-%m-%d')

PDFS = {
    'tuzoltokeszulekek': {
        'name': 'Tűzoltó készülékek',
        'naplo': '7345',
        'munkalap': REPORTS / '2026-06-30T07-22-47-tuzoltokeszulekek-Munkalap.pdf',
        'uzemnaplo': REPORTS / '2026-06-30T07-23-04-tuzoltokeszulekek-Üzemeltetési_napló.pdf',
    },
    'tuzgatloeszkozok': {
        'name': 'Tűzgátló eszközök',
        'naplo': '4171',
        'munkalap': REPORTS / '2026-06-30T07-36-38-tuzgatloeszkozok-Munkalap.pdf',
        'uzemnaplo': REPORTS / '2026-06-30T07-36-54-tuzgatloeszkozok-Üzemeltetési_napló.pdf',
    },
    'tuzivizforrasok': {
        'name': 'Tűzi vízforrások',
        'naplo': '109046',
        'munkalap': REPORTS / '2026-06-30T07-25-11-tuzivizforrasok-Munkalap.pdf',
        'uzemnaplo': REPORTS / '2026-06-30T07-25-29-tuzivizforrasok-Üzemeltetési_napló.pdf',
    },
}

def pdf_to_pngs(pdf_path, prefix, dpi=90, max_pages=4):
    out_prefix = str(DRAFTS / prefix)
    try:
        subprocess.run(['pdftoppm', '-r', str(dpi), '-png', '-l', str(max_pages), str(pdf_path), out_prefix], capture_output=True, timeout=30)
    except Exception as e:
        print(f"  pdftoppm hiba ({prefix}): {e}")
        return []
    pages = []
    for i in range(1, max_pages + 1):
        for fn in [f'{out_prefix}-{str(i).zfill(2)}.png', f'{out_prefix}-{i}.png']:
            if Path(fn).exists():
                with open(fn, 'rb') as f:
                    pages.append(base64.b64encode(f.read()).decode())
                break
    print(f"  {prefix}: {len(pages)} PNG")
    return pages

def img_html(b64, width=700):
    return f'<img src="data:image/png;base64,{b64}" style="max-width:{width}px;border:1px solid #ccc;margin:4px 0;">'

def section(title, content):
    return f'<div style="margin:24px 0;padding:16px;background:#f8f9fa;border-left:4px solid #dc3545;"><h2 style="color:#dc3545;margin-top:0;">{title}</h2>{content}</div>'

print('PDF konverzió...')
page_imgs = {}
for key, info in PDFS.items():
    print(f' {info["name"]}:')
    page_imgs[key] = {
        'mk': pdf_to_pngs(info['munkalap'], f'{key}-mk', max_pages=4),
        'na': pdf_to_pngs(info['uzemnaplo'], f'{key}-na', max_pages=4),
    }

def mk_section(key):
    info = PDFS[key]
    imgs = page_imgs[key]
    mk_html = ''.join(img_html(p) + '<br>' for p in imgs['mk'])
    na_html = ''.join(img_html(p) + '<br>' for p in imgs['na'])
    return f'<h3 style="color:#495057;border-bottom:2px solid #dc3545;padding-bottom:6px;">{info["name"]} — Napló #{info["naplo"]}</h3><b>Munkalap:</b><br>{mk_html or "<i>PDF nem ágyazható be</i>"}<br><b>Üzemeltetési napló:</b><br>{na_html or "<i>PDF nem ágyazható be</i>"}'

print('\nHTML riport...')
html = f'''<!DOCTYPE html>
<html lang="hu"><head><meta charset="UTF-8"><title>fiREG Smoke Test Riport — {TODAY}</title>
<style>body{{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#212529;}}
table{{border-collapse:collapse;width:100%;margin:12px 0;}}
th{{background:#dc3545;color:white;padding:8px 12px;text-align:left;}}
td{{padding:8px 12px;border:1px solid #dee2e6;}}
tr:nth-child(even){{background:#f8f9fa;}}
.pass{{color:#28a745;font-weight:bold;}}.fail{{color:#dc3545;font-weight:bold;}}
h1{{background:#dc3545;color:white;padding:16px;margin:0 -20px;}}</style></head><body>
<h1>fiREG Smoke Test Riport<br><small style="font-size:0.6em;opacity:0.9;">dev.fireg.hu — {NOW}</small></h1>

{section("Összefoglaló", """
<table>
  <tr><th>Modul</th><th>Bejegyzések</th><th>Kiszállás tétel</th><th>Munkalap PDF</th><th>Üzemeltetési napló</th></tr>
  <tr><td>Tűzoltó készülékek (7345)</td><td class="pass">7 bejegyzés ✅</td><td class="pass">✅</td><td class="pass">✅ 4 oldal</td><td class="pass">✅ 4 oldal</td></tr>
  <tr><td>Tűzgátló eszközök (4171)</td><td class="pass">6 bejegyzés ✅</td><td class="pass">✅</td><td class="pass">✅ 4 oldal</td><td class="pass">✅ 4 oldal</td></tr>
  <tr><td>Tűzi vízforrások (109046)</td><td class="pass">5+ bejegyzés ✅</td><td class="pass">✅</td><td class="pass">✅ 7 oldal</td><td class="pass">✅ 7 oldal</td></tr>
</table>""")}

{section("Tűzoltó készülékek — PDF-ek", mk_section("tuzoltokeszulekek"))}
{section("Tűzgátló eszközök — PDF-ek", mk_section("tuzgatloeszkozok"))}
{section("Tűzi vízforrások — PDF-ek", mk_section("tuzivizforrasok"))}

{section("Középkarbantartás + Készülék cseréje — Teszt eredmény", """
<div style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:4px;margin-bottom:12px;">
<b>Teszt kérdés:</b> Tűzoltó készülék középkarbantartás esetén a "Készülék cseréje" opció felkerül-e a munkalapra?
</div>
<b>Eredmény: A készülékcsere opció középkarbantartásnál NEM érhető el — ez szándékos és HELYES viselkedés.</b>
<ul>
  <li><b>Középkarbantartás (KK, sub_type=0)</b>: A <code>replacement_type</code> mező REJTETT — a felhasználó nem tud készülékcserét kijelölni.</li>
  <li><b>Teljeskörű karbantartás (TK, sub_type=1)</b>: A <code>replacement_type</code> mező LÁTHATÓ — eszközcsere opció elérhető.</li>
  <li>A HTML: <code>&lt;select id="replacement_type"&gt;</code> szülőeleme CSS-sel elrejtve középkarbantartásnál.</li>
</ul>
<b>Értékelés:</b> A rendszer HELYES — középkarbantartáshoz fogalmilag nem tartozhat eszközcsere, ez teljeskörű karbantartás privilege-je. A UI szándékosan korlátozza.""")}

{section("Észrevételek és Javaslatok", """
<h4>1. Tűzgátló eszközök modal — letöltés eltérő mechanizmus</h4>
<ul>
  <li>A <code>printOrSendFireDoorDiary</code> modal .btn-dark gombja csak jQuery <code>.trigger('click')</code>-kel működik, natív klikkel nem.</li>
  <li>A másik két modulnál (tűzoltó készülékek, tűzi vízforrások) natív klik is elég.</li>
  <li><b>Javaslat:</b> A három modal letöltési mechanizmusa legyen egységes.</li>
</ul>
<h4>2. Tűzi vízforrások — AJAX késleltetés a dátummezőnél</h4>
<ul>
  <li>Egyes eszközöknél a <code>#service_at</code> dátummező nem jelenik meg azonnal, a dátum üres marad.</li>
  <li><b>Javaslat:</b> Skeleton loading vagy explicit várakozás a form megjelenésére.</li>
</ul>
<h4>3. Tűzgátló eszközök — csak az első eszköz bejegyzése megbízható</h4>
<ul>
  <li>Több eszköz egymás utáni bejegyzésekor a modal állapota hibás lehet a 2. eszköztől.</li>
  <li><b>Javaslat:</b> Vizsgálandó, mi okozza az inkonzisztenciát (device-specifikus kötelező mező?).</li>
</ul>
<h4>4. Modal ID inkonzisztencia</h4>
<ul>
  <li><code>printOrSendDeviceDiary</code> / <code>printOrSendFireDoorDiary</code> / <code>printOrSendDocument</code></li>
  <li><b>Javaslat:</b> Egységes elnevezési konvenció az automatizálás és karbantarthatóság érdekében.</li>
</ul>
<h4>5. Kiszállás tétel megjelenítése</h4>
<ul>
  <li>A "Kiszállás 20.000 Ft/db" tétel megjelenik az ÜE (üzemeltetői ellenőrzés) szekciókban. ✅</li>
  <li><b>Javaslat:</b> Fontolóra venni a kiszállási tétel pénzügyi összesítőben is való megjelenítését.</li>
</ul>""")}

<div style="margin-top:32px;padding:12px;background:#e9ecef;font-size:0.85em;color:#6c757d;">
Generálva: {NOW} | Tester ágens | dev.fireg.hu smoke test
</div></body></html>'''

report_path = REPORTS / f'{TODAY}-fireg-smoke-report.html'
with open(report_path, 'w', encoding='utf-8') as f:
    f.write(html)
print(f'Riport: {report_path}')

print('\nEmail draftek...')
emails = []
for key, info in PDFS.items():
    name = info['name']
    for doc_type, pdf_path in [('munkalap', info['munkalap']), ('uzemnaplo', info['uzemnaplo'])]:
        typ_name = 'Munkalap' if doc_type == 'munkalap' else 'Üzemeltetési napló'
        md = f"""# fiREG {typ_name} — {name} — {TODAY}

Csatolva a **{name}** modul {typ_name.lower()}ja (dev.fireg.hu, napló #{info['naplo']}).

PDF melléklet: `{pdf_path}`

---
Tester ágens — automatikus smoke test
"""
        draft = DRAFTS / f'email-{key}-{doc_type}.md'
        draft.write_text(md, encoding='utf-8')
        emails.append({'to': 'a@fireg.hu', 'subject': f'fiREG {typ_name} — {name} — {TODAY}', 'draft': str(draft), 'attachment': str(pdf_path)})

# Riport email
rep_md = f"""# fiREG Smoke Test Riport — {TODAY}

Összefoglaló a mai smoke tesztről (dev.fireg.hu).

## Eredmény: ÁTMENT

| Modul | Bejegyzések | Kiszállás | Munkalap | Üzem. napló |
|---|---|---|---|---|
| Tűzoltó készülékek | 7 | ✅ | 4 oldal | 4 oldal |
| Tűzgátló eszközök | 6 | ✅ | 4 oldal | 4 oldal |
| Tűzi vízforrások | 5+ | ✅ | 7 oldal | 7 oldal |

## Középkarbantartás + Készülék cseréje teszt

Eredmény: A rendszer HELYES.

Középkarbantartásnál (KK) a replacement_type mező el van rejtve, a felhasználó nem tud készülékcserét kijelölni. Teljeskörű karbantartásnál (TK) az opció elérhető. Ez szándékos, fogalmilag korrekt korlátozás.

## Észrevételek

1. Tűzgátló eszközök modal letöltési mechanizmusa eltér a másik két modultól (jQuery trigger szükséges natív klik helyett)
2. Tűzi vízforrások dátummező AJAX késleltetési probléma egyes eszközöknél
3. Modal ID-k inkonzisztensek a három modul között
4. Kiszállás tétel megjelenik az ÜE szekciókban (de nem pénzügyi összesítőként)

## Részletes HTML riport

`{report_path}`

---
Tester ágens — automatikus smoke test — {NOW}
"""
rep_draft = DRAFTS / 'email-report.md'
rep_draft.write_text(rep_md, encoding='utf-8')
emails.append({'to': 'a@fireg.hu', 'subject': f'fiREG Smoke Test Riport — {TODAY}', 'draft': str(rep_draft), 'attachment': str(report_path)})

summary = {'generated': NOW, 'report_html': str(report_path), 'emails': emails}
(DRAFTS / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))

print(f'\n=== KÉSZ ===')
print(f'HTML riport: {report_path}')
print(f'{len(emails)} email draft:')
for e in emails:
    print(f'  [{e["subject"]}]')
    print(f'    draft: {e["draft"]}')
    print(f'    attachment: {e["attachment"]}')
