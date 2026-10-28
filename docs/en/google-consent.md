# One Google consent for every Google consumer

> One approval on the phone, one refresh token, written into every Google token
> file of the install in that file's own format.

---

## 🎯 What it does / why it matters

An install often talks to Google through several clients at once: the Gmail,
Calendar and Drive MCP servers, plus small API scripts (Search Console, GA4, Tag
Manager). Each one normally runs its own consent and keeps its own refresh token,
so the tokens expire, get revoked and drift apart one by one, and the owner is
asked to approve again and again.

`scripts/google-consent.py` asks for **one** consent that carries the union of
the scopes every configured consumer needs, and writes the resulting token into
each consumer file:

- **Phone friendly.** `link` prints one URL. The owner opens it, approves, and
  copies the `http://localhost/?code=...` address back (the page itself will not
  load, that is expected). No local web server, no browser on the host.
- **Nothing is dropped.** The scopes a consumer file already carries are added to
  the configured floor, so a new consent never quietly loses a scope.
- **Fails loudly on a short grant.** If a checkbox was left unticked, `redeem`
  names the consumer and the missing scope and writes nothing (or, with
  `--partial`, only the covered consumers).
- **Catches the 7-day trap.** If the token response carries
  `refresh_token_expires_in`, the OAuth app is still in "Testing" and the token
  dies in 7 days; `redeem` says so and exits 4.
- **Separate consents** for scopes Google refuses to combine with the rest in one
  request (seen: `youtube.upload` together with `drive.file` gives
  `400 invalid_request ... scopes that cannot be requested together`).

## 🛠 How it works

### Configuration

Copy the example and edit it; the file is untracked and install-specific:

```bash
cp scripts/google-consent.example.json store/google-consent.json
```

Override the path with `GOOGLE_CONSENT_CONFIG` or `--config`. Keys:

| Key | Meaning |
|-----|---------|
| `client_file` | The OAuth client JSON downloaded from Google Cloud (Desktop app; `installed` or `web` section). Every consumer must use this same client: a refresh token only works with the client it was issued to. |
| `state_dir` | Where the PKCE/state and parking files go (default `store/`). |
| `mcp_scan_root` | Directory whose `.mcp.json` and `agents/*/.mcp.json` are checked for Google MCPs that use a different OAuth client or a token path override (default: install root). |
| `consumers.<name>.format` | `gmail-mcp`, `google-auth` (optionally under `account`, e.g. the Calendar MCP's `normal`), `drive-mcp-v2`, or `raw` (the token endpoint response plus `obtained_at`). |
| `consumers.<name>.path` | The token file this consumer reads. |
| `consumers.<name>.scopes` | The scope floor; short names get the `https://www.googleapis.com/auth/` prefix. |
| `consumers.<name>.process` | Optional node binary name; running copies are listed after a write, since they keep the old token in memory. |
| `consumers.<name>.separate` | `true`: its own consent via `--only NAME`, never part of the union. Must use `raw`, and must not share a scope with the union. |

### Commands

```bash
# 1. one consent URL (no network call)
python3 scripts/google-consent.py link

# 2. dry run: every check, the list of files and keys that would change, nothing written
python3 scripts/google-consent.py redeem '<pasted http://localhost/?... URL>' --dry-run

# 3. the real write (reuses the parked response from the dry run: a code is single use)
python3 scripts/google-consent.py redeem '<the same URL>'

# offline report: modes, which files share one refresh token, expiry field, scope coverage
python3 scripts/google-consent.py status

# a separate consumer
python3 scripts/google-consent.py link --only youtube
python3 scripts/google-consent.py redeem --only youtube '<pasted URL>'
```

Exit codes: `0` ok, `1` error (also config error), `2` usage or a refused code (see
Safety), `3` scope shortfall
(separate consent: not exactly the requested scopes), `4` written/checked but the
token is a 7-day "Testing" token.

### Safety

- **No secret is ever printed**: not the client secret, not an access or refresh
  token, not the PKCE verifier. `status` shows which files share a token by group
  letter only.
- **0600 everywhere.** Token files are written atomically (temp file + rename)
  with mode 0600 regardless of the umask; every missing directory level is created
  0700. Every existing file is first copied byte for byte to
  `<file>.bak-<timestamp>` (0600, never overwritten).
- **A code is redeemed only when it is bound to a link this helper issued.** The
  pasted URL's `state` must match a stored PKCE entry (S256), and the exchange
  always sends that entry's `code_verifier`. A bare code, a URL with the `state`
  removed, or a `state` no `link` issued is refused with exit 2: no network call,
  nothing written. Otherwise a code someone obtained for their OWN Google account
  on the same client id could be pasted in (social engineering, or a prompt
  injection into an agent running the helper) and would bind every consumer to
  that account. The union and every separate consumer have their own state files,
  so their codes cannot be crossed either.
- **Only `redeem` touches the network**, and only the Google token endpoint.
  `GOOGLE_CONSENT_TOKEN_URL` can point it at a loopback `http://` endpoint for
  tests; any other value is refused.

After a write, restart every running session of the Google MCPs (the list is
printed): they still hold the old token, and an MCP that refreshes may write the
old one back into its file. Then run `status`.

### Tests

`python3 scripts/__tests__/google-consent.test.py` is hermetic: temp HOME, fake
token files, a local fake token endpoint, and a guard that fails any other
network call. Every run asserts that no secret sentinel reaches stdout or stderr.
