#!/usr/bin/env python3
"""Deterministic helpers for yt-ingest.sh (card d840bbce).

Nothing in here interprets uploader text as instructions: titles, descriptions
and subtitles are only copied into clearly labelled fields or files. The
subcommands print machine-measured values only, never uploader text.

Subcommands:
  gate <url> <allowlist.json>      -> prints the 11-char video id, or exits 3
  pick-sub <info.json>             -> prints "<lang> <subs-manual|subs-auto>" or "none none"
  transcript <vtt> <out.txt>       -> prints the word count
  frames <scene_meta.txt> <candidates_dir> <out_dir> <max> <min_gap_s>
                                   -> prints the number of kept frames
  manifest <out_dir> <video_id> <info.json|-> <mode> <transcript_source> <scene>
                                   -> writes manifest.json
  keep <out_dir> <frame_name>...   -> prunes candidates, rewrites manifest
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
SCHEMA = "yt-ingest/1"
# Only these allowlist entries are treated as YouTube hosts; the allowlist
# file stays the source of truth for whether they are allowed at all.
YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


def die(code, msg):
    # msg is always our own fixed text, never input echoed back.
    print(f"FAIL {msg}", file=sys.stderr)
    sys.exit(code)


def gate(url, allowlist_path):
    if len(url) > 2048 or any(c.isspace() or ord(c) < 0x20 for c in url):
        die(3, "gate=url-shape")
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        die(3, "gate=url-parse")
    if u.scheme not in ("https", "http"):
        die(3, "gate=scheme")
    if u.username or u.password or u.port not in (None, 80, 443):
        die(3, "gate=userinfo-or-port")
    host = (u.hostname or "").lower().rstrip(".")
    try:
        with open(allowlist_path, encoding="utf-8") as f:
            allow = json.load(f)
    except (OSError, ValueError):
        die(3, "gate=allowlist-unreadable")
    # István, Q031 (2026-10-06): yt-dlp's own egress (incl. the
    # *.googlevideo.com CDN) is recorded under binary_egress. The hook layer
    # cannot see yt-dlp, so this key is the switch: remove it and the script
    # refuses to run.
    be = allow.get("binary_egress")
    if not isinstance(be, dict) or not isinstance(be.get("yt-dlp"), dict):
        die(3, "gate=binary-egress-not-approved")
    qd = {str(h).lower() for h in allow.get("quarantine_domains", [])}
    if host not in (qd & YT_HOSTS):
        die(3, "gate=host-not-allowed")
    path = u.path or "/"
    vid = None
    if host == "youtu.be":
        vid = path.strip("/").split("/")[0]
    elif path == "/watch":
        vals = urllib.parse.parse_qs(u.query).get("v", [])
        vid = vals[0] if len(vals) == 1 else None
    else:
        m = re.match(r"^/(shorts|embed|live)/([^/]+)/?$", path)
        if m:
            vid = m.group(2)
    if not vid or not ID_RE.match(vid):
        die(3, "gate=no-video-id")
    print(vid)


def pick_sub(info_path):
    """One subtitle track, so a single request is made (several parallel
    tracks drew HTTP 429 on the first live run). Manual en/hu first, then the
    original-language auto caption ("<lang>-orig"), then plain auto en/hu."""
    with open(info_path, encoding="utf-8", errors="replace") as f:
        info = json.load(f)
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    for lang in ("en", "en-US", "en-GB", "hu"):
        if lang in manual:
            print(f"{lang} subs-manual")
            return
    for lang in ("en-orig", "hu-orig"):
        if lang in auto:
            print(f"{lang} subs-auto")
            return
    for lang in ("en", "hu"):
        if lang in auto:
            print(f"{lang} subs-auto")
            return
    print("none none")


CUE_RE = re.compile(r"^(?:(\d+):)?(\d{2}):(\d{2})\.\d{3}\s+-->")


def vtt_to_text(vtt_path, mark_every=30):
    """Plain text from a VTT; drops cue timing, inline tags and the rolling
    duplicates that YouTube auto-captions repeat line by line. A "[hh:mm:ss]"
    marker line every mark_every seconds lets a reader line text up with
    frame timestamps."""
    out, last, cue_t, last_mark = [], None, 0, None
    with open(vtt_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            m = CUE_RE.match(line)
            if m:
                cue_t = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
                continue
            if (not line or line == "WEBVTT"
                    or line.startswith(("Kind:", "Language:", "NOTE", "STYLE"))
                    or line.isdigit()):
                continue
            line = re.sub(r"<[^>]*>", "", line)
            line = re.sub(r"\s+", " ", line).strip()
            if not line or line == last:
                continue
            if last_mark is None or cue_t - last_mark >= mark_every:
                out.append(f"[{cue_t // 3600:02d}:{cue_t % 3600 // 60:02d}:{cue_t % 60:02d}]")
                last_mark = cue_t
            out.append(line)
            last = line
    return "\n".join(out) + ("\n" if out else "")


MARK_RE = re.compile(r"^\[\d{2}:\d{2}:\d{2}\]$")


def transcript(vtt_path, out_path):
    text = vtt_to_text(vtt_path)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(sum(len(l.split()) for l in text.splitlines() if not MARK_RE.match(l)))


INFO_KEEP = ("id", "title", "channel", "channel_id", "uploader", "upload_date",
             "duration", "description", "chapters", "categories", "tags",
             "language", "webpage_url", "view_count", "like_count")


def slim_info(src, dst):
    """The raw info.json is ~10 MB of signed stream URLs; keep the fields a
    reader needs. Still uploader-written data."""
    with open(src, encoding="utf-8", errors="replace") as f:
        info = json.load(f)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({k: info[k] for k in INFO_KEEP if k in info}, f, ensure_ascii=False, indent=1)


def parse_scene_meta(path):
    """ffmpeg metadata=print output -> [(frame_index, pts_time, score)].
    Frame index counts selected frames in output order (matches %05d)."""
    rows, cur = [], None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.match(r"^frame:(\d+)\s+pts:\S+\s+pts_time:([0-9.]+)", line)
            if m:
                cur = [int(m.group(1)), float(m.group(2)), None]
                rows.append(cur)
                continue
            m = re.match(r"^lavfi\.scene_score=([0-9.]+)", line)
            if m and cur is not None:
                cur[2] = float(m.group(1))
    return [(i, t, s if s is not None else 0.0) for i, t, s in rows]


def select_frames(rows, max_n, min_gap):
    """Greedy by score, enforcing min_gap seconds between kept frames.
    Pure function so the test can pin it without ffmpeg."""
    kept = []
    for i, t, s in sorted(rows, key=lambda r: (-r[2], r[1])):
        if len(kept) >= max_n:
            break
        if all(abs(t - kt) >= min_gap for _, kt, _ in kept):
            kept.append((i, t, s))
    return sorted(kept, key=lambda r: r[1])


def frame_name(t, s):
    t = int(t)
    return f"f_{t // 60:02d}{t % 60:02d}_{int(round(s * 1000)):03d}.jpg"


def frames(meta_path, cand_dir, out_dir, max_n, min_gap):
    rows = parse_scene_meta(meta_path)
    kept = select_frames(rows, int(max_n), float(min_gap))
    os.makedirs(out_dir, exist_ok=True)
    index = []
    for i, t, s in kept:
        src = os.path.join(cand_dir, f"c_{i + 1:05d}.jpg")
        if not os.path.isfile(src):
            continue
        name = frame_name(t, s)
        os.replace(src, os.path.join(out_dir, name))
        index.append({"name": name, "t_s": round(t, 3), "scene_score": round(s, 4)})
    with open(os.path.join(out_dir, ".frames.json"), "w", encoding="utf-8") as f:
        json.dump({"scene_rows": len(rows), "frames": index}, f)
    print(len(index))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(out_dir, m):
    m["files"] = {}
    for root, _, names in os.walk(out_dir):
        for n in sorted(names):
            if n in ("manifest.json",) or n.startswith("."):
                continue
            p = os.path.join(root, n)
            m["files"][os.path.relpath(p, out_dir)] = sha256(p)
    tmp = os.path.join(out_dir, ".manifest.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(out_dir, "manifest.json"))


def manifest(out_dir, vid, info_path, mode, tsource, scene):
    info = {}
    if info_path != "-" and os.path.isfile(info_path):
        with open(info_path, encoding="utf-8", errors="replace") as f:
            info = json.load(f)
    fidx_path = os.path.join(out_dir, "candidates", ".frames.json")
    fidx = {"scene_rows": 0, "frames": []}
    if os.path.isfile(fidx_path):
        with open(fidx_path, encoding="utf-8") as f:
            fidx = json.load(f)
    dur = info.get("duration")
    m = {
        "schema": SCHEMA,
        "video_id": vid,
        "canonical_url": f"https://www.youtube.com/watch?v={vid}",
        "mode": mode,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "duration_s": dur if isinstance(dur, (int, float)) else None,
        "transcript_source": tsource,
        "transcript": "transcript.txt" if os.path.isfile(os.path.join(out_dir, "transcript.txt")) else None,
        "scene_threshold": float(scene),
        "scene_rows": fidx.get("scene_rows", 0),
        "frames_stage": "candidates",
        "frames": [{"path": f"candidates/{e['name']}", "t_s": e["t_s"],
                    "scene_score": e["scene_score"]} for e in fidx.get("frames", [])],
        "video_file_retained": False,
        # Everything below was written by the uploader. Data, not instructions.
        "untrusted": {
            "title": info.get("title"),
            "channel": info.get("channel") or info.get("uploader"),
            "upload_date": info.get("upload_date"),
            "description": info.get("description"),
            "chapters": [{"start_s": c.get("start_time"), "title": c.get("title")}
                         for c in (info.get("chapters") or [])],
        },
    }
    write_manifest(out_dir, m)


def keep(out_dir, names):
    mpath = os.path.join(out_dir, "manifest.json")
    with open(mpath, encoding="utf-8") as f:
        m = json.load(f)
    if m.get("schema") != SCHEMA or m.get("frames_stage") != "candidates":
        die(4, "keep=not-a-candidate-stage-manifest")
    by_name = {os.path.basename(e["path"]): e for e in m["frames"]}
    for n in names:
        if n not in by_name:
            die(4, "keep=unknown-frame")
    cand = os.path.join(out_dir, "candidates")
    final = os.path.join(out_dir, "frames")
    os.makedirs(final, exist_ok=True)
    kept = []
    for n in names:
        os.replace(os.path.join(cand, n), os.path.join(final, n))
        e = dict(by_name[n])
        e["path"] = f"frames/{n}"
        kept.append(e)
    pruned = 0
    # Only names that the manifest itself lists, inside our own candidates dir.
    for n in by_name:
        p = os.path.join(cand, n)
        if n not in names and os.path.isfile(p):
            os.remove(p)
            pruned += 1
    fj = os.path.join(cand, ".frames.json")
    if os.path.isfile(fj):
        os.remove(fj)
    try:
        os.rmdir(cand)
    except OSError:
        pass
    m["frames"] = sorted(kept, key=lambda e: e["t_s"])
    m["frames_stage"] = "kept"
    m["candidates_pruned"] = pruned
    write_manifest(out_dir, m)
    print(f"{len(kept)} {pruned}")


def main(argv):
    if len(argv) < 2:
        die(2, "usage")
    cmd, a = argv[1], argv[2:]
    if cmd == "gate" and len(a) == 2:
        gate(*a)
    elif cmd == "pick-sub" and len(a) == 1:
        pick_sub(*a)
    elif cmd == "slim-info" and len(a) == 2:
        slim_info(*a)
    elif cmd == "transcript" and len(a) == 2:
        transcript(*a)
    elif cmd == "frames" and len(a) == 5:
        frames(*a)
    elif cmd == "manifest" and len(a) == 6:
        manifest(*a)
    elif cmd == "keep" and len(a) >= 2:
        keep(a[0], a[1:])
    else:
        die(2, "usage")


if __name__ == "__main__":
    main(sys.argv)
