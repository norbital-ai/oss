# Records, history and audit

## System columns & history

- Read-only system columns: `id` (UUIDv7), `revision` (optimistic concurrency — stale revision returns `conflict`), `created_at`, `created_by`, `updated_at`, `updated_by`. Read `row.$approval` instead of mirroring approval status.
- History is always on: one revision per committed change (`direct`, `cascade`, `derived`, `seed`, `erased`, `restored`, plus approval `request`), pruned to ~256 revisions/row.
- Pages read past states with `ctx.history(model, id, { at: { instant } | { revision } })` (or root `as_of` with layers); server uses `ctx.query` with `as_of`. Access requires output grant `history: true` + current root `where` (unrestricted/admin sees deleted history until pruned/erased).
- Restore (`ctx.restore.preview` → `ctx.restore.run(model, id, revision, current_revision)`) is a guarded update appending a revision; never rewinds DB or restores deleted rows, owned children or derived fields.
- Erasure rewrites stored values, records `erased` revisions without old values, and purges holding approval requests and notices.

## Audit, telemetry & live data

- Administrator audit uses the host audit facility (bounded cursors; unavailable backend is an error, never empty). Colony buffers flushes (~1s); records expire after 30 days (deactivation recoverable 30 days; purge deletes namespace).
- Operational telemetry lives in the host log store (not a model); e.g. `read.refused` warns with `caller`, `model`, `output`, `holds`.
- Workspace tabs stream live reads; fleet browser snapshots use explicit `ctx.refresh()`. Writes paint optimistically (`committed` keeps, `ActRefused`/`conflict` rolls back, `pending_approval` holds). Approval participation grants no ordinary read/write access.
