# P4 · Sync engine

The tenant database is authoritative. The browser holds no replica: each live query is registered
with the host, the host re-evaluates it on every relevant commit, and committed state is **pushed**
to the browser. `sync.connect` and `sync.advance` are the only sync commands. **Collection** is the
fan-out unit: one changed collection re-evaluates every subscription indexed under it.

Source: `src/runtime/sync/` (`sync.ts`, `changelog.ts`, `delta-engine.ts`, `digest.ts`,
`resolver.ts`, `write-ledger.ts`), wire contract `bolt-protocol/src/sync.ts`. Colony implements the
host side: `apps/colony/src/lib/hosting/sync-host.ts`, `sync-conductor.ts`, and the routes
`/api/bolt/sync/connect` + `/api/bolt/sync/stream`.

---

## Server: changelog, ledger, changes

On INSERT / UPDATE / DELETE a PostgreSQL trigger (`bolt_sync_capture`, installed by the schema
plan) writes `bolt_sync_outbox` in the **same transaction**. The changelog is collection-granular:
`xid, sequence, collection_name` — the trigger writes **names only**, never rows or cursors.

Retention is a bounded DELETE in `changelog.ts` (`CHANGELOG_HORIZON` = 50 000 sequences, at most
`RETENTION_BATCH` = 1 000 rows per pass, run on connect). Retention never has to be exact: a cursor
below the oldest surviving row answers `truncated`, and a truncated reconnect re-resolves every
query.

Every browser write is recorded in the ledger `bolt_browser_mutation` (the WriteLedger). A write
returns `changes` — `(collection, recordId)` coordinates — which the host fans to the advance
registry; terminal settlements that committed no collection change also reach the ledger and are
settled through the stream.

| Command         | Role                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| `sync.connect`  | The public handshake: initial connect **and** one-entry revalidation share the request shape. |
| `sync.advance`  | Guest evaluation of one wake: changed collections, held subscriptions, pending ledger ids.    |

`sync.connect` carries `head` (optional cursor), `queries` (`key`, `input`, `digest`, `heldIds`,
`digestOnly`), `released` keys, and `pending` write ids. `sync.advance` carries the commit's
`changes`, the host-held `subscriptions` (opaque credentials the guest re-authenticates afresh, so
revocation and policy drift are visible on a wake), `pending`, and an optional `writer` scope.

---

## Host: SyncHost

`SyncHost` (`bolt-protocol/src/sync.ts`) is the shared registry contract, implemented by Colony
and bolt-server. The registry is guest-opinion made durable:

- **One `SubState` per `(policyHash, queryHash)`**, plus a `byCollection` index from collection name
  to subscriptions. Subscription ids are `sha256(policyHash ‖ queryHash)`.
- **Per-connection pump** with backlog collapse: a backpressured connection's lane collapses to
  full answers (`emit` returning false is the collapse signal). One commit produces one apply
  frame.
- **`MAX_SYNC_HELD_IDS` (20 000) is a host promise, not a guest guess**: above the ceiling a
  SubState runs **digest-only** — no id list is held or shipped, so no positional patch is ever
  issued and every wake is answered by a full re-resolve.
- **`releaseId` is part of the scope key.** A release mismatch disconnects the stream, and the
  client Machine turns that disconnect into `needsReload`.

The host hashes and files opaque guest facts. It never imports Bolt, resolves a subject, evaluates
a predicate, masks a row, or constructs a patch — evaluation belongs to the guest (`sync.connect` /
`sync.advance`) and the database.

---

## Query path

- **Live reads.** A mounted live query is answered by `sync.connect` and kept current by `apply`
  frames — the sole SSE payload (`ready` first, then `apply` only). A frame carries the head
  cursor, patches (`from` → `to` digest fence), and write outcomes in **one** reducer event.
- **Cursored reads (`after`) are one-shot.** `after` and `columns` are request concerns, never
  window identity; a cursored query derives empty dependencies and is never registered live.
- **`count` gets a fresh re-count.** A count answer holds no ids; every wake re-counts and pushes a
  scalar.
- **Search** is an explicit lexical (`{ mode: 'lexical', term }`) or semantic
  (`{ mode: 'semantic', term }`) command. Semantic search performs **one embed per request**.
  Search lives in the query input the host already holds; no separate search index is registered.

---

## Write path

1. The browser enqueues one declarative graph into the Machine and pushes it over HTTP with the
   connection header. Durability is `'memory'` — the tab's queue — until the authority settles it.
2. The guest runs the one mutation pipeline (hooks → policy → transaction → history → changelog),
   records the ledger row, and returns `changes`.
3. The host fans `changes` into a `sync.advance` wake; the guest re-evaluates affected
   subscriptions and the host emits one apply frame carrying patches **and** the write's outcome.
4. Settlements are `accepted | rebased | rejected | quarantined`. Nothing is claimed saved before
   its outcome; nothing labels an unproven result fresh.

A stale `schemaFingerprint` is refused; a schema transition rebases the write (`rebased` carries
the from/to fingerprints). `collections.resume` is the approval-release verb.

---

## Scheduled work

The host invokes `host.schedules.discover` (guest returns inert occurrences), invokes each
occurrence's command itself as a credential-free `Task`, then records the outcome with
`host.schedules.settle`. There is no inline tick inside a tenant invocation.

---

## Invariants

1. **I1 — the database is the only predicate evaluator.** Query resolution calls the one
   authoritative collection resolver; no sync-specific evaluator exists anywhere.
2. **I2 — dependencies over-report.** Relation and policy dependencies are derived conservatively;
   an unknown relation falls back to every collection. Over-reporting costs re-evaluations;
   under-reporting loses liveness.
3. **I3 — one commit, one frame, one apply.** A commit's query changes and write settlements reach
   the client as one reducer event.
4. **I4 — the digest chain fences every patch.** A patch applies only when the client's current
   digest equals the patch's `from`; otherwise the query re-resolves.
5. **A probe is the query's own filter evaluated under the subject's read predicate** — there is no
   separate probe evaluator. **The fallback full answer is always legal**: any subscription may be
   answered by a full re-resolve at any time.

---

## What this is not

- Not a replica, not a local database. The browser keeps current answers in memory; nothing
  durable is stored client-side.
- Not local-only. Permissions and invariants stay server-authoritative on every answer.
- Not a durable server subscription per tab or query. Server durable state is the changelog plus
  the ledger; per-connection registry state is O(live queries), and a reconnect re-resolves.
