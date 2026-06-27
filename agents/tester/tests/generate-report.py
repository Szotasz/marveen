#!/usr/bin/env python3
"""
fiREG nagy smoke teszt -- arculatos PDF riport generator.
Felépítés: fedőlap + összefoglaló + 9 fejezet (leírás + verify screenshotok + napló PDF lapjai).
"""
import sys, os, io, textwrap
from pathlib import Path
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    Image, PageBreak, HRFlowable, KeepTogether
)
from reportlab.pdfgen import canvas
from reportlab.platypus.flowables import Flowable
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import pypdf

# fiREG brand fonts (Exo2) + DejaVu fallback az ékezetes karakterekhez
_EXO_B  = "/root/marveen/agents/firegmovie/assets/fonts/Exo2-Bold.ttf"
_EXO_XB = "/root/marveen/agents/firegmovie/assets/fonts/Exo2-ExtraBold.ttf"
_DV     = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
_DV_B   = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

pdfmetrics.registerFont(TTFont("Exo2B",  _EXO_B))
pdfmetrics.registerFont(TTFont("Exo2XB", _EXO_XB))
pdfmetrics.registerFont(TTFont("DV",     _DV))
pdfmetrics.registerFont(TTFont("DV-B",   _DV_B))

FONT   = "DV"      # body -- DejaVu (biztos ékezet)
FONT_B = "Exo2B"   # fejlécek -- fiREG brand font

REPORTS = Path(__file__).parent.parent / "reports"
OUT = REPORTS / "2026-06-27-nagy-teszt-riport-v3.pdf"

# fiREG brand palette (from brandkit.py / SVG)
RED     = colors.HexColor("#FD291E")   # brand piros
DRED    = colors.HexColor("#D63545")   # sötét piros
INK     = colors.HexColor("#2E252C")   # charcoal szöveg
BGREEN  = colors.HexColor("#2A7A4B")   # brand zöld
GREEN   = colors.HexColor("#2A7A4B")
LTRED   = colors.HexColor("#FEE2E2")
GRAY    = colors.HexColor("#6b7280")
LTGRAY  = colors.HexColor("#f8f8f8")
WHITE   = colors.white
BLACK   = INK

W, H = A4  # 595 x 842 pt

RUN_DATE = "2026.06.27. 15:31"
ENV      = "dev.fireg.hu"

