# API Deprecation Policy

This document defines how Marveen dashboard API versions are deprecated,
how long they remain available, and when they are removed.

---

## Versioning scheme

The canonical API base is `/api/v1/<resource>`.

The legacy alias `/api/<resource>` (no version prefix) is kept alive as a
compatibility shim.  Every response served through the legacy alias carries
three RFC 8594 response headers:

```
Deprecation: true
Sunset: Wed, 31 Dec 2026 23:59:59 GMT
Link: </api/v1>; rel="successor-version"
```

These headers are written by `src/web/routes/versioning.ts`:`applyDeprecationHeaders()`.
The Sunset date constant lives there too (`SUNSET_DATE`); it is the single
place to update when extending the window.

---

## Deprecation window

| Legacy alias        | Sunset date        | Status       |
|---------------------|--------------------|--------------|
| `/api/*` (no ver.)  | 2026-12-31         | Deprecated   |

**Minimum deprecation window: 6 months** from the date the successor version
is published and the `Deprecation` header first appears in responses.

The window may be shortened only when:
- A critical security vulnerability requires immediate removal.
- The legacy surface was never used in production (verified via logs).

In either case the repository owner must approve the shortened window before removal.

---

## How to deprecate an API surface

1. **Introduce the replacement first.** Ship the canonical `/api/v1/<resource>`
   endpoint in a release and document it in `docs/openapi.yaml`.

2. **Wire the headers.** Ensure `applyDeprecationHeaders()` is called for every
   request that reaches the legacy path.  The versioning middleware in `src/web.ts`
   already does this for all `/api/*` requests automatically.

3. **Set the Sunset date** in `SUNSET_DATE` (versioning.ts) to at least
   6 months from the current date.

4. **Record in CHANGELOG.** Add a `Changed` entry labelled `**[API]**` that
   names the deprecated path, its successor, and the Sunset date.  Run
   `npm run changelog` to regenerate the `[Unreleased]` section if needed.

5. **Update openapi.yaml.** Mark the deprecated path with `deprecated: true`
   in the spec and add a description pointing to the replacement.

---

## How to remove a deprecated API surface

An API surface may be removed **only after its Sunset date has passed** and
the following conditions are all met:

1. The Sunset date is in the past.
2. CHANGELOG.md has a `Removed` section entry for this version in the release
   that ships the removal.
3. The removal commit is reviewed by the repository owner before it is merged.
4. The corresponding `deprecated: true` path is removed from `docs/openapi.yaml`
   in the same PR.
5. `npm run generate:sdk` is run and `src/generated/api.ts` is committed.

**Never remove a path mid-release-cycle.** Removals must land in a dedicated
commit that can be cherry-picked or reverted without touching other changes.

---

## CHANGELOG conventions for API changes

Every change that touches an API surface must include a `**[API]**` label in
CHANGELOG.md.  The CI check in `.github/workflows/ci.yml` enforces that
`CHANGELOG.md` is updated in the same PR as `docs/openapi.yaml` or any
`src/web/routes/` file.

Entry shape for a deprecation:

```markdown
### Changed

- **[API]** Deprecate `/api/<resource>` (legacy alias) -- use `/api/v1/<resource>`.
  Sunset: 2026-12-31. Responses carry RFC 8594 Deprecation + Sunset headers.
```

Entry shape for a removal:

```markdown
### Removed

- **[API]** Remove deprecated `/api/<resource>` legacy alias (Sunset was 2026-12-31).
```

---

## Roles and responsibilities

| Action                          | Who decides            |
|---------------------------------|------------------------|
| Introduce new version           | Architect plans, backend developer implements |
| Set / extend Sunset date        | Backend developer (code), owner approves     |
| Shorten window (security / unused) | Repository owner                          |
| Approve removal PR              | Repository owner                              |

---

## Quick reference for agents

When you touch any file under `src/web/routes/` or `docs/openapi.yaml`:

1. Run `npm run changelog` and commit `CHANGELOG.md` in the same PR.
2. If you are adding a path that replaces an older one, set `deprecated: true`
   on the old path in `docs/openapi.yaml`.
3. If you change `SUNSET_DATE` in `versioning.ts`, update this document's table.
4. Do not remove a deprecated path without the repository owner's explicit approval.
