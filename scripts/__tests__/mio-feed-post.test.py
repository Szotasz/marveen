#!/usr/bin/env python3
"""MIOFEEDATTACH1014: scripts/mio-feed-post.py, the JSON path pinned and the --attach path.

No live API, no vault, no real key: urlopen and vault() are replaced on the loaded module,
and every request the script would send is recorded instead.

  - WITHOUT --attach the request is byte for byte the old JSON request: same URL, method,
    body bytes, headers and timeout, and the same exit codes (0, 1, 2, 3, 4, 5). These cases
    also pass against the script before this change (MIO_FEED_POST=<old copy>).
  - WITH --attach: a .md file only, at most ATTACH_MAX_BYTES, valid UTF-8, not empty; its name
    and content pass the same content gates as the body (dash, non-Latin character, agent
    name), but not the length gate. Every refusal happens locally: no vault read, no request.
  - Without --confirm the run stops (3) and names the file, its size in bytes and its sha256.
  - With --confirm the request is multipart/form-data: the three post fields and ONE "file"
    part carrying exactly the file's bytes.
  - MIOFEEDZIP1016: a .zip also goes (application/zip). Its NAME passes the text gates, its
    content only the structural gates (PK magic, entry count, uncompressed size, ratio, no
    absolute / .. / backslash path, no symlink, no encrypted entry, the per-entry ratio, every local
    header name equal to the directory's, one end record); it is never extracted.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import contextlib
import email
import email.policy
import hashlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.environ.get("MIO_FEED_POST") or os.path.join(os.path.dirname(HERE), "mio-feed-post.py")
CHANNEL = "11111111-2222-4333-8444-555555555555"
KEY = "mrv_EXAMPLE_not_a_key"

failed = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failed.append(name)


def load():
    spec = importlib.util.spec_from_file_location("mio_feed_post_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Resp:
    def __init__(self, status=201, body=b'{"status":"published"}'):
        self.status, self._body = status, body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run(args, key=KEY, http_error=None):
    """main() with sys.argv = args; returns (rc, stdout, stderr, requests, vault_calls)."""
    mod = load()
    sent, vault_calls = [], []

    def fake_urlopen(req, timeout=None):
        sent.append({"url": req.full_url, "method": req.get_method(), "data": req.data,
                     "headers": dict(req.header_items()), "timeout": timeout})
        if http_error:
            raise urllib.error.HTTPError(req.full_url, http_error, "err", {}, io.BytesIO(b'{"error":"x"}'))
        return Resp()

    def fake_vault(name):
        vault_calls.append(name)
        return key

    mod.urllib.request.urlopen = fake_urlopen
    mod.vault = fake_vault
    out, err = io.StringIO(), io.StringIO()
    old_argv = sys.argv
    sys.argv = ["mio-feed-post.py"] + args
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mod.main()
    finally:
        sys.argv = old_argv
    return rc, out.getvalue(), err.getvalue(), sent, vault_calls


tmp = tempfile.mkdtemp(prefix="mio-feed-post-test-")


def fpath(name, data):
    p = os.path.join(tmp, name)
    with open(p, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    return p


TITLE = fpath("cim.txt", "Teszt cím\n")
BODY = fpath("torzs.txt", "Árvíztűrő tükörfúrógép, egy rövid próbaszöveg.\n")
BAD_BODY = fpath("rossz.txt", "Egy gondolatjel \u2014 itt.\n")

# ---------------------------------------------------------------------------
# 1. The JSON path, byte for byte (green on the old script too)
# ---------------------------------------------------------------------------
EXPECTED_JSON = (b'{"channel_id": "11111111-2222-4333-8444-555555555555", "title": "Teszt c\\u00edm", '
                 b'"content": "\\u00c1rv\\u00edzt\\u0171r\\u0151 t\\u00fck\\u00f6rf\\u00far\\u00f3g\\u00e9p, '
                 b'egy r\\u00f6vid pr\\u00f3basz\\u00f6veg."}')

rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY])
check("json: no --confirm -> exit 3", rc == 3)
check("json: no --confirm -> no request, no vault read", sent == [] and vc == [])
check("json: no --confirm -> stderr is exactly the old two lines",
      err == "kapu OK (cim 9, torzs 46 karakter)\n"
             "STOP: a kozzetetel VISSZAVONHATATLAN. Add hozza a --confirm kapcsolot.\n")

rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--confirm"])
check("json: --confirm -> exit 0", rc == 0)
check("json: exactly one request", len(sent) == 1)
r = sent[0] if sent else {}
check("json: URL and method", r.get("url") == "https://api.marveen.io/agent/v1/feed/posts"
      and r.get("method") == "POST")
check("json: body bytes unchanged", r.get("data") == EXPECTED_JSON)
check("json: headers unchanged", r.get("headers") == {"Authorization": f"Bearer {KEY}",
                                                      "Content-type": "application/json"})
check("json: timeout 30", r.get("timeout") == 30)
check("json: the key comes from MARVEEN_IO_API_KULCS", vc == ["MARVEEN_IO_API_KULCS"])
check("json: stdout is the status and the answer", out == 'HTTP 201\n{"status":"published"}\n')

rc, out, err, sent, vc = run([CHANNEL, TITLE, BAD_BODY, "--confirm"])
check("json: a body gate failure -> exit 1, nothing sent", rc == 1 and sent == [] and vc == [])
rc, *_ , sent, vc = run(["nem-uuid", TITLE, BODY, "--confirm"])
check("json: bad channel uuid -> exit 2", rc == 2 and sent == [])
rc, *_ , sent, vc = run([CHANNEL, TITLE])
check("json: too few arguments -> exit 2", rc == 2 and sent == [])
rc, *_ , sent, vc = run([CHANNEL, TITLE, BODY, "--confirm"], key="")
check("json: no key in the vault -> exit 4, nothing sent", rc == 4 and sent == [])
rc, out, *_ = run([CHANNEL, TITLE, BODY, "--confirm"], http_error=422)
check("json: an HTTP error -> exit 5", rc == 5 and out.startswith("HTTP 422\n"))

# Everything below is the new path; against the old script it fails by design.
if os.environ.get("MIO_FEED_POST_JSON_ONLY") == "1":
    print("(JSON_ONLY: the --attach cases are skipped)")
    sys.exit(1 if failed else 0)

# ---------------------------------------------------------------------------
# 2. --attach: local refusals (exit 1, no vault read, no request)
# ---------------------------------------------------------------------------
MD = "# Leírás\n\nEgy rövid, csatolható fájl.\n"
GOOD = fpath("leiras.md", MD)


def refused(label, path, needle):
    rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", path, "--confirm"])
    check(f"attach refused ({label}) -> exit 1, no vault read, no request",
          rc == 1 and sent == [] and vc == [])
    check(f"attach refused ({label}) -> names the reason", needle in err)


refused("not .md", fpath("leiras.txt", MD), "csak .md vagy .zip fajl csatolhato")
refused(".mdx is not .md", fpath("leiras.mdx", MD), "csak .md vagy .zip fajl csatolhato")
refused("over the cap", fpath("nagy.md", b"a" * 1_000_001), "1000001 bajt, a plafon 1000000")
refused("not UTF-8", fpath("bin.md", b"# x\n\xff\xfe\x00"), "nem ervenyes UTF-8")
refused("empty", fpath("ures.md", b"  \n"), "ures csatolmany")
refused("missing file", os.path.join(tmp, "nincs.md"), "nem olvashato")
refused("dash in the content", fpath("jel.md", "Egy sor \u2013 benne.\n"), "csatolmany: gondolatjel (U+2013)")
refused("dash entity in the content", fpath("ent.md", "Egy &mdash; entitas.\n"), "csatolmany: gondolatjel-entitas")
refused("non-Latin character in the content", fpath("nyil.md", "A \u2192 B\n"), "csatolmany: nem-latin karakter: U+2192")
refused("agent name in the content", fpath("nev.md", "Ezt Samu irta.\n"), "csatolmany: agens-nev a szovegben: Samu")
refused("agent name in the file name", fpath("Geri-jegyzet.md", MD), "csatolmany: agens-nev a szovegben: Geri")
refused("quote in the file name", fpath('a"b.md', MD), "idezojel vagy sortores")

rc, out, err, sent, vc = run([CHANNEL, TITLE, BAD_BODY, "--attach", GOOD, "--confirm"])
check("attach: the body gates still run first -> exit 1, nothing sent", rc == 1 and sent == [] and vc == [])
rc, *_ , sent, vc = run([CHANNEL, TITLE, BODY, "--attach"])
check("attach: --attach without a file -> exit 2", rc == 2 and sent == [])
rc, *_ , sent, vc = run([CHANNEL, TITLE, BODY, "--attach", "--confirm"])
check("attach: --attach followed by a flag -> exit 2", rc == 2 and sent == [])

# ---------------------------------------------------------------------------
# 3. --attach without --confirm: name, size, sha256; the limits are the right ones
# ---------------------------------------------------------------------------
raw = MD.encode("utf-8")
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", GOOD])
check("attach: no --confirm -> exit 3, no vault read, no request", rc == 3 and sent == [] and vc == [])
check("attach: no --confirm -> names the file, its bytes and its sha256",
      f"csatolmany OK: leiras.md, {len(raw)} bajt, sha256 {hashlib.sha256(raw).hexdigest()}" in err)

rc, *_ , sent, vc = run([CHANNEL, TITLE, BODY, "--attach", fpath("plafon.md", b"a" * 1_000_000)])
check("attach: exactly at the cap passes the local check", rc == 3)
rc, *_ = run([CHANNEL, TITLE, BODY, "--attach", fpath("hosszu.md", "a" * 25_000)])
check("attach: no length gate on the attachment (25 000 characters pass)", rc == 3)
rc, *_ = run([CHANNEL, TITLE, BODY, "--attach", fpath("Ekezet.MD", "Árvíz.\n")])
check("attach: the .md check ignores case, Hungarian accents pass", rc == 3)

# ---------------------------------------------------------------------------
# 4. --attach with --confirm: the multipart request
# ---------------------------------------------------------------------------
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", GOOD, "--confirm"])
check("attach: --confirm -> exit 0, one request", rc == 0 and len(sent) == 1)
r = sent[0] if sent else {"headers": {}, "data": b""}
check("attach: same URL and method", r.get("url") == "https://api.marveen.io/agent/v1/feed/posts"
      and r.get("method") == "POST")
ctype = r["headers"].get("Content-type", "")
check("attach: multipart/form-data with a boundary", ctype.startswith("multipart/form-data; boundary="))
check("attach: the bearer key, nothing else added",
      set(r["headers"]) == {"Authorization", "Content-type"} and r["headers"].get("Authorization") == f"Bearer {KEY}")
check("attach: timeout 30", r.get("timeout") == 30)
msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + (r.get("data") or b""),
                               policy=email.policy.HTTP)
parts = list(msg.iter_parts()) if msg.is_multipart() else []
fields = {p.get_param("name", header="content-disposition"): p for p in parts}
check("attach: exactly four parts, named channel_id, title, content, file",
      [p.get_param("name", header="content-disposition") for p in parts] == ["channel_id", "title", "content", "file"])
text = lambda n: fields[n].get_payload(decode=True).decode("utf-8") if n in fields else None
check("attach: channel_id field", text("channel_id") == CHANNEL)
check("attach: title field (UTF-8, stripped like the JSON path)", text("title") == "Teszt cím")
check("attach: content field (UTF-8, stripped like the JSON path)",
      text("content") == "Árvíztűrő tükörfúrógép, egy rövid próbaszöveg.")
fp = fields.get("file")
check("attach: the file part carries the base name and text/markdown",
      fp is not None and fp.get_filename() == "leiras.md" and fp.get_content_type() == "text/markdown")
check("attach: the file part is exactly the file's bytes", fp is not None and fp.get_payload(decode=True) == raw)
rc, out, *_ = run([CHANNEL, TITLE, BODY, "--attach", GOOD, "--confirm"], http_error=415)
check("attach: an HTTP error -> exit 5", rc == 5 and out.startswith("HTTP 415\n"))

# ---------------------------------------------------------------------------
# 4b. MIOFEEDZIP1016: a .zip attachment. Structure only, never extracted; the
#     text gates run on the NAME, not on the content.
# ---------------------------------------------------------------------------
def zpath(name, entries, mutate=None):
    """A zip built in the temp dir. entries: list of (name, bytes) or ZipInfo pairs."""
    p = os.path.join(tmp, name)
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        for e in entries:
            if isinstance(e[0], zipfile.ZipInfo):
                z.writestr(e[0], e[1])
            else:
                z.writestr(e[0], e[1])
    if mutate:
        mutate(p)
    return p


ZGOOD = zpath("csomag.zip", [("skill/SKILL.md", "# Skill\n\nEgy sor \u2013 gondolatjellel, A \u2192 B, Zara irta.\n"),
                             ("skill/scripts/run.py", "print('\u00d7')\n")])
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", ZGOOD])
check("zip: a good zip -> exit 3 (dry), names the file, bytes and sha256",
      rc == 3 and sent == [] and "csomag.zip" in err and hashlib.sha256(open(ZGOOD, "rb").read()).hexdigest() in err)
check("zip: the text gates do NOT run on the content (dash, arrow, agent name inside pass)", rc == 3)
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", ZGOOD, "--confirm"])
zr = sent[0] if sent else {"headers": {}, "data": b""}
zctype = zr["headers"].get("Content-type", "")
zmsg = email.message_from_bytes(b"Content-Type: " + zctype.encode() + b"\r\n\r\n" + (zr.get("data") or b""),
                                policy=email.policy.HTTP)
zparts = {p.get_param("name", header="content-disposition"): p for p in (zmsg.iter_parts() if zmsg.is_multipart() else [])}
zf = zparts.get("file")
check("zip: --confirm -> exit 0, one multipart request", rc == 0 and len(sent) == 1)
check("zip: the file part is application/zip with the base name",
      zf is not None and zf.get_content_type() == "application/zip" and zf.get_filename() == "csomag.zip")
check("zip: the file part is exactly the zip's bytes", zf is not None and zf.get_payload(decode=True) == open(ZGOOD, "rb").read())
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", GOOD, "--confirm"])
mf = None
if sent:
    mm = email.message_from_bytes(b"Content-Type: " + sent[0]["headers"].get("Content-type", "").encode() + b"\r\n\r\n"
                                  + sent[0]["data"], policy=email.policy.HTTP)
    mf = {p.get_param("name", header="content-disposition"): p for p in mm.iter_parts()}.get("file")
check("zip: an .md attachment is still text/markdown", mf is not None and mf.get_content_type() == "text/markdown")

refused("zip: an agent name in an entry name", zpath("bentnev.zip", [("Samu-jegyzet/SKILL.md", "x")]),
        "csatolmany: agens-nev a szovegben: Samu")
refused("zip: a dash in an entry name", zpath("bentjel.zip", [("a \u2013 b.md", "x")]), "csatolmany: gondolatjel (U+2013)")


def bump_version(path):
    """An entry whose 'version needed to extract' is above what zipfile supports."""
    b = bytearray(open(path, "rb").read())
    c = b.find(b"PK\x01\x02")
    b[c + 6:c + 8] = (90).to_bytes(2, "little")
    open(path, "wb").write(bytes(b))


refused("zip: an unsupported extract version is a named refusal, not a traceback",
        zpath("ver.zip", [("a.md", "x")], mutate=bump_version), "a zip nem olvashato")
def nul_name(path):
    """Directory AND local header name: ok.md + NUL + ../../evil.md (same length as the stored name)."""
    b = bytearray(open(path, "rb").read())
    new = b"ok.md\x00../../evil.md"
    for sig, off in ((b"PK\x03\x04", 30), (b"PK\x01\x02", 46)):
        i = b.find(sig)
        n = int.from_bytes(b[i + (26 if off == 30 else 28):i + (28 if off == 30 else 30)], "little")
        assert n == len(new)
        b[i + off:i + off + n] = new
    open(path, "wb").write(bytes(b))


refused("zip: a NUL byte in an entry name (zipfile would cut it at the NUL)",
        zpath("nul.zip", [("ok.md" + "_" * 14, "x")], mutate=nul_name), "NUL a bejegyzes neveben")


def latin1_name(path):
    """A name stored without the UTF-8 flag whose bytes are not UTF-8 (0x82 is cp437 for e-acute)."""
    b = bytearray(open(path, "rb").read())
    for sig, off in ((b"PK\x03\x04", 30), (b"PK\x01\x02", 46)):
        i = b.find(sig)
        b[i + off] = 0x82
    open(path, "wb").write(bytes(b))


refused("zip: an entry name that is not UTF-8", zpath("latin.zip", [("xnev.md", "x")], mutate=latin1_name), "a bejegyzes neve nem UTF-8")


def trailing(path):
    open(path, "ab").write(b"0123456789abcdef")


refused("zip: bytes after the end record", zpath("tail.zip", [("a.md", "x")], mutate=trailing),
        "end-of-central-directory rekordja nem egyertelmu")


def empty_name(path):
    """Rebuild with one entry whose name is empty (length 0 in the local header and the directory)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo(""), "x")