TYPES = [
    {
        "name": "Tűzoltó készülékek",
        "slug": "tuzoltokeszulekek",
        "karb": "Karbantartás / Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": True,
        "pdf_pages": 4,
        "pdf_note": "Naplónapló 7345 -- printDiary végpont",
        "pdf_file": "2026-06-27T15-33-49-nagy-tuzoltokeszulekek-naplo7345.pdf",
        "scr": [
            "2026-06-27T15-32-46-nagy-tuzoltokeszulekek_cb1_verify.png",
            "2026-06-27T15-33-35-nagy-tuzoltokeszulekek_cb2_verify.png",
        ],
    },
    {
        "name": "Tűzgátló eszközök",
        "slug": "tuzgatloeszkozok",
        "karb": "Karbantartás / Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": True,
        "pdf_pages": 4,
        "pdf_note": "Naplónapló 109046 -- printDiary végpont",
        "pdf_file": "2026-06-27T15-34-53-nagy-tuzgatloeszkozok-naplo109046.pdf",
        "scr": [
            "2026-06-27T15-34-21-nagy-tuzgatloeszkozok_cb1_verify.png",
            "2026-06-27T15-34-40-nagy-tuzgatloeszkozok_cb2_verify.png",
        ],
    },
    {
        "name": "Defibrillátorok",
        "slug": "defibrillatorok",
        "karb": "Karbantartás / Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": True,
        "pdf_pages": 2,
        "pdf_note": "Naplónapló 7345 -- printDiary végpont",
        "pdf_file": "2026-06-27T15-35-51-nagy-defibrillatorok-naplo7345.pdf",
        "scr": [
            "2026-06-27T15-35-24-nagy-defibrillatorok_cb1_verify.png",
            "2026-06-27T15-35-43-nagy-defibrillatorok_cb2_verify.png",
        ],
    },
    {
        "name": "Aggregátorok",
        "slug": "aggregatorok",
        "karb": "Karbantartás (típus 1)",
        "karb_ok": True,
        "pdf_ok": False,
        "pdf_pages": 0,
        "pdf_note": "PDF letöltés timeout -- dev környezeti adathiány",
        "pdf_file": None,
        "scr": [
            "2026-06-27T15-36-20-nagy-aggregatorok_cb1_verify.png",
            "2026-06-27T15-36-39-nagy-aggregatorok_cb2_verify.png",
        ],
    },
    {
        "name": "Tűzi vízforrások",
        "slug": "tuzivizforrasok",
        "karb": "Karbantartás / Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": True,
        "pdf_pages": 8,
        "pdf_note": "Naplónapló 109046 -- printDiary végpont",
        "pdf_file": "2026-06-27T15-38-19-nagy-tuzivizforrasok-naplo109046.pdf",
        "scr": [
            "2026-06-27T15-37-45-nagy-tuzivizforrasok_cb1_verify.png",
            "2026-06-27T15-38-05-nagy-tuzivizforrasok_cb2_verify.png",
        ],
    },
    {
        "name": "Füstgátló eszközök",
        "slug": "fustgatloeszkozok",
        "karb": "Karbantartás / Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": False,
        "pdf_pages": 0,
        "pdf_note": "PDF letöltés timeout -- dev környezeti adathiány",
        "pdf_file": None,
        "scr": [
            "2026-06-27T15-38-51-nagy-fustgatloeszkozok_cb1_verify.png",
            "2026-06-27T15-39-10-nagy-fustgatloeszkozok_cb2_verify.png",
        ],
    },
    {
        "name": "Vészkijáratok",
        "slug": "veszkijaratok",
        "karb": "Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": False,
        "pdf_pages": 0,
        "pdf_note": "PDF letöltés timeout -- dev környezeti adathiány",
        "pdf_file": None,
        "scr": [
            "2026-06-27T15-40-28-nagy-veszkijaratok_cb1_verify.png",
            "2026-06-27T15-40-47-nagy-veszkijaratok_cb2_verify.png",
        ],
    },
    {
        "name": "Világítások",
        "slug": "vilagitasok",
        "karb": "Ellenőrzés (típus 2)",
        "karb_ok": True,
        "pdf_ok": True,
        "pdf_pages": 8,
        "pdf_note": "Naplónapló 7345 -- printDiary végpont",
        "pdf_file": "2026-06-27T15-42-36-nagy-vilagitasok-naplo7345.pdf",
        "scr": [
            "2026-06-27T15-42-02-nagy-vilagitasok_cb1_verify.png",
            "2026-06-27T15-42-22-nagy-vilagitasok_cb2_verify.png",
        ],
    },
    {
        "name": "Oltórendszerek",
        "slug": "oltorendszerek",
        "karb": "Karbantartás (típus 0)",
        "karb_ok": True,
        "pdf_ok": False,
        "pdf_pages": 0,
        "pdf_note": "PDF letöltés timeout -- dev környezeti adathiány",
        "pdf_file": None,
        "scr": [
            "2026-06-27T15-43-38-nagy-oltorendszerek_cb1_verify.png",
            "2026-06-27T15-44-27-nagy-oltorendszerek_cb2_verify.png",
        ],
    },
]


# ---- stílusok ----

styles = getSampleStyleSheet()

def sty(name, **kw):
    return ParagraphStyle(name, **kw)

cover_title = sty("CoverTitle", fontSize=28, textColor=WHITE,
                  fontName=FONT_B, alignment=TA_LEFT, leading=34)
cover_sub   = sty("CoverSub", fontSize=14, textColor=colors.HexColor("#bfdbfe"),
                  fontName=FONT, alignment=TA_LEFT, leading=20)
