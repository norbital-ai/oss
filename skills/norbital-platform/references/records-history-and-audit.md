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

Collections can retain full row history rather than overwriting in place. Past versions stay
queryable, which is what makes two things possible:

- **Rollback that restores rather than guesses.** When an approval is rejected or withdrawn, the row
  returns to its previous state because that state was kept, not reconstructed.
- **Answering "what did this look like then".** History is data, so a question about a past value is
  a query rather than an archaeology exercise in logs.

History is enabled per collection. The manifest reports whether a given collection has it.

## Audit

Mutations are recorded, so who changed what and when is answerable from stored data. This is
separate from temporal history: history tells you what the row _was_, audit tells you _who acted_.

## Sync and the client replica

Clients hold a local replica of the data they are allowed to see — policy-scoped, so the replica
never contains rows the user could not query directly. Mutations apply optimistically against the
replica and reconcile with the server.

Approval state propagates the same way. That is why a record can visibly become locked a moment
after it is written: the write succeeded locally, then the server's approval request and its locks
arrived through the same sync channel.

Two consequences worth stating to a confused user:

- A write that appears to succeed and then shows as pending has not failed. That is write-then-lock
  working as designed.
- A 409 conflict on editing a record usually means an open approval holds it, not that someone else
  is editing it.