refused("zip: an empty entry name (the server answers zip_unsafe_path)",
        zpath("ures.zip", [("a.md", "x")], mutate=empty_name), "ures bejegyzes-nev a zipben")


def concat(path):
    """Another zip in front: zipfile shifts the offsets and still reads it, the server does not."""
    front, own = open(ZGOOD, "rb").read(), open(path, "rb").read()
    open(path, "wb").write(front + own)


refused("zip: two zips concatenated (the server answers zip_unreadable)",
        zpath("ketto.zip", [("a.md", "x")], mutate=concat), "nem kozvetlenul az end-rekord elott er veget")


def cd_gap(path):
    """Bytes between the central directory and the end record (the end record keeps its offsets).
    zipfile already refuses this one, before the end-record rule; the server accepts it."""
    b = open(path, "rb").read()
    q = b.rfind(b"PK\x05\x06")
    open(path, "wb").write(b[:q] + b"\x00" * 8 + b[q:])


refused("zip: a gap before the end record (the client stays stricter than the server)",
        zpath("res.zip", [("a.md", "x")], mutate=cd_gap), "a zip nem olvashato")


def zip64_tail(path):
    """A ZIP64 end record + locator between the directory and the end record, the plain fields
    keeping the real values: what Info-ZIP writes when it packs from stdin."""
    b = open(path, "rb").read()
    q = b.rfind(b"PK\x05\x06")
    n = int.from_bytes(b[q + 10:q + 12], "little")
    cd_size = int.from_bytes(b[q + 12:q + 16], "little")
    cd_offset = int.from_bytes(b[q + 16:q + 20], "little")
    rec = (b"PK\x06\x06" + (44).to_bytes(8, "little") + (45).to_bytes(2, "little") * 2
           + (0).to_bytes(4, "little") * 2 + n.to_bytes(8, "little") * 2
           + cd_size.to_bytes(8, "little") + cd_offset.to_bytes(8, "little"))
    loc = b"PK\x06\x07" + (0).to_bytes(4, "little") + q.to_bytes(8, "little") + (1).to_bytes(4, "little")
    open(path, "wb").write(b[:q] + rec + loc + b[q:])