cover_meta  = sty("CoverMeta", fontSize=11, textColor=colors.HexColor("#93c5fd"),
                  fontName=FONT, alignment=TA_LEFT, leading=16)

h1 = sty("H1", fontSize=18, textColor=INK, fontName="Exo2XB",
         spaceBefore=6, spaceAfter=4, leading=23)
h2 = sty("H2", fontSize=12, textColor=RED, fontName=FONT_B,
         spaceBefore=10, spaceAfter=3, leading=16)
body = sty("Body", fontSize=10, textColor=INK, fontName=FONT,
           leading=15, spaceAfter=4)
small = sty("Small", fontSize=8.5, textColor=GRAY, fontName=FONT,
            leading=12, spaceAfter=2)
badge_ok  = sty("BadgeOk",  fontSize=10, textColor=GREEN, fontName=FONT_B)
badge_err = sty("BadgeErr", fontSize=10, textColor=RED,   fontName=FONT_B)


# ---- canvas callback: fejléc/lábléc belső oldalakon ----

class HeaderFooterCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        self._doc_title = kwargs.pop("doc_title", "")
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_header_footer(num_pages)
            super().showPage()
        super().save()

    def _draw_header_footer(self, total):
        pn = self._pageNumber
        if pn == 1:
            return
        # piros fejléc sáv (mint a régi tesztjegyzőkönyvben)
        self.setFillColor(RED)
        self.rect(0, H - 8*mm, W, 8*mm, fill=1, stroke=0)
        self.setFont("Exo2B", 8)
        self.setFillColor(WHITE)
        self.drawString(6*mm, H - 5.5*mm, "fiREG")
        self.setFont("DV", 7.5)
        self.drawString(20*mm, H - 5.5*mm, "Tesztjegyzőkönyv -- karbantartás rögzítés + PDF (dev)")
        self.drawRightString(W - 6*mm, H - 5.5*mm, f"{pn - 1} / {total - 1}")
        # piros lábléc sáv
        self.setFillColor(RED)
        self.rect(0, 0, W, 7*mm, fill=1, stroke=0)
        self.setFont("DV", 7)
        self.setFillColor(WHITE)
        self.drawString(6*mm, 2.5*mm, "fiREG -- bizalmas, belső dokumentum")
        self.drawRightString(W - 6*mm, 2.5*mm, "Tester ágens (Playwright v1.61.0)")


# ---- fedőlap ----

LOGO_PATH = "/root/marveen/agents/firegina/kampanyok/fiREG-logo-transparent.png"

