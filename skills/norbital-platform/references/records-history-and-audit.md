# Records, history and audit

## System columns

Every collection row carries columns Bolt owns. They are read-only to workspace code, and they appear
in the manifest marked as such.

| Column        | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `id`          | The row's UUID primary key                         |
| `created_at`  | When the row was created                           |
| `updated_at`  | When it last changed                               |
| `row_version` | Optimistic-concurrency counter                     |
| `sys_period`  | The temporal validity range backing record history |
| `approval_id` | Non-null while an open approval holds this row     |

`approval_id` is the one that most often confuses a reader. Seeing it on a collection does
not mean that collection has an approval flow — every collection has the column. It means the
platform _can_ gate writes to that collection if a policy says so. A row with a non-null value is
currently held by an open approval request.

## Temporal history

Every record's versions are retained in `bolt_collection_history`
(`sequence, collection_name, record_id, operation, subject_id, snapshot`). A new-row mutation stores
the initial values; each existing-row mutation stores only the fields that changed; the read path
folds them oldest
first into full revisions `{ values, validFrom, validTo, version }`. The manifest reports every
collection as `history: true`.

That makes one thing possible:

- **Answering "what did this look like then".** History is data, so a question about a past value is
  a query rather than an archaeology exercise in logs. Read it with the history read grant
  (`history` on the policy, with the same `where`/`fields` narrowing as `read`) through
  `collections.history` on the server; the browser side is `client.history.findMany(collection,
recordId, limit?)`.

What history is **not** is a rollback mechanism. A rejected approval does not restore a previous
state because the prepared values were never committed; it discards the prepared mutation and
releases any existing-row hold (see approvals). Past versions are read-only evidence, not a rewind.

## Audit

Every mutation also appends to `bolt_audit` (`sequence, kind, subject_id, payload`) — a running,
attributable event log: who acted, on what kind of event, with what payload. This is separate from
temporal history: history tells you what the row _was_, audit tells you _who acted_ and when.

## Sync and the client replica

Clients hold a local replica of the data they are allowed to see — policy-scoped, so the replica
never contains rows the user could not query directly. Mutations apply optimistically against the
replica and reconcile with the server.

Approval state propagates the same way. An optimistic client mutation can reconcile to an open
approval: a held new-row mutation has no server domain row, while an existing-row mutation/delete
target remains at
its committed values and may become locked when the request arrives through the sync channel.

Two consequences worth stating to a confused user:

- A write that appears to succeed optimistically and then shows as pending has not failed. The
  server prepared it and is holding it at the approval gate; its proposed values are not committed.
- A write refused because an open approval holds a record comes back as an approval conflict naming
  the request — not as a concurrency error between two editors. A record held by an approval is
  invisible to a workspace's liveness predicate (`approval_id IS NULL`), so a "record not found"
  while it is pending is the same approval.
