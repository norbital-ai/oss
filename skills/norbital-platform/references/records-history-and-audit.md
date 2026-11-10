# Records, history and audit

## System columns

Read-only to workspace code: `id`, `revision` (an update carries the revision it read; a moved row settles `conflict`), `created_at`, `created_by`, `updated_at`, `updated_by`. Never mirror approval status in a field: read `row.$approval`.

## History

Always on. One revision per committed change with changed fields, actor, time, cause (`direct`, `cascade`, `derived`, `seed`, `erased`, `restored`) and an approval's `request`. Pruned to about 256 revisions per row.

- Read a past state: `bolt.history(model, id, { at })`, `at` one of `{ instant }` or `{ revision }`. With layers: take its instant, then a root `as_of`. Server contexts use `as_of`; there is no `ctx.history`.
- A revision shows the root fields of the read's output, scoped by the reader's current read grant (the record's own `where`). Losing access to the row loses its history, even if the reader saw it before. A deleted record's history stays visible to `read: true` holders and administrators until pruned or erased.
- Restore: `bolt.restore.preview` then `bolt.restore.run(model, id, revision, currentRevision)`. It is a guarded update of writable fields appending a revision. It never rewinds the database or restores deleted records, owned children or derived fields.
- History is evidence, not a rewind. A rejection appends `restored` revisions. Finished requests are never pruned.
- Erasure rewrites stored values, leaves `erased` revisions without the value, and purges approval requests holding the record, with their projections and notices.

## Administrator audit

- Administrator-only, through the host's audit facility, with server-side filters and bounded cursors. The host binds scope. An unavailable backend is an error, never empty.
- Publishers append immutable events with idempotent ids. A prepared intent is separate from a confirmed event; absent evidence stays unresolved.
- Tenant database and log store share no atomic commit. Colony acknowledges buffered: a crash before the one-second flush can lose accepted events.
- Records expire after 30 days. Permanent workspace purge deletes its audit namespace. Deactivation is recoverable for 30 days.

## Telemetry

Operational events are the workspace's runtime log, in the host's log store, not a model; administrators read them. History says what a row was; events say what the platform did.

## Live data

- The browser holds open reads in memory only. The host pushes a new answer when a commit changes one.
- Writes paint optimistically. `committed` keeps the paint; `ActRefused` or a conflict rolls it back; `pending_approval` keeps it, held by the request.
- Approval participation lends no ordinary read or write permission.