ZIP64T = zpath("z64.zip", [("a.md", "x")], mutate=zip64_tail)
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", ZIP64T])
check("zip: a ZIP64 end record + locator before the end record passes (exit 3)", rc == 3 and sent == [])


def zip64_bad_locator(path):
    """The same tail, but the locator points at bytes that are not a ZIP64 end record."""
    zip64_tail(path)
    b = bytearray(open(path, "rb").read())
    q = b.rfind(b"PK\x05\x06")
    b[q - 12:q - 4] = (0).to_bytes(8, "little")
    open(path, "wb").write(bytes(b))


# Refused either way: some zipfile versions already reject the locator (a zip nem olvashato), and
# where zipfile tolerates it, the directory-end rule does.
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach",
                              zpath("z64rossz.zip", [("a.md", "x")], mutate=zip64_bad_locator), "--confirm"])
check("zip: a locator that points at no ZIP64 end record is refused, nothing sent",
      rc == 1 and sent == [] and vc == []
      and ("nem kozvetlenul az end-rekord elott er veget" in err or "a zip nem olvashato" in err))
if shutil.which("zip"):
    ZSTDIN = os.path.join(tmp, "stdin.zip")
    subprocess.run(["zip", "-q", ZSTDIN, "-"], input=b"x\n", check=True)
    rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", ZSTDIN])
    check("zip: an Info-ZIP zip packed from stdin passes (exit 3)", rc == 3 and sent == [])
