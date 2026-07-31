# Mutations

**What this pillar protects:** that every write goes through the authoritative path, commits as one
unit with its version, history, audit and feed rows, and — when refused — says something the person
who made it can act on.

## Why these tests exist

A mutation that half-commits is invisible until much later: the row looks written, but its history
gap or missing feed row only surfaces when someone asks a question the archive is supposed to
answer. And a refusal that reaches the user as `MUTATE_FAILED`, or worse as a server stack trace, is
a bug in the product even though the data is correct.

| File                          | Owns                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `delete-many.test.ts`         | Batched delete as one transaction: history archival, one feed row per record in caller order, hook ordering, approval gating, chunking.      |
| `temporal-versioning.test.ts` | The versioning trigger: prior versions archived, live row bumped, deleted rows kept as their final version, history rebuilt after migration. |
| `mutation-rejection.test.ts`  | The line between prose written for the user and a server failure that must never become user copy — and that the reason code survives both.  |
| `constraint-errors.test.ts`   | A constraint violation becomes a sentence naming the field, so a form can attach it to the right input.                                      |
| `sql-identifier.test.ts`      | One identifier rule for the whole server: reject rather than escape, and never return a string that can close its own quoting.               |

## Why versioning lives here

`temporal-versioning` is the substrate the rest of the product borrows: optimistic concurrency reads
the version, approval rollback reads the archive, and the change feed carries the version so a late
server answer cannot overwrite a newer confirmed one. It is tested where it is produced.

## Not here

Optimistic apply and rollback in the browser replica — that is a sync concern and belongs to
`../sync-engine/pod-sync-client.test.ts`. Approval-gated refusal belongs to
[`../access-control`](../access-control/README.md).