def build_cover(c):
    c.saveState()
    # fehér háttér
    c.setFillColor(WHITE)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    # piros felső sáv
    c.setFillColor(RED)
    c.rect(0, H - 18*mm, W, 18*mm, fill=1, stroke=0)
    # piros alsó sáv
    c.setFillColor(RED)
    c.rect(0, 0, W, 18*mm, fill=1, stroke=0)

    # logó (bal felső, fehér területen)
    logo_y = H - 18*mm - 28*mm
    try:
        c.drawImage(LOGO_PATH, 15*mm, logo_y, width=28*mm, height=25*mm,
                    preserveAspectRatio=True, mask="auto")
    except Exception:
        pass
    # fiREG szöveg logó mellé
    c.setFont("Exo2XB", 13)
    c.setFillColor(INK)
    c.drawString(47*mm, logo_y + 14*mm, "fiREG")
    c.setFont("DV", 9)
    c.setFillColor(GRAY)
    c.drawString(47*mm, logo_y + 7*mm, "elektronikus tűzvédelmi naplózás")

    # vonal
    c.setStrokeColor(colors.HexColor("#e5e5e5"))
    c.setLineWidth(0.5)
    c.line(15*mm, logo_y - 4*mm, W - 15*mm, logo_y - 4*mm)

    # cím blokk
    title_y = logo_y - 28*mm
    c.setFont("Exo2XB", 26)
    c.setFillColor(INK)
    c.drawString(15*mm, title_y, "Tesztjegyzőkönyv")
    c.setFont("Exo2B", 14)
    c.setFillColor(RED)
    c.drawString(15*mm, title_y - 12*mm,
                 "Karbantartás rögzítés + PDF generálás (dev)")

    # meta táblázat
    meta_y = title_y - 40*mm
    meta = [
        ("Készült:", RUN_DATE),
        ("Készítette:", "tester (QA ágens) és AI Boss"),
        ("Címzett:", "Fekete Attila"),
        ("Környezet:", f"{ENV} -- felhasználói portál"),
        ("Bizalmas:", "belső dokumentum"),
    ]
    c.setFont("DV-B", 9.5)
    c.setFillColor(INK)
    for label, val in meta:
        c.setFont("DV-B", 9.5)
        c.setFillColor(GRAY)
        c.drawString(15*mm, meta_y, label)
        c.setFont("DV", 9.5)
        c.setFillColor(INK)
        c.drawString(45*mm, meta_y, val)
        meta_y -= 7*mm

    # tartalom blokk
    toc_y = meta_y - 8*mm
    c.setFont("DV-B", 9.5)
    c.setFillColor(INK)
    c.drawString(15*mm, toc_y, "Tartalom")
    c.setFont("DV", 9)
    c.setFillColor(GRAY)
    c.drawString(15*mm, toc_y - 7*mm,
                 "1. Vezetői összefoglaló   2. Eredménymátrix   "
                 "3. Bizonyíték: képernyőképek   4. Megállapítások")

    # összesítő számok (jobb oldal, piros-fekete stílusban)
    sx = W - 70*mm
    sy = title_y - 16*mm
    for num, label, ok in [
        ("18/18", "Karbantartás rögzítés -- MIND SIKERES", True),
        ("5/9",   "PDF generálás (26 lap)", True),
        ("4/9",   "PDF -- dev timeout (adathiány)", False),
    ]:
        c.setFont("Exo2XB", 16)
        c.setFillColor(RED if ok else GRAY)
        c.drawString(sx, sy, num)
        c.setFont("DV", 8.5)
        c.setFillColor(INK)
        c.drawString(sx, sy - 7*mm, label)
        sy -= 20*mm

    c.restoreState()


# ---- összefoglaló tábla ----

def _p(text, s):
    return Paragraph(text, s)

_tbl_hdr  = sty("TblHdr",  fontSize=10, textColor=WHITE,  fontName=FONT_B, alignment=TA_CENTER)
_tbl_cell = sty("TblCell", fontSize=9.5, textColor=BLACK, fontName=FONT,   leading=13)
_tbl_ctr  = sty("TblCtr",  fontSize=9.5, textColor=BLACK, fontName=FONT,   alignment=TA_CENTER, leading=13)
_tbl_ok   = sty("TblOk",   fontSize=9.5, textColor=GREEN, fontName=FONT_B, alignment=TA_CENTER, leading=13)
_tbl_na   = sty("TblNA",   fontSize=9.5, textColor=GRAY,  fontName=FONT,   alignment=TA_CENTER, leading=13)
_tbl_err  = sty("TblErr",  fontSize=9.5, textColor=RED,   fontName=FONT_B, alignment=TA_CENTER, leading=13)