else:
    print("SKIP zip: no Info-ZIP on this host, the stdin case runs only on the hand-built record")

import io as _io
_inner = _io.BytesIO()
with zipfile.ZipFile(_inner, "w") as _z:
    _z.writestr("belso.md", "x")
NESTED = os.path.join(tmp, "nested.zip")
with zipfile.ZipFile(NESTED, "w", zipfile.ZIP_STORED) as _z:
    _z.writestr("skill/SKILL.md", "# Skill\n")
    _z.writestr("skill/minta.zip", _inner.getvalue())
rc, out, err, sent, vc = run([CHANNEL, TITLE, BODY, "--attach", NESTED])
check("zip: a stored nested zip near the end passes (its end record does not end the file)", rc == 3)
refused("zip: a .zip name over text bytes", fpath("hamis.zip", "nem zip\n"), "nem zip (hianyzik a PK-fejlec)")
refused("zip: agent name in the zip's file name", zpath("Geri-csomag.zip", [("a.md", "x")]), "csatolmany: agens-nev a szovegben: Geri")
refused("zip: over the size cap", fpath("nagy.zip", b"PK\x03\x04" + b"a" * 1_000_000), "1000004 bajt, a plafon 1000000")
refused("zip: too many entries", zpath("sok.zip", [(f"f{i}.txt", "x") for i in range(501)]), "501 bejegyzes van, a plafon 500")
refused("zip: compression bomb (ratio)", zpath("bomba.zip", [("nulla.bin", b"\0" * 3_000_000)]), "tomoritesi aranya")
refused("zip: uncompressed total over the cap", zpath("ossz.zip", [("nulla.bin", b"\0" * 21_000_000)]), "kibontva 21000000 bajt, a plafon 20971520")
refused("zip: a .. path", zpath("ut.zip", [("../kint.md", "x")]), "tiltott ut a zipben: '../kint.md'")
refused("zip: an absolute path", zpath("abs.zip", [("/etc/kint.md", "x")]), "tiltott ut a zipben: '/etc/kint.md'")
refused("zip: a backslash path", zpath("bs.zip", [("a\\b.md", "x")]), "tiltott ut a zipben")
link = zipfile.ZipInfo("link")
link.external_attr = (0o120777 << 16)
refused("zip: a symlink entry", zpath("link.zip", [(link, "/etc/passwd")]), "symlink a zipben: 'link'")
def set_encrypted(path):
    """zipfile clears the encryption bit on write, so set it in the bytes: the local
    header's flag word sits at offset 6, the central directory record's at offset 8."""
    b = bytearray(open(path, "rb").read())
    for sig, off in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        i = b.find(sig)
        b[i + off] |= 0x1
    open(path, "wb").write(bytes(b))


