# Meta Graph read helper (`scripts/graph-read.py`)

> A read-only door to the Facebook / Instagram Graph API: GET only, a fixed host, the token from the store and never on the command line.

---

## 🎯 What it does / why it matters

Agents that run a Facebook Page or an Instagram business account need to *read* a lot: the page feed, a video's
source, the account's media list, insights. Done with an inline `curl`, every such read puts the access token
on the command line (and into the transcript), and a hook in front of the shell cannot tell it apart from a
publish once the verb is hidden (`-XPOST`, `method=post`, a `batch=` body, a percent-encoded path).

`graph-read.py` is the one command a read needs, and it is a read by construction:

- every request is a body-less `GET` to `graph.facebook.com` (re-checked on the final URL);
- the path is plain (`[A-Za-z0-9_/-]` after an optional `vNN.N/`): no host, no dot, no `?`, no `..`;
- query parameters only as `key=value` arguments, and only from an allowlist (`fields`, `limit`, `after`,
  `before`, `since`, `until`, `metadata`, `summary`, `date_preset`, `period`, `metric`, `breakdowns`);
  write markers (`message=`, `method=`, `batch=`, `published=` ...) are refused before any network call;
- the token comes from `store/.meta-token` (with `--page <id>` the page token is derived from it via
  `me/accounts`); it is never printed, and every `access_token` key in the answer is masked.

```bash
python3 scripts/graph-read.py me/accounts fields=id,name
python3 scripts/graph-read.py <PAGE_ID>/feed fields=id,message,created_time limit=5 --page <PAGE_ID>
python3 scripts/graph-read.py <IG_USER_ID>/media fields=id,caption,permalink limit=10
```

Exit codes: `0` ok (JSON on stdout), `2` refused or usage error (nothing sent), `1` token, network or API error.

---

## 🛠 How it works

**Rate limits.** A Graph error with a rate-limit code (17, 80004, 613, 80000, 80003, 80014) is retried, at most 6
calls in all. The wait comes from the usage headers when they carry one (`X-Business-Use-Case-Usage`
`estimated_time_to_regain_access`, `X-Ad-Account-Usage` `reset_time_duration`), otherwise 60 s doubling up to
600 s. The total sleep of one invocation is capped by `GRAPH_READ_MAX_WAIT_SEC` (default 300 s, so it fits a
Bash tool call; give that call a timeout of at least 400000 ms). A wait that does not fit fails at once with
exit 1 instead of sleeping.

**Shared pause file.** Every caller of one user token shares the same limit, so a limit error writes
`{"blocked_until": <epoch>, "ok": <why>, "irta_pid": <pid>}` into a pause file (flock on `<file>.lock`, atomic
rename, only ever raised, a value more than an hour out ignored as stale), and every attempt first waits out a
pause someone else wrote. A successful answer at or above 95 % usage also writes a pause for the next caller.

| Setting | Where | Default |
|---|---|---|
| `META_GRAPH_PAUSE_FILE` | process environment, then the install `.env`; relative = from the install root | `store/meta-graph-pause.json` |
| `GRAPH_READ_MAX_WAIT_SEC` | process environment | `300` |

Point `META_GRAPH_PAUSE_FILE` at the file another Graph client of the same token already uses, so they hold each
other back.

**Tests.** `python3 scripts/__tests__/graph-read.test.py` (hermetic: a fake opener, temp token and pause files,
a faked clock; no network).
