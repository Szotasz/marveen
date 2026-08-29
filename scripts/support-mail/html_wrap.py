#!/usr/bin/env python3
"""Turn a plain-text Hungarian email into lightly formatted HTML.

The owner asked for this on 2026-08-10 ("legjobb az lenne, ha valamilyen
enyhébb html formázást is kapnának a levelek"). Deliberately LIGHT: system fonts, one
accent colour, no images, no logo, no external assets -- an email that still
reads as a personal letter, not a newsletter. Everything is inlined because mail
clients drop <style> blocks.

Conventions it understands, all of which are natural in plain text:
  - blank line          -> paragraph break
  - an ALL-CAPS line    -> section label (bold, letter-spaced)
  - a line starting "- " -> list item
  - a lone token that looks like a key/id (mrv_..., long hex) -> monospace chip
  - bare URLs           -> links (truncated label, full href)

Import `to_html(text)`; `send.py --html-wrap` uses it.
"""
import html
import re

URL = re.compile(r"(https?://[^\s<>\"]+)")
KEYISH = re.compile(r"^[A-Za-z0-9_\-]{16,}$")
FONT = ("-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,"
        "'Helvetica Neue',Arial,sans-serif")
INK = "#22262b"
MUTED = "#6b7280"
ACCENT = "#1f6feb"
CHIP_BG = "#f3f4f6"
CHIP_BORDER = "#e5e7eb"


def _inline(text: str) -> str:
    """Escape, then re-add links. Order matters: escape first, never after."""
    out = html.escape(text, quote=False)

    def link(m):
        href = m.group(1)
        label = href if len(href) <= 58 else href[:55] + "..."
        return (f'<a href="{href}" style="color:{ACCENT};text-decoration:underline">'
                f'{label}</a>')

    return URL.sub(link, out)


def _is_label(line: str) -> bool:
    letters = [c for c in line if c.isalpha()]
    if len(letters) < 3 or len(line) > 60:
        return False
    return all(c.isupper() for c in letters)


def _chip(line: str) -> str:
    return (f'<p style="margin:0 0 16px 0"><code style="display:inline-block;'
            f'padding:9px 13px;background:{CHIP_BG};border:1px solid {CHIP_BORDER};'
            f'border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,'
            f'Consolas,monospace;font-size:14px;color:{INK};word-break:break-all">'
            f'{_inline(line)}</code></p>')


def _label(line: str) -> str:
    return (f'<p style="margin:22px 0 6px 0;font-size:12px;font-weight:700;'
            f'letter-spacing:.07em;color:{MUTED};text-transform:uppercase">'
            f'{_inline(line)}</p>')


def _para(lines) -> str:
    return (f'<p style="margin:0 0 16px 0;color:{INK}">'
            + "<br>".join(_inline(ln) for ln in lines) + "</p>")


def _list(lines) -> str:
    items = "".join(
        f'<li style="margin:0 0 5px 0">{_inline(ln.lstrip()[2:])}</li>' for ln in lines
    )
    return f'<ul style="margin:0 0 16px 0;padding-left:20px;color:{INK}">{items}</ul>'


def _render_block(lines):
    """Render one block. Mixed shapes are normal in real letters: a label with
    its value under it, or a lead-in sentence followed by bullets -- so walk the
    lines and flush runs, instead of demanding the whole block be one shape."""
    out, buf = [], []

    def flush():
        if buf:
            out.append(_para(buf))
            buf.clear()

    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.lstrip().startswith("- "):
            run = []
            while i < len(lines) and lines[i].lstrip().startswith("- "):
                run.append(lines[i])
                i += 1
            flush()
            out.append(_list(run))
            continue
        if KEYISH.match(ln.strip()):
            flush()
            out.append(_chip(ln.strip()))
        elif _is_label(ln):
            flush()
            out.append(_label(ln))
        else:
            buf.append(ln)
        i += 1
    flush()
    return out


def to_html(text: str) -> str:
    parts = []
    for block in re.split(r"\n\s*\n", text.strip("\n")):
        lines = [ln.rstrip() for ln in block.split("\n") if ln.strip()]
        if lines:
            parts.extend(_render_block(lines))

    body = "\n".join(parts)
    return (
        '<div style="margin:0;padding:0;background:#ffffff">'
        f'<div style="max-width:600px;margin:0 auto;padding:8px 4px;'
        f'font-family:{FONT};font-size:15px;line-height:1.62;color:{INK}">'
        f"{body}"
        "</div></div>"
    )


if __name__ == "__main__":
    import sys

    sys.stdout.write(to_html(sys.stdin.read()))