refused("zip: an encrypted entry", zpath("enc.zip", [("titkos.md", "x")], mutate=set_encrypted),
        "titkositott bejegyzes a zipben: 'titkos.md'")


def rename_local(path):
    """The local header says ../evil.tx while the central directory still says okfile.txt."""
    b = bytearray(open(path, "rb").read())
    i = b.find(b"PK\x03\x04")
    n = int.from_bytes(b[i + 26:i + 28], "little")
    b[i + 30:i + 30 + n] = b"../evil.tx"[:n].ljust(n, b"x")
    open(path, "wb").write(bytes(b))


refused("zip: a local header name that differs from the directory", zpath("local.zip", [("okfile.txt", "hello")], mutate=rename_local),
        "local headere mas nevet visel: '../evil.tx'")


def fake_eocd(path):
    """The real archive (../evil.txt) carries, in its comment, a benign directory and a fake end record."""
    import io as _io
    good = _io.BytesIO()
    with zipfile.ZipFile(good, "w") as z:
        z.writestr("ok.txt", "x")
    g = good.getvalue()
    cd, end = g[g.find(b"PK\x01\x02"):g.find(b"PK\x05\x06")], bytearray(g[g.find(b"PK\x05\x06"):][:22])
    b = bytearray(open(path, "rb").read())
    e = b.find(b"PK\x05\x06")
    end[16:20] = (e + 22).to_bytes(4, "little")
    comment = cd + bytes(end)
    b[e + 20:e + 22] = len(comment).to_bytes(2, "little")
    open(path, "wb").write(bytes(b[:e + 22] + comment))


