#!/usr/bin/env python3
"""Reader for legacy binary Excel workbooks (.xls, BIFF5/BIFF7/BIFF8).

Why it is written by hand: measured 2026-09-22, this machine has no xlrd, pandas or
libreoffice, and PyPI is behind the egress gate. Excel COM automation from WSL was
measured the same morning and rejected: it worked once, then returned RPC_E_CALL_REJECTED
repeatedly and left Excel processes behind, which made the NEXT run look like a failure.
An unattended agent must not depend on that. A .xls is an OLE2 compound file holding a
BIFF record stream, both of which the standard library can walk.

Scope, stated plainly so nobody assumes more than was measured:
  - reads values, not formatting: cell text, numbers, dates, booleans, errors, and the
    CACHED result of formulas (the value Excel last computed and stored). Formulas are
    not evaluated.
  - BIFF8 (Excel 97-2003) and BIFF5/7 (Excel 5.0/95) are handled. BIFF2/3/4 (Excel 4 and
    older, not an OLE2 container) are refused by name rather than guessed at.
  - encrypted workbooks are refused, not silently returned empty.

Entry point: read_workbook(path, sheet=None, include_hidden=False)
             -> {sheet_name: [[cell_text, ...], ...]}, the same shape as xlsx.py.
"""
import datetime as dt
import re
import struct

# --- OLE2 / Compound File Binary Format -------------------------------------------------

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
MAXREGSECT = 0xFFFFFFFA
DIFSECT, FATSECT, ENDOFCHAIN, FREESECT = 0xFFFFFFFC, 0xFFFFFFFD, 0xFFFFFFFE, 0xFFFFFFFF


class BiffError(RuntimeError):
    pass


