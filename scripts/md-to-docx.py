#!/usr/bin/env python3
"""Markdown -> .docx, with no third-party package.

    python3 scripts/md-to-docx.py <input.md> <output.docx> [--title "..."]

WHY NOT A LIBRARY: measured on this machine 2026-10-15 -- no pandoc, no
libreoffice, no python-docx, no reportlab, and pip is not installed (only
pipx, which installs applications, not libraries). A .docx is a ZIP holding a
handful of XML parts, so writing those three parts directly is fewer moving
parts than provisioning a toolchain for one document.

WHAT IT COVERS: headings (#, ##, ###), paragraphs with wrapped lines joined,
bullet and numbered lists, **bold** and `code` inline, fenced code blocks, and
pipe tables. Everything else is emitted as plain text rather than silently
dropped.

A NOTE ON THE LIST STYLES: Word needs a numbering definition (numbering.xml)
for real bullets. Rather than ship one, list items are written as ordinary
paragraphs with an indent and a literal bullet or number. The document reads
correctly and opens everywhere, including Word on the web; the trade is that
Word will not renumber a list if someone edits it.
"""
import re
import sys
import zipfile
from xml.sax.saxutils import escape

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

# Heading colours follow the house mail signature: dark blue for the title,
# the link blue for section headings.
STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/><w:sz w:val="22"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr>
<w:rPr><w:b/><w:color w:val="2A2F70"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="320" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:color w:val="1373B9"/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:b/><w:color w:val="2A2F70"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:shd w:val="clear" w:fill="F4F4F4"/><w:spacing w:after="120"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>"""

CORE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>{title}</dc:title><dc:creator>{creator}</dc:creator><cp:lastModifiedBy>{creator}</cp:lastModifiedBy>
</cp:coreProperties>"""

DOC_OPEN = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"""
DOC_CLOSE = """<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>"""


def runs(text):
    """Inline **bold** and `code` to <w:r> runs. Everything else is plain."""
    out = []
    for part in re.split(r'(\*\*.+?\*\*|`[^`]+`)', text, flags=re.S):
        if not part:
            continue
        if part.startswith('**') and part.endswith('**'):
            out.append(f'<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{escape(part[2:-2])}</w:t></w:r>')
        elif part.startswith('`') and part.endswith('`'):
            out.append(
                '<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>'
                f'<w:t xml:space="preserve">{escape(part[1:-1])}</w:t></w:r>'
            )
        else:
            out.append(f'<w:r><w:t xml:space="preserve">{escape(part)}</w:t></w:r>')
    return ''.join(out)


def para(text, style=None, indent=0):
    ppr = ''
    if style or indent:
        ppr = '<w:pPr>'
        if style:
            ppr += f'<w:pStyle w:val="{style}"/>'
        if indent:
            ppr += f'<w:ind w:left="{indent}"/>'
        ppr += '</w:pPr>'
    return f'<w:p>{ppr}{runs(text)}</w:p>'


def code_block(lines):
    # One paragraph per line keeps the block copy-pasteable out of Word.
    return ''.join(para(ln or ' ', style='Code') for ln in lines)


def table(rows):
    """Pipe table to a bordered w:tbl. First row is treated as the header."""
    border = ('<w:tblBorders>' + ''.join(
        f'<w:{e} w:val="single" w:sz="6" w:color="C9C9C9"/>'
        for e in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV')) + '</w:tblBorders>')
    xml = f'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>{border}</w:tblPr>'
    for i, cells in enumerate(rows):
        xml += '<w:tr>'
        for c in cells:
            shade = '<w:shd w:val="clear" w:fill="EEF3F8"/>' if i == 0 else ''
            body = f'<w:p>{runs("**" + c + "**" if i == 0 else c)}</w:p>'
            xml += f'<w:tc><w:tcPr>{shade}</w:tcPr>{body}</w:tc>'
        xml += '</w:tr>'
    return xml + '</w:tbl>' + para('')


def convert(md):
    body, buf, code, tbl = [], [], None, []

    def flush_para():
        if buf:
            body.append(para(' '.join(buf)))
            buf.clear()

    def flush_table():
        if tbl:
            body.append(table(list(tbl)))
            tbl.clear()

    first_heading = True
    for raw in md.split('\n'):
        line = raw.rstrip()
        if line.startswith('```'):
            if code is None:
                flush_para()
                flush_table()
                code = []
            else:
                body.append(code_block(code))
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        if not line.strip():
            flush_para()
            flush_table()
            continue
        if line.startswith('|'):
            flush_para()
            if re.match(r'^\|[\s:\-|]+\|$', line.strip()):
                continue
            tbl.append([c.strip() for c in line.strip().strip('|').split('|')])
            continue
        flush_table()
        if line.startswith('#'):
            flush_para()
            level = len(line) - len(line.lstrip('#'))
            text = line[level:].strip()
            if level == 1 and first_heading:
                body.append(para(text, style='Title'))
                first_heading = False
            else:
                body.append(para(text, style='Heading1' if level <= 2 else 'Heading2'))
            continue
        m = re.match(r'^(\s*)([-*]|\d+\.)\s+(.*)$', line)
        if m:
            flush_para()
            bullet = '\u2022' if m.group(2) in ('-', '*') else m.group(2)
            body.append(para(f'{bullet} {m.group(3)}', indent=360 + len(m.group(1)) * 180))
            continue
        buf.append(line.strip())
    flush_para()
    flush_table()
    if code:
        body.append(code_block(code))
    return ''.join(body)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    title = sys.argv[sys.argv.index('--title') + 1] if '--title' in sys.argv else ''
    md = open(src, encoding='utf-8').read()
    if not title:
        first = next((l for l in md.split('\n') if l.startswith('# ')), '# Dokumentum')
        title = first[2:].strip()
    document = DOC_OPEN + convert(md) + DOC_CLOSE
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('docProps/core.xml', CORE.format(title=escape(title), creator='Elod'))
        z.writestr('word/_rels/document.xml.rels', DOC_RELS)
        z.writestr('word/styles.xml', STYLES)
        z.writestr('word/document.xml', document)
    print(f'OK {dst} ({len(document)} karakter XML)')


if __name__ == '__main__':
    main()