def local_enc_only(path):
    """The encryption bit set in the LOCAL header only; the directory says plain."""
    b = bytearray(open(path, "rb").read())
    i = b.find(b"PK\x03\x04")
    b[i + 6] |= 0x1
    open(path, "wb").write(bytes(b))


def bad_local_offset(path):
    """The directory entry's local-header offset points one byte past the real header."""
    b = bytearray(open(path, "rb").read())
    c = b.find(b"PK\x01\x02")
    b[c + 42:c + 46] = (1).to_bytes(4, "little")
    open(path, "wb").write(bytes(b))


refused("zip: encryption flagged in the local header only", zpath("lenc.zip", [("titok.md", "x")], mutate=local_enc_only),
        "titkositott bejegyzes a zipben: 'titok.md'")
def central_enc_only(path):
    """The encryption bit set in the central directory only; the local header says plain."""
    b = bytearray(open(path, "rb").read())
    c = b.find(b"PK\x01\x02")
    b[c + 8] |= 0x1
    open(path, "wb").write(bytes(b))


refused("zip: encryption flagged in the directory only", zpath("cenc.zip", [("rejt.md", "x")], mutate=central_enc_only),
        "titkositott bejegyzes a zipben: 'rejt.md'")
refused("zip: a directory entry whose local header is missing", zpath("noloc.zip", [("a.md", "x")], mutate=bad_local_offset),
        "local headere hianyzik")