class _Ole:
    """Just enough of the compound file format to pull one named stream out."""

    def __init__(self, data):
        if data[:8] != OLE_MAGIC:
            raise BiffError("nem OLE2 allomany (a .xls fejlece hianyzik)")
        self.data = data
        self.sector_size = 1 << struct.unpack_from("<H", data, 30)[0]
        self.mini_sector_size = 1 << struct.unpack_from("<H", data, 32)[0]
        num_fat = struct.unpack_from("<I", data, 44)[0]
        first_dir = struct.unpack_from("<I", data, 48)[0]
        self.mini_cutoff = struct.unpack_from("<I", data, 56)[0]
        first_mini_fat = struct.unpack_from("<I", data, 60)[0]
        num_mini_fat = struct.unpack_from("<I", data, 64)[0]
        first_difat = struct.unpack_from("<I", data, 68)[0]
        num_difat = struct.unpack_from("<I", data, 72)[0]

        difat = list(struct.unpack_from("<109I", data, 76))
        sect, guard = first_difat, 0
        per_sector = self.sector_size // 4
        while sect <= MAXREGSECT and guard <= num_difat + 1:
            blk = self._sector(sect)
            difat.extend(struct.unpack_from("<%dI" % (per_sector - 1), blk, 0))
            sect = struct.unpack_from("<I", blk, (per_sector - 1) * 4)[0]
            guard += 1
        difat = [s for s in difat[: max(num_fat, 0) or len(difat)] if s <= MAXREGSECT]

        self.fat = []
        for s in difat:
            self.fat.extend(struct.unpack_from("<%dI" % per_sector, self._sector(s)))

        self.mini_fat = []
        if num_mini_fat:
            raw = self._chain_bytes(first_mini_fat, self.fat)
            self.mini_fat = list(struct.unpack_from("<%dI" % (len(raw) // 4), raw))

        self.entries = self._directory(first_dir)
        root = self.entries[0] if self.entries else None
        self.mini_stream = b""
        if root and root["start"] <= MAXREGSECT:
            self.mini_stream = self._chain_bytes(root["start"], self.fat)[: root["size"]]

    def _sector(self, sect):
        # The header occupies the first sector, so payload sector n starts one sector in.
        off = (sect + 1) * self.sector_size
        blk = self.data[off : off + self.sector_size]
        if len(blk) < self.sector_size:
            blk = blk + b"\x00" * (self.sector_size - len(blk))
        return blk

    def _chain_bytes(self, start, fat, mini=False):
        out = bytearray()
        sect, seen = start, set()
        while sect <= MAXREGSECT:
            if sect in seen:  # a corrupt file must not become an infinite loop
                raise BiffError("serult OLE lanc (onmagaba visszatero szektor)")
            seen.add(sect)
            if mini:
                off = sect * self.mini_sector_size
                out += self.mini_stream[off : off + self.mini_sector_size]
            else:
                out += self._sector(sect)
            if sect >= len(fat):
                break
            sect = fat[sect]
        return bytes(out)

    def _directory(self, first_dir):
        raw = self._chain_bytes(first_dir, self.fat)
        entries = []
        for off in range(0, len(raw) - 127, 128):
            e = raw[off : off + 128]
            name_len = struct.unpack_from("<H", e, 64)[0]
            obj_type = e[66]
            if obj_type == 0:
                continue
            name = e[: max(name_len - 2, 0)].decode("utf-16-le", "replace")
            entries.append(
                {
                    "name": name,
                    "type": obj_type,
                    "start": struct.unpack_from("<I", e, 116)[0],
                    "size": struct.unpack_from("<Q", e, 120)[0],
                }
            )
        return entries

    def stream_names(self):
        return [e["name"] for e in self.entries if e["type"] == 2]

    def open_stream(self, name):
        for e in self.entries:
            if e["type"] == 2 and e["name"].lower() == name.lower():
                if e["size"] < self.mini_cutoff:
                    return self._chain_bytes(e["start"], self.mini_fat, mini=True)[: e["size"]]
                return self._chain_bytes(e["start"], self.fat)[: e["size"]]
        return None


# --- BIFF records -----------------------------------------------------------------------

BOF, EOF_R, CONTINUE = 0x0809, 0x000A, 0x003C
BOUNDSHEET, SST, EXTSST = 0x0085, 0x00FC, 0x00FF
LABELSST, LABEL, RSTRING = 0x00FD, 0x0204, 0x00D6
RK, MULRK, NUMBER = 0x027E, 0x00BD, 0x0203
FORMULA, STRING_R, BOOLERR = 0x0006, 0x0207, 0x0205
BLANK, MULBLANK = 0x0201, 0x00BE
FORMAT, FORMAT_OLD, XF, XF_OLD = 0x041E, 0x001E, 0x00E0, 0x0043
DATEMODE, CODEPAGE, FILEPASS = 0x0022, 0x0042, 0x002F

BUILTIN_DATE_IDS = set(range(14, 23)) | set(range(45, 48)) | {27, 30, 36, 50, 57}

ERROR_TEXT = {
    0x00: "#NULL!", 0x07: "#DIV/0!", 0x0F: "#VALUE!", 0x17: "#REF!",
    0x1D: "#NAME?", 0x24: "#NUM!", 0x2A: "#N/A",
}


def _a1(row, col):
    letters = ""
    n = col + 1
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return "%s%d" % (letters, row + 1)


def _records(data, pos=0):
    """Yield (opcode, payload, next_pos). The stream is a flat run of length-prefixed records."""
    n = len(data)
    while pos + 4 <= n:
        opcode, length = struct.unpack_from("<HH", data, pos)
        payload = data[pos + 4 : pos + 4 + length]
        pos += 4 + length
        yield opcode, payload, pos


def _rk_value(raw):
    """Decode Excel's packed 30-bit number. Two orthogonal flags, both easy to drop."""
    as_int = struct.unpack("<i", raw)[0]
    as_uint = struct.unpack("<I", raw)[0]
    if as_uint & 0x02:
        value = float(as_int >> 2)  # arithmetic shift keeps the sign
    else:
        value = struct.unpack("<d", b"\x00\x00\x00\x00" + struct.pack("<I", as_uint & 0xFFFFFFFC))[0]
    if as_uint & 0x01:
        value /= 100.0
    return value


def _fmt_is_date(fmt):
    """True if a number-format string renders its value as a date or a time.

    Literal text is the trap: `0" nap"` contains a 'd'-like letter inside quotes and must
    not count, while `[h]:mm` is an elapsed-time code that must.
    """
    out, i, in_quote = [], 0, False
    while i < len(fmt):
        ch = fmt[i]
        if ch == '"':
            in_quote = not in_quote
            i += 1
            continue
        if in_quote:
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch == "[":
            end = fmt.find("]", i)
            if end < 0:
                break
            inner = fmt[i + 1 : end]
            if inner and all(c.lower() in "hms" for c in inner):
                out.append(inner)  # elapsed time, e.g. [h]:mm
            i = end + 1
            continue
        out.append(ch)
        i += 1
    body = re.sub(r"(?i)general", "", "".join(out))
    body = re.sub(r"(?i)am/pm|a/p", "h", body)
    return any(c in "ymdhsYMDHS" for c in body)


class _StringBlocks:
    """A cursor over an SST record plus its CONTINUE records.

    The awkward part of BIFF8: when a string's character data runs past the end of a
    record, the next record starts with a FRESH option-flag byte, and the encoding can
    flip from compressed to UTF-16 mid-string. A reader that just concatenates the
    payloads gets one stray character per boundary and silently corrupts long text.
    """

    def __init__(self, blocks):
        self.blocks = [b for b in blocks if b]
        self.bi = 0
        self.off = 0

    def read(self, n):
        out = bytearray()
        while n > 0:
            if self.bi >= len(self.blocks):
                raise BiffError("csonka SST rekord")
            blk = self.blocks[self.bi]
            if self.off >= len(blk):
                self.bi += 1
                self.off = 0
                continue
            take = min(n, len(blk) - self.off)
            out += blk[self.off : self.off + take]
            self.off += take
            n -= take
        return bytes(out)

    def exhausted(self):
        bi, off = self.bi, self.off
        while bi < len(self.blocks) and off >= len(self.blocks[bi]):
            bi += 1
            off = 0
        return bi >= len(self.blocks)

    def read_chars(self, cch, high_byte):
        parts = []
        while cch > 0:
            if self.bi >= len(self.blocks):
                raise BiffError("csonka szoveg az SST-ben")
            blk = self.blocks[self.bi]
            if self.off >= len(blk):
                self.bi += 1
                self.off = 0
                if self.bi >= len(self.blocks):
                    raise BiffError("csonka szoveg az SST-ben")
                high_byte = self.blocks[self.bi][0] & 0x01
                self.off = 1
                continue
            avail = len(blk) - self.off
            if high_byte:
                take = min(cch, avail // 2)
                if take == 0:
                    self.off = len(blk)
                    continue
                parts.append(blk[self.off : self.off + take * 2].decode("utf-16-le", "replace"))
                self.off += take * 2
            else:
                take = min(cch, avail)
                parts.append(blk[self.off : self.off + take].decode("latin-1"))
                self.off += take
            cch -= take
        return "".join(parts)


def _parse_sst(blocks):
    r = _StringBlocks(blocks)
    r.read(4)  # total string count, including duplicates: not needed
    unique = struct.unpack("<I", r.read(4))[0]
    out = []
    for _ in range(unique):
        if r.exhausted():
            break
        cch = struct.unpack("<H", r.read(2))[0]
        grbit = r.read(1)[0]
        rich_runs = struct.unpack("<H", r.read(2))[0] if grbit & 0x08 else 0
        ext_bytes = struct.unpack("<I", r.read(4))[0] if grbit & 0x04 else 0
        out.append(r.read_chars(cch, grbit & 0x01))
        if rich_runs:
            r.read(4 * rich_runs)
        if ext_bytes:
            r.read(ext_bytes)
    return out


def _unicode_string(payload, pos, len_size=2):
    """BIFF8 XLUnicodeString inside a single record. Returns (text, next_pos)."""
    if len_size == 2:
        cch = struct.unpack_from("<H", payload, pos)[0]
        pos += 2
    else:
        cch = payload[pos]
        pos += 1
    grbit = payload[pos]
    pos += 1
    rich_runs = 0
    ext_bytes = 0
    if grbit & 0x08:
        rich_runs = struct.unpack_from("<H", payload, pos)[0]
        pos += 2
    if grbit & 0x04:
        ext_bytes = struct.unpack_from("<I", payload, pos)[0]
        pos += 4
    if grbit & 0x01:
        text = payload[pos : pos + cch * 2].decode("utf-16-le", "replace")
        pos += cch * 2
    else:
        text = payload[pos : pos + cch].decode("latin-1")
        pos += cch
    pos += 4 * rich_runs + ext_bytes
    return text, pos


def _byte_string(payload, pos, encoding, len_size=1):
    """BIFF5 byte-counted string in the workbook's code page."""
    if len_size == 2:
        cch = struct.unpack_from("<H", payload, pos)[0]
        pos += 2
    else:
        cch = payload[pos]
        pos += 1
    text = payload[pos : pos + cch].decode(encoding, "replace")
    return text, pos + cch


# --- workbook ---------------------------------------------------------------------------

class _Workbook:
    def __init__(self, stream):
        self.stream = stream
        self.biff = 0
        self.encoding = "cp1252"
        self.sst = []
        self.xf_formats = []      # ixfe -> ifmt
        self.formats = {}         # ifmt -> format string
        self.date_offset = 0      # 1462 days when the file uses the 1904 date system
        self.sheets = []          # (name, stream position, hidden)
        self.warnings = []        # things the caller must not discover by being surprised

    # -- globals --------------------------------------------------------------------
    def read_globals(self):
        data = self.stream
        it = _records(data, 0)
        try:
            opcode, payload, _ = next(it)
        except StopIteration:
            raise BiffError("ures munkafuzet-adatfolyam")
        if opcode != BOF:
            raise BiffError("a munkafuzet nem BOF rekorddal kezdodik")
        self.biff = struct.unpack_from("<H", payload, 0)[0] if len(payload) >= 2 else 0
        if self.biff not in (0x0600, 0x0500, 0x0200, 0x0300, 0x0400):
            self.biff = 0x0600  # unknown but OLE2-framed: treat as BIFF8 and let it fail loudly
        pending_sst = None
        for opcode, payload, pos in it:
            if opcode == EOF_R:
                break
            if opcode == FILEPASS:
                raise BiffError(
                    "a munkafuzet jelszoval vedett. Kerd el titkositas nelkul; a tartalmat "
                    "kitalalni nem lehet."
                )
            if pending_sst is not None and opcode == CONTINUE:
                pending_sst.append(payload)
                continue
            if pending_sst is not None:
                self.sst = _parse_sst(pending_sst)
                pending_sst = None
            if opcode == CODEPAGE and len(payload) >= 2:
                cp = struct.unpack_from("<H", payload, 0)[0]
                self.encoding = "utf-16-le" if cp == 1200 else "cp%d" % cp
                try:
                    "x".encode(self.encoding)
                except LookupError:
                    self.encoding = "cp1252"
            elif opcode == DATEMODE and len(payload) >= 2:
                if struct.unpack_from("<H", payload, 0)[0]:
                    self.date_offset = 1462
            elif opcode == BOUNDSHEET:
                self._boundsheet(payload)
            elif opcode in (XF, XF_OLD) and len(payload) >= 4:
                self.xf_formats.append(struct.unpack_from("<H", payload, 2)[0])
            elif opcode in (FORMAT, FORMAT_OLD) and len(payload) >= 3:
                ifmt = struct.unpack_from("<H", payload, 0)[0]
                if self.biff >= 0x0600:
                    text, _ = _unicode_string(payload, 2, len_size=2)
                else:
                    text, _ = _byte_string(payload, 2, self.encoding, len_size=1)
                self.formats[ifmt] = text
            elif opcode == SST:
                pending_sst = [payload]
        if pending_sst is not None:
            self.sst = _parse_sst(pending_sst)

    def _boundsheet(self, payload):
        if len(payload) < 6:
            return
        start = struct.unpack_from("<I", payload, 0)[0]
        hidden = payload[4] & 0x03
        sheet_type = payload[5]
        if self.biff >= 0x0600:
            name, _ = _unicode_string(payload, 6, len_size=1)
        else:
            name, _ = _byte_string(payload, 6, self.encoding, len_size=1)
        if sheet_type == 0:  # 0 = worksheet; charts and macro sheets hold no cell grid
            self.sheets.append((name, start, hidden))

    def is_date_xf(self, ixfe):
        if ixfe >= len(self.xf_formats):
            return False
        ifmt = self.xf_formats[ixfe]
        if ifmt in self.formats:
            return _fmt_is_date(self.formats[ifmt])
        return ifmt in BUILTIN_DATE_IDS

    # -- one sheet ------------------------------------------------------------------
    def read_sheet(self, start):
        cells = {}
        truncated = []
        max_row = max_col = -1
        pending_formula = None  # (row, col) whose text result arrives in the next record
        pending_string = None

        def put(row, col, text):
            nonlocal max_row, max_col
            cells[(row, col)] = text
            if row > max_row:
                max_row = row
            if col > max_col:
                max_col = col

        for opcode, payload, _pos in _records(self.stream, start):
            if opcode == EOF_R:
                break
            if opcode == BOF and _pos != start + 4 + len(payload):
                pass

            if pending_string is not None and opcode == CONTINUE:
                pending_string.append(payload)
                continue
            if pending_string is not None:
                row, col, blocks = pending_formula[0], pending_formula[1], pending_string
                put(row, col, _parse_string_record(blocks, self.biff, self.encoding))
                pending_string = None
                pending_formula = None

            if opcode == LABELSST and len(payload) >= 10:
                row, col, _ixfe, isst = struct.unpack_from("<HHHI", payload, 0)
                put(row, col, self.sst[isst] if isst < len(self.sst) else "")
            elif opcode in (LABEL, RSTRING) and len(payload) >= 6:
                row, col = struct.unpack_from("<HH", payload, 0)
                if self.biff >= 0x0600:
                    text, _ = _unicode_string(payload, 6, len_size=2)
                else:
                    text, _ = _byte_string(payload, 6, self.encoding, len_size=2)
                    # BIFF5 cannot store more than 255 characters in a cell, so Excel cut
                    # the text when it wrote this file. Measured 2026-09-22: a 28 000
                    # character cell came back as exactly 255. The reader cannot recover
                    # what is not in the file; it can refuse to hand it over as complete.
                    if len(text) == 255:
                        truncated.append((row, col))
                put(row, col, text)
            elif opcode == RK and len(payload) >= 10:
                row, col, ixfe = struct.unpack_from("<HHH", payload, 0)
                put(row, col, self._number_text(_rk_value(payload[6:10]), ixfe))
            elif opcode == MULRK and len(payload) >= 6:
                row, first = struct.unpack_from("<HH", payload, 0)
                count = (len(payload) - 6) // 6
                for i in range(count):
                    off = 4 + i * 6
                    ixfe = struct.unpack_from("<H", payload, off)[0]
                    put(row, first + i, self._number_text(_rk_value(payload[off + 2 : off + 6]), ixfe))
            elif opcode == NUMBER and len(payload) >= 14:
                row, col, ixfe = struct.unpack_from("<HHH", payload, 0)
                value = struct.unpack_from("<d", payload, 6)[0]
                put(row, col, self._number_text(value, ixfe))
            elif opcode == BOOLERR and len(payload) >= 8:
                row, col, _ixfe = struct.unpack_from("<HHH", payload, 0)
                value, is_error = payload[6], payload[7]
                put(row, col, ERROR_TEXT.get(value, "#ERR") if is_error else ("IGAZ" if value else "HAMIS"))
            elif opcode == BLANK and len(payload) >= 6:
                row, col = struct.unpack_from("<HH", payload, 0)
                put(row, col, "")
            elif opcode == MULBLANK and len(payload) >= 6:
                row, first = struct.unpack_from("<HH", payload, 0)
                for i in range((len(payload) - 6) // 2):
                    put(row, first + i, "")
            elif opcode == FORMULA and len(payload) >= 16:
                row, col, ixfe = struct.unpack_from("<HHH", payload, 0)
                result = payload[6:14]
                if result[6] == 0xFF and result[7] == 0xFF:
                    kind = result[0]
                    if kind == 0:  # a string result lives in the next STRING record
                        pending_formula = (row, col)
                        pending_string = None
                        put(row, col, "")
                    elif kind == 1:
                        put(row, col, "IGAZ" if result[2] else "HAMIS")
                    elif kind == 2:
                        put(row, col, ERROR_TEXT.get(result[2], "#ERR"))
                    else:
                        put(row, col, "")
                else:
                    put(row, col, self._number_text(struct.unpack("<d", result)[0], ixfe))
            elif opcode == STRING_R and pending_formula is not None:
                pending_string = [payload]

        if pending_string is not None and pending_formula is not None:
            put(pending_formula[0], pending_formula[1],
                _parse_string_record(pending_string, self.biff, self.encoding))

        if truncated:
            self.warnings.append(
                "%d cella pontosan 255 karakter hosszu. A BIFF5 (Excel 5.0/95) formatum ennel "
                "tobbet nem tud tarolni egy cellaban, tehat a szoveg MAR A FAJLBAN csonka. "
                "Ha a teljes tartalom kell, .xlsx-ben kerd el. Elso elofordulas: %s"
                % (len(truncated), _a1(truncated[0][0], truncated[0][1]))
            )
        if max_row < 0:
            return []
        rows = []
        for r in range(max_row + 1):
            rows.append([cells.get((r, c), "") for c in range(max_col + 1)])
        while rows and not any(c.strip() for c in rows[-1]):
            rows.pop()
        return rows

    def _number_text(self, value, ixfe):
        if self.is_date_xf(ixfe):
            return _serial_to_text(value + self.date_offset)
        return _num_to_text(value)


def _parse_string_record(blocks, biff, encoding):
    """The STRING record that carries a formula's text result (plus any CONTINUE)."""
    if biff < 0x0600:
        payload = b"".join(blocks)
        text, _ = _byte_string(payload, 0, encoding, len_size=2)
        return text
    r = _StringBlocks(blocks)
    cch = struct.unpack("<H", r.read(2))[0]
    grbit = r.read(1)[0]
    return r.read_chars(cch, grbit & 0x01)


def _serial_to_text(days):
    """Excel stores dates as days since 1899-12-30. Kept byte-for-byte in step with xlsx.py."""
    try:
        days = float(days)
    except (TypeError, ValueError):
        return str(days)
    base = dt.datetime(1899, 12, 30)
    try:
        stamp = base + dt.timedelta(days=days)
    except OverflowError:
        return _num_to_text(days)
    if days < 1:
        return stamp.strftime("%H:%M:%S")
    if abs(days - int(days)) < 1e-9:
        return stamp.strftime("%Y-%m-%d")
    return stamp.strftime("%Y-%m-%d %H:%M:%S")


def _num_to_text(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "" if value is None else str(value)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return repr(f)


def read_workbook(path, sheet=None, include_hidden=False, warnings=None):
    """Return {sheet_name: [[cell_text, ...], ...]}; same contract as xlsx.read_workbook.

    `warnings`, if a list is passed in, collects anything the caller would otherwise only
    notice by being wrong later: text the format itself truncated, sheets left out because
    they are hidden.
    """
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except FileNotFoundError:
        raise BiffError("nincs ilyen fajl: %s" % path)
    if data[:2] in (b"\x09\x00", b"\x09\x02", b"\x09\x04", b"\x09\x08") and data[:8] != OLE_MAGIC:
        raise BiffError(
            "ez BIFF2/3/4 munkafuzet (Excel 4.0 vagy regebbi), amit ez az olvaso nem kezel. "
            "Kerd el .xlsx-ben."
        )
    if data[:8] != OLE_MAGIC:
        raise BiffError(
            "ez a fajl nem binaris .xls. Ha .xlsx-bol lett atnevezve, az nem konvertalas."
        )
    ole = _Ole(data)
    stream = ole.open_stream("Workbook") or ole.open_stream("Book")
    if stream is None:
        names = ", ".join(ole.stream_names()) or "(egy sem)"
        raise BiffError(
            "OLE2 allomany, de nincs benne Workbook/Book adatfolyam, tehat nem Excel "
            "munkafuzet. Adatfolyamok: %s" % names
        )
    wb = _Workbook(stream)
    wb.read_globals()
    names = [s[0] for s in wb.sheets]
    if sheet is not None and sheet not in names:
        raise BiffError("nincs ilyen lap: %s. A munkafuzet lapjai: %s" % (sheet, ", ".join(names)))
    out = {}
    skipped = []
    for name, start, hidden in wb.sheets:
        if sheet is not None and name != sheet:
            continue
        if hidden and not include_hidden and sheet is None:
            skipped.append(name)
            continue
        out[name] = wb.read_sheet(start)
    if skipped and warnings is not None:
        warnings.append(
            "%d rejtett lap kimaradt (%s). Az --include-hidden kapcsoloval bejon."
            % (len(skipped), ", ".join(skipped))
        )
    if warnings is not None:
        warnings.extend(wb.warnings)
    return out


if __name__ == "__main__":
    import json
    import sys

    notes = []
    book = read_workbook(sys.argv[1], sheet=sys.argv[2] if len(sys.argv) > 2 else None,
                         warnings=notes)
    for note in notes:
        print("FIGYELEM: " + note, file=sys.stderr)
    print(json.dumps(book, ensure_ascii=False, indent=2))