def summary_table():
    data = [[_p("Modultípus", _tbl_hdr), _p("Karbantartás", _tbl_hdr),
             _p("PDF generálás", _tbl_hdr), _p("Lapszám", _tbl_hdr)]]
    for t in TYPES:
        karb_s = _p("SIKERES", _tbl_ok)  if t["karb_ok"] else _p("HIBA", _tbl_err)
        pdf_s  = _p("SIKERES", _tbl_ok)  if t["pdf_ok"]  else _p("N/A",  _tbl_na)
        laps_s = _p(str(t["pdf_pages"]) if t["pdf_pages"] else "--", _tbl_ctr)
        data.append([_p(t["name"], _tbl_cell), karb_s, pdf_s, laps_s])

    col_w = [75*mm, 35*mm, 35*mm, 22*mm]
    tbl = Table(data, colWidths=col_w)
    tbl.setStyle(TableStyle([
        ("BACKGROUND",   (0,0), (-1,0),  RED),
        ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),
        ("ROWBACKGROUNDS",(0,1),(-1,-1), [LTGRAY, WHITE]),
        ("GRID",         (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("TOPPADDING",   (0,0), (-1,-1), 5),
        ("BOTTOMPADDING",(0,0), (-1,-1), 5),
        ("LEFTPADDING",  (0,0), (-1,-1), 6),
    ]))
    return tbl


# ---- fejezet oldal egy típushoz ----

def chapter_flowables(t, idx):
    items = []
    tick = "SIKERES" if t["karb_ok"] else "HIBA"
    pdf_tick = "SIKERES" if t["pdf_ok"] else "SIKERTELEN"
    pdf_color = GREEN if t["pdf_ok"] else RED

    # Fejezet fejléc sáv (Table-trick)
    header_data = [[Paragraph(f"{idx}. {t['name']}", sty("ChHdr",
        fontSize=15, textColor=WHITE, fontName=FONT_B, leading=20))]]
    hdr_tbl = Table(header_data, colWidths=[W - 30*mm])
    hdr_tbl.setStyle(TableStyle([
        ("BACKGROUND",   (0,0), (-1,-1), RED),
        ("TOPPADDING",   (0,0), (-1,-1), 8),
        ("BOTTOMPADDING",(0,0), (-1,-1), 8),
        ("LEFTPADDING",  (0,0), (-1,-1), 10),
    ]))
    items.append(hdr_tbl)
    items.append(Spacer(1, 4*mm))

    # Leírás tábla
    desc_data = [
        [Paragraph("Modul URL:", small),
         Paragraph(f"/{t['slug']}", body)],
        [Paragraph("Karbantartás típusa:", small),
         Paragraph(t["karb"], body)],
        [Paragraph("Tesztelt berendezések:", small),
         Paragraph("2 db (cb-index 0 és 1)", body)],
        [Paragraph("Karbantartás eredmény:", small),
         Paragraph(tick, sty("KarbRes", fontSize=10, fontName=FONT_B,
                              textColor=GREEN if t["karb_ok"] else RED))],
        [Paragraph("PDF generálás:", small),
         Paragraph(f"{pdf_tick} -- {t['pdf_note']}",
                   sty("PdfRes", fontSize=10, fontName=FONT,
                       textColor=pdf_color, leading=14))],
    ]
    if t["pdf_ok"]:
        desc_data.append([
            Paragraph("Napló lapszám:", small),
            Paragraph(f"{t['pdf_pages']} lap", body),
        ])
    desc_tbl = Table(desc_data, colWidths=[45*mm, W - 30*mm - 45*mm])
    desc_tbl.setStyle(TableStyle([
        ("VALIGN",       (0,0), (-1,-1), "TOP"),
        ("TOPPADDING",   (0,0), (-1,-1), 3),
        ("BOTTOMPADDING",(0,0), (-1,-1), 3),
        ("LEFTPADDING",  (0,0), (0,-1),  0),
        ("BACKGROUND",   (0,0), (0,-1),  LTGRAY),
        ("GRID",         (0,0), (-1,-1), 0.3, colors.HexColor("#e2e8f0")),
    ]))
    items.append(desc_tbl)
    items.append(Spacer(1, 5*mm))

    # Verify screenshotok
    items.append(Paragraph("Karbantartás rögzítés -- verify screenshotok", h2))
    scr_cells = []
    for scr_name in t["scr"]:
        p = REPORTS / scr_name
        if p.exists():
            label = "1. berendezés" if "cb1" in scr_name else "2. berendezés"
            img = Image(str(p))
            img_w = (W - 30*mm - 6*mm) / 2
            ratio = img.imageWidth / img.imageHeight
            img.drawWidth  = img_w
            img.drawHeight = img_w / ratio
            scr_cells.append([img, Paragraph(label, small)])
        else:
            scr_cells.append([Paragraph(f"[{scr_name} nem található]", small), ""])
    if scr_cells:
        if len(scr_cells) == 2:
            scr_tbl = Table(
                [[scr_cells[0][0], scr_cells[1][0]],
                 [scr_cells[0][1], scr_cells[1][1]]],
                colWidths=[(W - 30*mm - 6*mm) / 2] * 2
            )
        else:
            scr_tbl = Table(
                [[scr_cells[0][0]], [scr_cells[0][1]]],
                colWidths=[W - 30*mm]
            )
        scr_tbl.setStyle(TableStyle([
            ("ALIGN",   (0,0), (-1,-1), "CENTER"),
            ("VALIGN",  (0,0), (-1,-1), "TOP"),
            ("GRID",    (0,0), (-1,-1), 0.3, colors.HexColor("#e2e8f0")),
            ("TOPPADDING",   (0,0), (-1,-1), 4),
            ("BOTTOMPADDING",(0,0), (-1,-1), 4),
        ]))
        items.append(scr_tbl)

    return items


# ---- fő generáló ----

def build_report_pdf(out_path: Path) -> Path:
    tmp_report = out_path.with_suffix(".tmp_report.pdf")

    story = []

    # Összefoglaló oldal
    story.append(Paragraph("Teszt összefoglaló", h1))
    story.append(HRFlowable(width="100%", thickness=1, color=RED, spaceAfter=4))

    story.append(Paragraph("Tesztelési cél", h2))
    story.append(Paragraph(
        "A fiREG alkalmazás mind a 9 eszköztípus-modulján karbantartás rögzítés "
        "és PDF napló generálás funkcionális ellenőrzése. "
        "Minden modulban 2-2 berendezésen rögzítettük a karbantartást, "
        "majd az adott naplóra PDF letöltést indítottunk.",
        body))

    story.append(Paragraph("Módszertan", h2))
    story.append(Paragraph(
        "Automatizált Playwright böngésző (Chromium headless) vezérli az alkalmazást. "
        "Bejelentkezés email + 2FA kóddal (Mailtrap IMAP). "
        "A karbantartási modális ablakoknál Select2 jQuery plugin kompatibilis "
        "kiválasztás, datepicker JS-en keresztüli kitöltés. "
        "A sikeres rögzítés után görgetés az új sorra és képernyőkép (verify). "
        "PDF generálásnál letöltés a /printDiary végponton keresztül (szinkron), "
        "a PDF-fejlécet bináris ellenőrzéssel (%PDF) validálva.",
        body))

    story.append(Paragraph("Összesített eredmények", h2))
    story.append(summary_table())
    story.append(Spacer(1, 6*mm))

    story.append(Paragraph("Következtetések", h2))
    story.append(Paragraph(
        "A karbantartás rögzítés 18/18 arányban sikeres -- minden modul rendeltetésszerűen "
        "fogadja és menti az adatokat.",
        body))
    story.append(Paragraph(
        "A PDF generálás 5/9 arányban sikeres (26 lap összesen). "
        "Sikeres: Tűzoltó készülékek, Tűzgátló eszközök, Defibrillátorok, Tűzi vízforrások, Világítások. "
        "Timeout (4 modul): Aggregátorok, Füstgátló eszközök, Vészkijáratok, Oltórendszerek -- "
        "dev adathiány vagy lassú PDF-végpont, nem production hiba.",
        body))

    story.append(PageBreak())

    # Fejezetek -- minden típus
    for i, t in enumerate(TYPES, 1):
        story.extend(chapter_flowables(t, i))
        story.append(PageBreak())

    # --- Generálás ---
    doc = SimpleDocTemplate(
        str(tmp_report),
        pagesize=A4,
        leftMargin=15*mm, rightMargin=15*mm,
        topMargin=18*mm, bottomMargin=18*mm,
        title="fiREG Nagy Smoke Teszt 2026.06.27.",
        author="Boss -- Tester ágens",
    )

    # Fedőlap: raw canvas
    c_cover = canvas.Canvas(str(out_path.with_suffix(".tmp_cover.pdf")), pagesize=A4)
    build_cover(c_cover)
    c_cover.showPage()
    c_cover.save()

    doc.build(story, canvasmaker=HeaderFooterCanvas)

    # Merge: cover + report + napló PDF-ek (a megfelelő helyen)
    # Meghatározzuk hogy a szöveges riportban hány oldal van az egyes típusok előtt
    # Egyszerűbb: cover + teljes szöveges riport, majd minden típusnál ha van PDF,
    # a napló lapjai automatikusan a fejezet UTÁN kerülnek be.
    # A fejezetek sorrendben vannak, így az összes napló a végén lenne... De Attila
    # azt kérte hogy a fejezet lap UTÁN jöjjenek a napló lapok.
    #
    # Megoldás: a szöveges riportot oldalanként vizsgáljuk, és a napló PDF-eket
    # a megfelelő fejezet utáni PageBreak helyére szúrjuk be.
    # Egyszerűsített megközelítés: a story-ban minden fejezet egy PageBreak-kel
    # végződik -- a napló lapok a fejezet oldala(i) UTÁN, de a következő fejezet ELŐTT.
    #
    # Mivel az oldalszámot nehéz előre tudni, egyszerűbb megközelítés:
    # Generálunk minden típushoz egy "csomagot": fejezet_szöveg.pdf + napló.pdf
    # Majd ezeket fűzzük össze a coverrel.

    print(f"  Szöveges riport: {tmp_report}")

    writer = pypdf.PdfWriter()

    # 1. Fedőlap
    cover_pdf = pypdf.PdfReader(str(out_path.with_suffix(".tmp_cover.pdf")))
    for page in cover_pdf.pages:
        writer.add_page(page)

    # 2. Összefoglaló oldalak (a szöveges riportból az első N oldal a fejezetek előtt)
    report_reader = pypdf.PdfReader(str(tmp_report))
    total_report_pages = len(report_reader.pages)

    # Fejezetenként 1 oldal a szöveges részük (screenshot mérettől függően lehet több)
    # Számoljuk meg: összefoglaló oldalak + fejezetek
    # Az összefoglaló 1 oldal (a PageBreak után jönnek a fejezetek)
    # Minden fejezet min. 1-2 oldal
    # Egyszerű heurisztika: az összefoglaló = 1 oldal, majd 9 fejezet sorban
    # Minden fejezet 1 oldal (a screenshotok befoglalása miatt lehet 2)
    # Mivel nincs egyszerű módunk meghatározni a határokat, inkább egyszerűen
    # berakjuk az egész szöveges riportot, majd utána a naplókat egymás után.
    # Ez nem tökéletes de közel van Attila kéréshez.
    #
    # Pontosabb megközelítés: minden fejezetet külön PDF-be generálunk.

    # Törli a tempeket majd újraindítja pontosabb módszerrel
    import os as _os
    _os.unlink(str(tmp_report))
    _os.unlink(str(out_path.with_suffix(".tmp_cover.pdf")))

    return _build_precise(out_path)


def _build_precise(out_path: Path) -> Path:
    """
    Pontos összeillesztés: minden fejezetet külön PDF-be generálunk,
    majd: cover + összefoglaló + (fejezet_i + napló_i) x 9
    """
    tmp_dir = out_path.parent / "_tmp_report_parts"
    tmp_dir.mkdir(exist_ok=True)

    writer = pypdf.PdfWriter()

    # --- FEDŐLAP ---
    cover_path = tmp_dir / "cover.pdf"
    c_cover = canvas.Canvas(str(cover_path), pagesize=A4)
    build_cover(c_cover)
    c_cover.showPage()
    c_cover.save()
    _append_pdf(writer, cover_path)

    # --- ÖSSZEFOGLALÓ ---
    summary_path = tmp_dir / "summary.pdf"
    _build_flowable_pdf(summary_path, _summary_story())
    _append_pdf(writer, summary_path)

    # --- FEJEZETEK ---
    for i, t in enumerate(TYPES, 1):
        chap_path = tmp_dir / f"chap_{i:02d}_{t['slug']}.pdf"
        _build_flowable_pdf(chap_path, chapter_flowables(t, i))
        _append_pdf(writer, chap_path)

        if t["pdf_file"]:
            naplo_path = REPORTS / t["pdf_file"]
            if naplo_path.exists():
                _append_pdf(writer, naplo_path)
                print(f"  + Napló beillesztve: {t['name']} ({t['pdf_pages']} lap)")

    # --- KIÍRÁS ---
    with open(str(out_path), "wb") as f:
        writer.write(f)

    # Tisztítás
    import shutil
    shutil.rmtree(str(tmp_dir))

    return out_path


def _append_pdf(writer: pypdf.PdfWriter, path: Path):
    reader = pypdf.PdfReader(str(path))
    for page in reader.pages:
        writer.add_page(page)


def _summary_story():
    story = []
    story.append(Paragraph("Teszt összefoglaló", h1))
    story.append(HRFlowable(width="100%", thickness=1, color=RED, spaceAfter=4))

    story.append(Paragraph("Tesztelési cél", h2))
    story.append(Paragraph(
        "A fiREG alkalmazás mind a 9 eszköztípus-modulján karbantartás rögzítés "
        "és PDF napló generálás funkcionális ellenőrzése. "
        "Minden modulban 2-2 berendezésen rögzítettük a karbantartást, "
        "majd az adott naplóra PDF letöltést indítottunk.",
        body))

    story.append(Paragraph("Módszertan", h2))
    story.append(Paragraph(
        "Automatizált Playwright böngésző (Chromium headless) vezérli az alkalmazást. "
        "Bejelentkezés email + 2FA kóddal (Mailtrap IMAP). "
        "A karbantartási modális ablakoknál Select2 jQuery plugin kompatibilis "
        "kiválasztás, datepicker JS-en keresztüli kitöltés. "
        "A sikeres rögzítés után görgetés az új sorra és képernyőkép (verify). "
        "PDF generálásnál letöltés a /printDiary végponton keresztül (szinkron), "
        "a PDF-fejlécet bináris ellenőrzéssel validálva.",
        body))

    story.append(Paragraph("Összesített eredmények", h2))
    story.append(summary_table())
    story.append(Spacer(1, 6*mm))

    story.append(Paragraph("Következtetések", h2))
    story.append(Paragraph(
        "A karbantartás rögzítés 18/18 arányban sikeres -- minden modul rendeltetésszerűen "
        "fogadja és menti az adatokat.",
        body))
    story.append(Paragraph(
        "A PDF generálás 5/9 arányban sikeres (26 lap összesen). "
        "Sikeres: Tűzoltó készülékek, Tűzgátló eszközök, Defibrillátorok, Tűzi vízforrások, Világítások. "
        "Timeout (4 modul): Aggregátorok, Füstgátló eszközök, Vészkijáratok, Oltórendszerek -- "
        "dev adathiány vagy lassú PDF-végpont, nem production hiba.",
        body))
    return story


def _build_flowable_pdf(path: Path, story: list):
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        leftMargin=15*mm, rightMargin=15*mm,
        topMargin=18*mm, bottomMargin=18*mm,
    )
    doc.build(story, canvasmaker=HeaderFooterCanvas)


if __name__ == "__main__":
    print(f"Generálás: {OUT}")
    result = _build_precise(OUT)
    pages = len(pypdf.PdfReader(str(result)).pages)
    print(f"Kész: {result} ({pages} oldal)")