FAKE = zpath("fake.zip", [("../evil.txt", "x")], mutate=fake_eocd)
check("zip: the fake-end-record fixture really fools a directory reader", [i.filename for i in zipfile.ZipFile(FAKE).infolist()] == ["ok.txt"])
refused("zip: a second end record hidden in the comment", FAKE, "end-of-central-directory rekordja nem egyertelmu")
refused("zip: the fake directory's entry points at another local name", FAKE, "local headere mas nevet visel: '../evil.txt'")
refused("zip: one entry over the ratio (per entry, not per archive)",
        zpath("egy.zip", [("nulla.bin", b"\0" * 300_000)] + [(f"r{i}.bin", os.urandom(4000)) for i in range(150)]),
        "'nulla.bin' bejegyzes tomoritesi aranya a plafon")

# ---------------------------------------------------------------------------
# 5. MIOFEEDMARVEEN1014: the two narrow exceptions
#    - the product name "Marveen" passes the agent-name gate in the attachment's
#      content and name ONLY; title and body keep the gate;
#    - the Hungarian quote pair (U+201E, U+201D) passes everywhere; every other
#      non-Latin character still fails.
# ---------------------------------------------------------------------------
def dry(args):
    """Run without --confirm; returns (rc, stderr, requests, vault reads)."""
    rc, out, err, sent, vc = run(args)
    return rc, err, sent, vc


QTITLE = fpath("qcim.txt", "\u201eIdezett\u201d cim\n")
QBODY = fpath("qtorzs.txt", "A torzsben \u201eidezojel\u201d all.\n")
MTITLE = fpath("mcim.txt", "A Marveen flotta\n")
MBODY = fpath("mtorzs.txt", "Ezt a Marveen flotta irta.\n")
MBODY_RAG = fpath("mtorzs-rag.txt", "Kerdezd a Marveent errol.\n")
EMOJI_BODY = fpath("etorzs.txt", "Egy emoji \U0001F600 itt.\n")
ARROW_TITLE = fpath("ncim.txt", "A \u2192 B\n")

