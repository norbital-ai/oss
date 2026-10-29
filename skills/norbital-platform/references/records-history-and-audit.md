# Records, history and audit

## System columns

Every model row carries columns Bolt owns. They are read-only to workspace code.

| Column                     | Meaning                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                       | The row's primary key                                                                                      |
| `revision`                 | The row's revision number; an update carries the revision it last read, and a moved row settles `conflict` |
| `created_at`, `created_by` | When and by whom the row was created                                                                       |
| `updated_at`, `updated_by` | When and by whom it last changed                                                                           |

A routed write is committed at once, and its approval request holds the rows: read
`row.$approval` (`requestId`, `state`, `step`, `steps`, `requestedBy`). Never mirror
approval status in a domain field.

## History

History is always on. Every tenant model and supported native identity model keeps one revision per committed change with only the changed fields, the actor, the
time, a cause (`direct`, `cascade`, `derived`, `seed`, `erased` or `restored`) and, for an
approval's provisional change, reviewer edit or rollback, its `request`. The platform
prunes committed history (about 256 revisions per row by default).

- **Answering "what did this look like then".** History is data: `bolt.history(model, id, { at? })`
  in a page, with `at` one of `{ instant }` or `{ revision }`. There is no `{ id, revision }` read:
  to see a known revision with its layers, take its instant `at` from
  `bolt.history(model, id, { at: { revision } })`, then read
  `query({ <model>: { where: { id: { eq: id } }, asOf: at } })`. Server caller contexts read a prior
  state the same way with a root `asOf` instant; they do not expose `ctx.history`. A revision
  shows the root fields of the output the read names (`output`, `default` when absent), scoped by
  the reader's current `history` grant; a deleted record's history stays visible to
  `read: true` holders and administrators until pruned or erased.
- **Per-record restore.** Pages preview with `bolt.restore.preview(model, id, revision)` and
  apply with `bolt.restore.run(model, id, revision, currentRevision)`. A restore is a guarded
  update of the live record's own writable fields and appends a new revision; it does not rewind
  the database or restore deleted records, owned children or derived fields.
- **History is evidence.** A provisional change is history at once. A rejection
  appends `restored` revisions by the decider, `restored_from` the checkpoint (0: the request
  created the row). History is not a general rewind. Finished approval requests and their logs are
  kept; pruning never removes them.
- **Erasure.** Erasing personal data rewrites the stored values and leaves `erased` revisions holding
  ids, field names, the actor and the time — never the erased value.
  It also purges the approval requests that hold an erased record, including owned rows. Their
  request projections and approval notices go with them; unrelated requests remain.

## Administrator audit

The command center's Audit is administrator-only. It queries the host's audit facility (VictoriaLogs in Colony) using
server-side text, actor, time, operation, status and record filters with bounded cursor pages.
The Table lists summaries; opening an event fetches its full payload. The host binds workspace
and environment scope. An unavailable backend is an error, never an empty result.

Native publishers append immutable events with idempotent ids. An acknowledged prepared intent is
separate from a confirmed committed or held event. Recovery matches pending intents to minimal
tenant receipts and revision history; absent evidence stays unresolved. The tenant database and host log store do
not share an atomic commit. Colony declares buffered acknowledgement: a crash before the
one-second disk flush can lose accepted events. Audit records expire after 30 days by receipt
time. Record erasure leaves external audit evidence subject to that retention; permanent workspace
purge deletes its audit namespace and all tenant logs. Deactivation is recoverable for 30 days;
scheduled cleanup then uses permanent purge. Demo reset purges immediately through the same service.

## Telemetry

Operational events (decisions made, runs, delivery, refusals) are the workspace's runtime log, held by the host's
log store, not a model: the command center's Logs and the agent's `logs` tool read it, for administrators. History
says what a row _was_; events say what the platform _did_.

## Live data and the browser

The browser holds the answers of the reads a page has open (reactive `bolt.query` reads) in memory only; there is no
tenant replica in the browser. The host pushes a new answer when a commit changes one. Writes paint
optimistically and settle when the outcome arrives:

- `committed` keeps the paint; an `ActRefused` or `Conflict` failure rolls it back.
- `pendingApproval` keeps the paint: the change is committed and held by its request (a create
  opens as a record). Approval participation does not lend ordinary read or write permission, and
  the lock refuses other writers until the request finishes; rejection rolls the rows back live.
