# Skool CLI

> Full management of a community platform from the command line — even though there's no official API.

---

## 🎯 What it does / why it matters

Skool is a popular community platform with **no public API**. Marveen still uses a complete command-line tool for it: writing posts, creating courses in the classroom, uploading images/videos, starting polls, deleting content — all in under a second, no browser clicking.

This was built using the [printing-press](printing-press-cli.md) HAR route: by recording a logged-in session's network traffic, the system extracted the platform's internal endpoints and generated a ready CLI from them in 20 minutes.

One post manually: 10-30 seconds of clicking, searching for a category, typing the text. With the CLI: 1 command, 1-2 seconds. At agent scale this difference multiplies: the fleet works at fleet speed, not clicking speed.

**Highlight:** the first live use was posting about the CLI itself — the seconds the command ran were shorter than the time it would take to just open the editor in a browser.

---

## 🛠 How it works

### Architecture

Generated Go CLI (`skool-pp-cli`), targeting `api2.skool.com` endpoints. Commands: `posts` (create/update/delete/comments), `courses` (CRUD + state + parent), `files` (presigned upload), `polls`, `videos`, `self`, `search`, `sync`.

### Auth

Skool is cookie-based: the `auth_token` JWT via env variable (`API2_SKOOL_API_KEY`). Optional automatic re-login on 401 (`SKOOL_EMAIL` + `SKOOL_PASSWORD`). Token lifetime ~1 year.

### Important content rules

- The `content` field is **plain text, NOT HTML** — HTML tags will appear literally. Paragraph: `\n\n`.
- Posts are written in the owner's voice, **first person singular** (not plural).
- `metadata.labels` (category) and `video_ids` are **strings**, not arrays; `group_id` is a UUID (not a slug).

### Email scanner pitfall

Use 6-digit OTP codes instead of magic links: corporate email scanners "click" the link (consuming the one-time token); they don't touch OTP codes. OTP code length must match the input field.

### When CLI, when browser

CRUD, listing, uploading → CLI (fast, token-efficient). Visual verification or complex custom UI interaction → browser.