for label, path in (
    ("product name in the content", fpath("termek.md", "# Hangvezerles\n\nA Marveen flotta hangja.\n")),
    ("product name with a suffix in the content", fpath("rag.md", "Kerdezd a Marveent, vagy a Marveennel beszelj.\n")),
    ("product name in a compound in the content", fpath("osszetett.md", "A Marveen-eszkozkulcs kell hozza.\n")),
    ("product name in the file name", fpath("Marveen-hangvezerles.md", "# Hangvezerles\n")),
    ("Hungarian quotes in the content", fpath("idezet.md", "A \u201ehangvezerles\u201d szo.\n")),
):
    rc, err, sent, vc = dry([CHANNEL, TITLE, BODY, "--attach", path])
    check(f"exception: {label} passes the local check (exit 3, nothing sent)", rc == 3 and sent == [] and vc == [])

# Every OTHER agent name still fails in the attachment, in the content and in the file
# name: the exception must not widen silently to a second name. The list comes from the
# script itself, so a name added later is covered too.
_names = load().AGENT_NEVEK
_others = [n for n in _names if n != "Marveen"]
check("exception: the script's agent-name list still holds Marveen and at least 13 others",
      "Marveen" in _names and len(_others) >= 13)
for n in _others:
    refused(f"agent name {n} in the content", fpath(f"tartalom-{n.lower()}.md", f"Ezt {n} irta.\n"),
            f"csatolmany: agens-nev a szovegben: {n}")
    refused(f"agent name {n} in the file name", fpath(f"{n}-jegyzet.md", MD), f"csatolmany: agens-nev a szovegben: {n}")
refused("another agent name next to the product name", fpath("vegyes.md", "A Marveen flotta, Samu irta.\n"), "csatolmany: agens-nev a szovegben: Samu")
refused("emoji in the content", fpath("emoji.md", "Egy emoji \U0001F600 itt.\n"), "csatolmany: nem-latin karakter: U+1F600")
refused("a quote that is not the Hungarian pair", fpath("angol.md", "An \u201cEnglish\u201d quote.\n"), "csatolmany: nem-latin karakter: U+201C")

for label, args, needle in (
    ("product name in the title", [CHANNEL, MTITLE, BODY], "agens-nev a szovegben: Marveen"),
    ("product name in the body", [CHANNEL, TITLE, MBODY], "agens-nev a szovegben: Marveen"),
    ("product name with a suffix in the body", [CHANNEL, TITLE, MBODY_RAG], "agens-nev a szovegben: Marveen"),
    ("product name in the body, even with an attachment", [CHANNEL, TITLE, MBODY, "--attach", GOOD], "agens-nev a szovegben: Marveen"),
    ("emoji in the body", [CHANNEL, TITLE, EMOJI_BODY], "nem-latin karakter: U+1F600"),
    ("arrow in the title", [CHANNEL, ARROW_TITLE, BODY], "nem-latin karakter: U+2192"),
):
    rc, err, sent, vc = dry(args)
    check(f"no exception: {label} -> exit 1, nothing sent", rc == 1 and sent == [] and vc == [])
    check(f"no exception: {label} -> names the reason", needle in err)

rc, err, sent, vc = dry([CHANNEL, QTITLE, QBODY])
check("quotes: the Hungarian pair passes in the title and the body (exit 3)", rc == 3 and sent == [])
rc, out, err, sent, vc = run([CHANNEL, QTITLE, QBODY, "--confirm"])
check("quotes: the JSON request carries them as \\u escapes, nothing else changed",
      rc == 0 and len(sent) == 1 and sent[0]["data"] == (
          b'{"channel_id": "11111111-2222-4333-8444-555555555555", "title": "\\u201eIdezett\\u201d cim", '
          b'"content": "A torzsben \\u201eidezojel\\u201d all."}'))

print(f"\n{'ALL PASS' if not failed else str(len(failed)) + ' FAILED'}")
sys.exit(1 if failed else 0)
