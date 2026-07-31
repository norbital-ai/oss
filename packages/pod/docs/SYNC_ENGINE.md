# Pod Sync Engine

How Pod delivers live, instant reads and optimistic writes across the network.

---

## Quick reference: queries and mutations

### Reading data (live, reactive)

```typescript
import { client } from '$pod/client';

const orders = client.db.orders.findMany({
	where: { status: { eq: 'open' } },
	with: { customer: true },
	orderBy: { created_at: 'desc' }
});
// Live. Someone else closes an order in another tab, another browser, or an automation
// on the server — this result updates. You wrote nothing extra to make that happen.
```

Every read is a **live query**. The sync engine maintains a local PGlite replica of the
policy-scoped data you are authorised to see. Reads execute against that replica — no network,
no cache invalidation, no loading orchestration. When a mutation lands (yours or someone
else's), the engine re-evaluates every live query that depends on the changed collections and
diffs the result into the reactive value.

**Methods:** `findMany`, `findFirst`, `count`, `create`, `createMany`, `update`, `delete`.

```typescript
// Scalar reads
const employee = client.db.employees.findFirst({
	where: { norbital_id: { eq: id } },
	with: { employments: true }
});

const headcount = client.db.employees.count({
	where: { status: { eq: 'active' } }
});

// Pagination — keyset, never offset
const page = client.db.orders.findMany({
	where: { status: { eq: 'open' } },
	orderBy: { created_at: 'desc' },
	limit: 25,
	after: cursor
});
```

### Writing data (optimistic)

```typescript
await client.db.claims.create({
	employee_id: employeeId,
	amount: 1500,
	description: 'Travel reimbursement'
});
// UI updates same-frame. The mutation posts to the server;
// on rejection the overlay rolls back and the reason is surfaced.
```

Mutations go through `collection_ops` on the server — permissions, hooks, audit, history,
approvals, and versioning always apply. The sync engine applies the change to a local overlay
on the same frame so the UI responds instantly. The server confirms or rejects asynchronously;
a rejection carries `currentRow` so the form layer can reconcile.

### The invariant

> **The read path never waits for data this device has already seen.**

Every server answer is folded into the local replica. The second visit to anything is instant.

---

## End-to-end architecture

Engine code lives in two halves:

- **client** — `packages/pod/src/lib/client/sync/` + the read seam in
  `packages/pod/src/lib/runtime/client.ts` and `packages/pod/src/lib/client/remote-query.svelte.ts`
- **server** — `packages/pod/src/lib/server/collection/sync/`

A compatible host provides the server transport. The sync engine itself is a Pod concern and does
not depend on any particular host application.

---

## 1. The contract

Two promises, and everything in this document exists to keep them.

**To the author:** you write as if you are talking to one database. Reads are live. There is no
cache to invalidate, no `refetch`, no `revalidate`, no loading orchestration. You write a query;
the result stays true.

**To the user:** loads, filters, sorts, search, related records, and mutations are instant.
Not "fast" — instant, meaning resolved within the frame, because no network is involved.

### The invariant that delivers both

> **The read path never waits for data this device has already seen.**

Reads execute against a local Postgres (PGlite) replica. The network exists to fill the replica
and to accept writes — it is not consulted to answer a question the replica can already answer,
and it is never asked the same question twice.

The stronger form — "the read path never touches the network" — is the _goal_, and it is
achieved for the collections that fit locally (§3.1). It cannot be an absolute at a million
records: the first time anyone asks for page 900 of a million-row table, someone has to go and
get it. What the architecture must guarantee is narrower and actually achievable:

1. you never wait twice for the same data,
2. you never see an empty frame while waiting, and
3. once data is local it stays live, forever, without anyone invalidating anything.

---

## 2. What the reference implementations actually teach

Worth being precise here, because the three systems are usually cited as if they agreed.

**Linear.** Bootstraps the user's whole workspace subset into IndexedDB on first load, then
receives deltas over a persistent socket. Every view — every filter, grouping, sort, and the
command palette — is computed in memory from that store. There is no per-view server query, so
there is no per-view loading state. The expensive moment is the _first_ load, and it happens
once; a reload is a socket connect and a delta catch-up. **Takeaway: the sync unit is the
workspace subset, not the view.** Views are pure local computation over it.

**Notion.** Syncs records with per-record version tracking and resolves queries against the
local record store. Related-record resolution (a page's inline references) is a local pointer
chase, never a fetch. **Takeaway: relations must be local, or relation-heavy UI is death by a
thousand round-trips.**

**Electric SQL.** Shapes are genuinely good — but Electric shapes are _server-maintained
materializations with their own append-only log and their own offset_. The server keeps each
shape live and hands the client a resumable per-shape position. Shapes are only worth their
complexity when the server maintains them. **Takeaway: a "shape" that is really just a one-shot
paginated `SELECT`, with liveness delivered by a separate global stream, is a shape in name
only.** It buys nothing and costs a cold start per UI state.

**Zero (Rocicorp).** The query is the sync unit, and — this is the part worth copying — every
result carries its own completeness. `resultType` is `'complete'` (all data present),
`'unknown'` (some is missing locally) or `'error'`. Their documented UI rule is to show "not
found" only when `resultType === 'complete'` *and* the row is absent, precisely so a cold page
does not flash 404 while the server answers. **Takeaway: never let the UI infer completeness
from emptiness.** A partial result and an empty one look identical unless the engine says which
it is.

Pod's server has a **single global change feed** (`sync_outbox`, tailed by `(xid, seq)`). Given
that, the correct client sync unit is the **collection**, not the query shape. That is the
central design decision below.

### 2.1 Where Pod landed relative to them

| Problem | Electric | Zero | Pod |
| --- | --- | --- | --- |
| Partial replication | server-maintained shape (table + where + columns) | per-query | per-collection, byte-budgeted |
| Resume position | `offset` (starts `-1`) + shape `handle` | per-query | `(xid, seq)` cursor on one global feed |
| Position no longer valid | **HTTP 409** + `{"headers":{"control":"must-refetch"}}` | re-sync | `event: reset` on the stream (§3.8a) |
| Caught up | `up-to-date` control message | `resultType: 'complete'` | catch-up completes → `synced` |
| Partial result reaches the UI | shape is complete by construction | **yes, labelled `'unknown'`** | **no — declined, server answers** |

The first four rows are the same design under different names, which is reassuring: the
compaction boundary and its reset are not an invention here, they are the standard answer.

The last row is a real divergence and worth stating as a choice. Zero shows partial results and
labels them; Pod refuses to answer locally unless it can prove the answer is complete (§3.2).
Both are honest — what neither does is present a partial result as a whole one. Pod's version
costs a round trip on a windowed collection; Zero's costs an extra concept every caller has to
handle correctly. Pod's is the safer default for a workspace where a filtered list quietly
missing rows is a correctness bug, not a cosmetic one.

**The improvement this comparison points at** is adopting Zero's labelling *in addition* to the
current behaviour: return the local rows immediately with `complete: false`, let the table render
them, and swap in the server's answer when it lands. That is strictly better than a spinner and
strictly better than silence — but it adds a concept to every read site, so it is a deliberate
next step rather than a tweak.

---

## 3. Architecture

```
                        ┌─────────────────────── server ───────────────────────┐
  writes ──────────────▶│  collection_ops  (authority: policy, hooks, audit,   │
                        │                   history, approvals, versioning)    │
                        │        │                                             │
                        │        ├──▶ tables + *_history  (trigger-driven)     │
                        │        └──▶ sync_outbox         (trigger-driven)     │
                        │                   │                                  │
                        │            outbox tailer  (xid, seq) ordered,        │
                        │            horizon-gated, policy-scoped per client   │
                        └───────────────────┬──────────────────────────────────┘
                                            │  SSE  /_runtime/sync/stream
                                            ▼
  ┌──────────────────────────── client (one per origin) ───────────────────────┐
  │  PodSyncClient ── applies diffs ──▶ PGlite replica ◀── collection catch-up │
  │       │                                   │            /_runtime/sync/shape│
  │       │  notifies collection change       │                                │
  │       ▼                                   ▼                                │
  │  LiveQuery registry ────── re-executes local SQL (sub-ms) ─────────────▶ UI │
  └────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 The sync unit is the collection

One catch-up per collection, one persisted state row per collection. Filters, sorts, pagination,
counts, grouping and search are then **pure local SQL** over a warm table.

This is what makes changing a sort free. Under shape-keyed sync, `orderBy: created_at` and
`orderBy: name` are two different shapes, so the second is a cold start: server round-trip, new
paging loop, new completeness flag — and, while it is cold, a UI with no data.

**Policy scoping is the server's job and stays the server's job.** The catch-up runs through
`findMany`, which AND-s the compiled policy filter; the stream's `buildDiff` re-reads each
changed row through `findFirst` under policy and emits `leave` when a row leaves scope, so the
client evicts it. Rows the user may not see never reach local storage, and the client is never
trusted to filter for authorization.

This is also the main reason the model survives large data: **what syncs is the policy-scoped
slice, not the table.** A million-row collection is often a few thousand rows for any one user,
and those users get the fully-local experience with no special handling.

### 3.2 Two tiers: resident and windowed

A collection is **resident** when its policy-scoped rows fit the residency budget — 1 GiB of
encoded row data, shared across every collection, reached in a handful of pages. Everything about a resident collection is local and instant:
filter, sort, page, count, relation, search, offline.

Above the cap it is **windowed**. The replica holds a working set rather than the whole slice,
and the rules change in exactly the places where a window would otherwise produce a _wrong_
answer rather than a stale one:

| Read                                   | Resident                           | Windowed                                                                            |
| -------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| a full page (filter / sort / paginate) | local                              | local — those rows are real and in order                                            |
| a page that comes up short             | local — that's the end of the data | server — might be the window's edge                                                 |
| primary-key lookup that hits           | local                              | **local** — `norbital_id` is unique, so a hit is the whole answer                   |
| primary-key lookup that misses         | local `null`                       | server — the row may lie beyond the window                                          |
| `count`                                | local                              | server — a count over a window is wrong, not stale                                  |
| `search`                               | local                              | server — a match may sit outside the window, and the server has the trigram indexes |
| `findFirst` miss                       | local `null` — proof of absence    | server — absence from a window proves nothing                                       |
| to-one relation, all keys resolve      | local                              | local                                                                               |
| to-one relation, some key missing      | n/a                                | server                                                                              |
| to-many relation                       | local                              | server — a window can't prove a child set is complete                               |

The primary-key row is the one worth calling out: opening a record and rendering relationship cells
are both pinned-key reads, and they stay instant even on a collection far too large to hold. That
single rule is what keeps a million-row collection feeling local for the reads that dominate.

Windowed collections are **not** filled by speculative bulk download. Pulling tens of thousands
of rows the user may never look at is slow, and worse, a window materialised under the default
sort is useless for a different sort. Instead the working set accumulates from the queries the
app actually makes: **every server answer is folded back into the replica** (`absorbServerRows`).
A windowed collection therefore converges on local along exactly the paths this user walks, and
the second visit to anything is instant.

### 3.3 Searching for something that isn't local yet

The case worth spelling out, because it is where a naive local-first engine returns a confidently
wrong answer.

On a **resident** collection, local search is the whole answer — including a genuine "no results",
because every row the policy exposes is present. Instant, and correct offline.

On a **windowed** collection the local executor **refuses to answer at all**, even when it can see
matches. A window cannot prove there is no better match beyond it, and a partial result list
presented as a complete one is worse than a spinner. So:

1. `localFindMany` returns `null` and the read goes to the server, which has the full slice and the
   trigram indexes.
2. The UI does **not** blank while it waits — the query family keeps showing the previous results
   (§3.5), so search feels like filtering rather than reloading.
3. The rows that come back are absorbed into the replica. Opening any of them is instant, and they
   stay live on the stream from that moment on.

The one honest asymmetry: search stays a server round-trip for as long as the collection is
windowed. Absorbing results makes the _records_ local, not the _index_, so a repeated search is
still answered by the server. That is the correct trade — the alternative is a search box that
silently misses rows.

### 3.4 Pagination

Keyset, never offset, on both sides — and the local cursor format is byte-identical to the
server's, so a page can be served locally or remotely without the caller knowing which. That
equivalence is what lets a windowed collection page locally until it runs off the edge of the
window and then continue against the server with the same cursor.

Order is normalised the same way in both executors (`norbital_id ASC` appended as a tiebreaker),
because a keyset cursor over a non-unique sort key is otherwise ambiguous and pages silently drop
or duplicate rows.

### 3.5 Reads are live queries, not cached promises

A `LiveQuery` holds a result set and a dependency set (the collections its SQL touches). When a
diff lands, every live query depending on that collection **re-executes locally** and diffs its
result into the existing reactive array.

Rules that follow, and they are the anti-blink rules:

1. **Never render `undefined` for a query whose family has data.** Changing a filter, sort, page,
   or search term produces a new query key. A new key must _inherit_ the previous result as its
   displayed value until its own result arrives. Blanking the table for one frame and refilling
   it is the blink.
2. **`loading` means "no data has ever been available"**, not "a re-evaluation is in flight". A
   re-evaluation over warm local data resolves in under a millisecond; anything that renders a
   spinner for it is rendering a spinner for nothing.
3. **Do not evict live resources.** An LRU that evicts a resource still mounted in the UI
   guarantees a recreate-with-`undefined` on the next read — a blink caused entirely by the
   cache. Eviction is for unsubscribed resources only.

### 3.5a When the loader appears

One rule: **`loading` means this query has nothing to show.** Not "a request is in flight" — a
query that already has rows never returns to loading, however much work is still happening behind
it.

"This query" is doing the work in that sentence. A new query inherits its first rows from its
**family**, and a family is one *slice* of a collection: same collection, same operation, same
position. Re-shaping that slice inherits; moving to another slice does not.

| what changed | inherits? | what the user sees |
| --- | --- | --- |
| filter, sort, search term | yes — same slice, re-shaped | old rows, then new rows. No blank, no spinner |
| **page** | **no — different records** | **loader, until that page arrives** |
| nothing (revisit) | the resource itself is reused | rows, instantly |

```
FIRST VISIT to a collection
   |
   |-- 0ms ....... nothing local yet
   |-- ~100ms .... loader appears (only while still empty)
   |-- ~1 RTT .... first page: 250 rows            --> LOADER GONE, table renders
   |
   `-- then ...... pages 2..N at 5,000, in the background.
                   Each re-runs the query silently: rows are already on screen, so
                   `current` is never undefined and `loading` is never set again.

PAGING FORWARD to a page not yet held
   |
   |-- new family, nothing inherited              --> LOADER, honestly
   `-- page arrives (local if the catch-up got there first, else one round trip)

REVISIT / REFRESH, or paging back to a page already held
   |
   `-- answered from PGlite                        --> NO LOADER
```

Two bugs this replaced, both of which reported the wrong thing to the user:

- The read awaited the whole first catch-up page at 5,000 rows, so a table of 100 attendance rows
  sat behind tens of thousands the screen was never going to show — a spinner measuring work
  nobody asked for.
- Every variation of a read shared one family, pagination included, so page 3 inherited page 2's
  rows and rendered them under a page-3 heading with no loader at all: data reported as arrived
  when it had not been fetched.

### 3.6 Relations resolve locally

Once collections are the sync unit, the target collection of a relation is already local, so
`with: { customer: true }` is a local join: **one batched lookup per relation, not one query per
row.** Lookup and reference collections — the overwhelming majority of relation targets — are
small after policy scoping and therefore resident, so this is the normal case even when the base
collection is huge.

The pathological shape this replaces: a table of 25 rows × 3 relationship columns issuing 75
independent queries, each with its own cache entry, each racing the others, all thrashing a
fixed-size LRU. That is not a slow relation renderer; it is a missing local join.

**A relation is a uuid, and it renders as one.** Nothing infers that a foreign key should appear
as a labelled record — not the table, not the field metadata, not the target collection. A relation
column shows text, like any other column.

Showing it as a record is an explicit act: mount `RelationshipRenderer` yourself and give it the
option set, at the place that knows what the options should be.

```svelte
<RelationshipRenderer
	target="employments"
	value={row.employment_id}
	options={{
		label: (employment) => employment.employee_number,
		where: { status: { eq: 'active' } },
		filters: ['legal_entity_id']
	}}
/>
```

### 3.7 Boot is warm, not cold

Sync state is persisted **in the replica itself** (`_pod_sync_state`), so a reload is:

1. open PGlite (the tables are already populated),
2. **render from local data immediately** — frame 1, no network,
3. connect the stream at the persisted cursor and apply the delta accumulated while away.

A reload must never re-download a collection it already has.

### 3.8 One cursor, correctly advanced

The feed is ordered by `(xid, seq)` and gated on `pg_snapshot_xmin` so a committed row is only
emitted once no older transaction can still appear — the ordering is stable and gap-free. That
design is right, and the client must not undermine it:

- Diffs carry **both** `xid` and `seq`. A client that only advances `seq` keeps a stale `xid`
  forever and re-plays the entire feed since first connect on every reconnect.
- The catch-up watermark is **per collection**. The stream cursor is the minimum across
  collections. A per-collection fetch must never overwrite a single global cursor — later
  catch-ups would drag it backwards or forwards past changes the client never applied.

### 3.8a The feed is bounded, and says so when it cuts

The change feed is append-only: one row per write, forever. That is what makes sync cheap — a
client says "everything after position N" and gets only what changed — and it is also why the
table would grow for the life of the tenant if nothing removed anything.

Deleting old rows on its own is *worse* than the growth. A client whose cursor points into the
deleted range asks to resume from a position that no longer exists, the server finds nothing after
it, and the client concludes it is up to date. It is not: it has silently and permanently missed
everything that was pruned, and no error is raised anywhere.

So the deletion leaves a mark. `_norbital_sync_compaction.pruned_through_seq` is a durable,
monotonic record of how far the log has been cut:

```
sync_outbox:   [ pruned ............ ] [ 8,421 | 8,422 | ... | 12,004 ]
                                        ^                            ^
                    pruned_through_seq = 8,420              newest change
```

Every resume is then one comparison:

| client cursor | answer |
| --- | --- |
| **above** the boundary | resumable — send the diffs since it |
| **at or below** it | the changes you missed are gone → **reset** |

A reset is `event: reset` on the stream. The client drops its entire local database and rebuilds
from a full download. Expensive, and correct — and it only reaches a device that has been away
longer than the retention window.

The check lives on the stream alone because the stream is the only thing that resumes. `shape`
bootstraps from nothing and has no cursor to be too old.

**Why a stored column and not `min(seq)`.** `min(seq)` works right up until the table is pruned
empty, at which point there is no minimum left and every stale cursor looks valid again. The
boundary has to outlive the rows it describes.

**The settings.** Retention is 7 days, and never below the newest 1,000 rows. Seven days is the
offline budget: away for less, you resume cheaply; away for longer, you rebuild. The row floor
stops a quiet tenant having its whole feed pruned merely because nothing happened for a week. The
sweep runs opportunistically inside `shape` (rate-limited to hourly per runtime), so a tenant
nobody opens costs nothing to keep bounded.

### 3.8b Visibility changes are deltas too

A payroll run's payslips become readable the moment the run is approved — and not one payslip row
is written. The feed carries rows that *changed*, so nothing in it describes them.

The client used to compensate by re-reading collections after every approval. That is a scan
standing in for a delta, and a guess besides: a client cannot know which rows changed side.

The server can. The manifest says which records point at the released one, so on a terminal
approval each of them is announced on the feed. `buildDiff` then re-evaluates each against each
client's own policy and sends `insert` to whoever can now see it and `leave` to whoever cannot.
Ordinary delta sync, no scan, no client-side special case.

### 3.9 Writes are optimistic; the server is still the authority

The write path is unchanged in _authority_: every mutation goes through `collection_ops` on the
server, so permissions, hooks, audit, history, approvals and versioning always apply. What
changes is _when the UI updates_.

```
click ──▶ apply to local overlay ──▶ UI updates (same frame)
             │
             └──▶ POST /sync/mutate ──▶ confirmed: server row replaces overlay
                                    └─▶ rejected:  overlay rolled back, reason surfaced
```

Live queries read `base ⊕ overlay`. Conflicts are detected by `norbital_row_version`, which the
client already has locally, and a rejection carries `currentRow` so the form layer can reconcile.

Offline writes queue in `_pod_pending` and flush on reconnect, before the stream resumes.

### 3.10 There is no invalidation

Worth stating as its own rule, because it is the promise to the author. Nothing in application
code ever calls `invalidate`, `refetch`, or `refresh`. A mutation updates the local replica; live
queries depending on those collections re-execute. A remote mutation arrives as a diff and does
the same thing. Both paths are the same path.

---

## 4. Wire protocol

All under `/_runtime/sync/`, routed before body parsing so `stream` can hold the connection open.

| Route    | Method | Purpose                                                                                                                                                                                                                                                                           |
| -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema` | GET    | Client-applicable DDL, introspected from the live tenant database. Additive and idempotent: `CREATE TABLE IF NOT EXISTS` carrying only the primary key, then one `ADD COLUMN IF NOT EXISTS` per column.                                                                           |
| `shape`  | POST   | One keyset page of a policy-scoped collection. Returns `{rows, nextCursor, watermark, cursor, liveReady, windowComplete}`. Stateless across pages — the client drives the loop and owns its residency cap. First page captures the watermark so the stream resumes without a gap. |
| `stream` | GET    | SSE change feed from `?cursor=`. Emits `{xid, seq, collection, action, id, version, row?}`.                                                                                                                                                                                       |
| `mutate` | POST   | Batch of `{clientId, collection, action, row, version}` through `collection_ops`.                                                                                                                                                                                                 |

**Watermark-before-rows ordering.** `shape` reads the watermark _before_ the rows. A change
committing between the two is present in the page _and_ re-streamed after the watermark; the
client upserts by id, so a double-apply is idempotent. The reverse order could drop it.

---

## 5. Storage

One PGlite per origin, owned by a **SharedWorker** so N tabs share one replica, one catch-up,
and one set of tables.

The failure mode to design against: a worker handshake that times out and falls back to an
in-tab PGlite **on the same data directory**. That is two writers on one VFS. The fallback must
be deterministic and must not share storage with a worker that may still be booting.

Tabs share the replica but each runs its own stream and cursor. Leader election (one tab streams,
others observe) is the next step; until then the replica must tolerate concurrent appliers, which
it does because every diff application is an idempotent upsert-by-id.

---

## 6. Invariants

Checklist for reviewing any change to this engine.

1. No read is answered by the network twice. A server answer is always folded into the replica.
2. The sync unit is the collection. Adding a filter, sort, or page never creates server work
   against a resident collection.
3. A query whose family has data never renders as empty or loading.
4. Sync state survives reload; a warm collection is never re-downloaded.
5. Diffs advance `(xid, seq)` together; per-collection watermarks never clobber the stream cursor.
6. Rows outside policy scope never reach local storage; `leave` evicts them. The client never
   filters for authorization.
7. Mutations are visible locally before the server responds, and roll back on rejection.
8. Nothing calls `invalidate`.
9. One writer per replica.
10. A windowed collection never answers `count`, `search`, a short page, a `findFirst` miss, or a
    to-many relation from local data — each of those would be a wrong answer, not a stale one.
11. Catch-up is bounded and terminates. No page loop may depend on the server offering a cursor
    forever, and no collection may pull more than its residency budget.
12. No leaf component owns a query for data its parent already has. A relation renders as the uuid
    it is unless a surface explicitly mounts `RelationshipRenderer` and supplies its option set.
13. Local SQL orders by the _normalised_ order (`norbital_id` appended), matching the cursor
    encoding — anything else makes keyset pagination unstable across pages.
14. A server-side data reset invalidates the replica. `seq` going backwards is the signal.

---

## 7. Known gaps

Honest list of what this design does not yet do.

- **Local search is substring-only.** The server adds trigram typo tolerance via `pg_trgm`, which
  PGlite does not ship, so a _misspelled_ term matches fewer rows locally than it would on the
  server. Exact and partial matches are identical. Resident collections use local search; anything
  windowed goes to the server, where the trigram indexes are.
- **A windowed collection never gets a local search index.** Absorbing server answers makes the
  _records_ local, not the _index_, so repeated searches stay server round-trips for as long as the
  collection is over budget (§3.3).
- **The residency budget is shared, not per collection.** One huge collection can consume the
  allowance that would have made several small ones resident. That is usually the right trade — the
  small ones are the ones that pay off — but nothing currently prioritises between them.
- **Creates are not optimistic.** `norbital_id` is minted server-side, so an optimistic insert
  would need a temporary id and a rewrite when the real one arrives. Updates and deletes are
  optimistic. Fixing this means letting the client mint the (time-ordered) id.
- **No cross-tab leader election.** Tabs share one replica through the SharedWorker but each runs
  its own stream and cursor, so N tabs mean N SSE connections applying the same diffs. Correct
  (every application is an idempotent upsert-by-id) but wasteful.
- **Counts on windowed collections are a server round-trip per distinct predicate.** They are
  cached per query key and stable across pagination, but a `count` over a million rows is
  expensive server-side. Maintaining counts incrementally from the diff stream is the fix.
- **No live-query dependency tracking.** Re-evaluation is per collection, so a change to any row
  of a collection re-runs every query over it. Cheap locally, but not free at high diff rates.
- **A catch-up is always a full scan.** `shape` bootstraps a collection by keyset-scanning it;
  staying current afterwards is the stream's job (§3.8a), and a client that falls behind the
  compaction boundary rebuilds rather than resuming. That split keeps the two mechanisms
  non-overlapping, at the cost of a cold collection always paying a full download — serving it
  from a compacted snapshot instead of the live table is the improvement not yet made.
- **Visibility deltas are announced for approvals only.** §3.8b fires when an approval releases a
  record. A policy edit that changes who can see what does not announce anything, so clients pick
  it up on their next full catch-up rather than immediately.

---

## Code map

| Layer                    | Location                                       | Files                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client sync state**    | `packages/pod/src/lib/client/sync/`            | `pod-sync-client.ts` (connect, apply diffs, catch-up, mutate), `client-sync.ts` (local query executor), `subscription-registry.ts` (live query registry), `types.ts` (wire types) |
| **Client storage**       | `packages/pod/src/lib/client/sync/`            | `pglite-worker.ts` (SharedWorker PGlite), `pglite-worker-bridge.ts` (postMessage bridge), `browser-bootstrap.ts` (browser-side bootstrap)                                         |
| **Client entry**         | `packages/pod/src/lib/runtime/`                | `client.ts` (browser API proxy), `packages/pod/src/lib/client/remote-query.svelte.ts` (remote query transport)                                                                    |
| **Server wire protocol** | `packages/pod/src/lib/server/collection/sync/` | `sync-endpoints.server.ts` (schema, shape, stream, mutate dispatch), `sync-outbox.server.ts` (change feed append), `outbox-tailer.server.ts` (cursor management)                  |
| **Server authority**     | `packages/pod/src/lib/server/collection/sync/` | `mutation-rejection.server.ts` (rejection detection), `db-notifications.server.ts` (PostgreSQL NOTIFY/LISTEN)                                                                     |

Tests: `packages/pod/tests/sync/` — `pod-sync-p0.test.ts`, `pod-sync-client.test.ts`, `sync-e2e-comprehensive.test.ts`, `sync-e2e.test.ts`, `sync-http-e2e.test.ts`, `client-sync.test.ts`, `mutation-rejection.test.ts`.
