# Collections

Collections have one server-authoritative read path and one mutation lifecycle. Browser writes,
authored code, agents, imports, approvals, hooks, history, embeddings, change events, and live-query
capture all meet at the same runtime service; none owns a parallel row model or write engine.

Source: `src/runtime/collections/`, with access decisions in `src/runtime/access/` and approval state
in `src/runtime/approvals/`.

## Reads

The shared query input supports `where`, `orderBy`, `limit`, `with`, root `columns`, explicit
`search`, and seek cursor `after`. PostgreSQL evaluates predicates and ordering under the effective
subject's read policy. Relation loading uses the same compiled relationship truth, and field masks
apply to the projected answer rather than changing predicate meaning.

- Cursors encode the prior row's ordering tuple; there is no offset pagination.
- Lexical search is opt-in per field with `search: true`.
- Semantic search performs one embedding request, then one policy-filtered nearest-neighbour query.
- `findNearest` is a server operation. The browser does not accept arbitrary vectors.
- Grouped reads are exact, server-side, and bounded; they are not recomputed from a browser page.
- History reconstruction happens before policy masking, so a field mask cannot change patch meaning.

Live prefixes versus one-shot reads, and the keyed-delta / reset wake, are documented in
[P4 Sync engine](../pillars/04-sync-engine/README.md).

## Mutation lifecycle

```text
declarative root + included relations
  │
  ├─ PREPARE  decode, discover the desired graph, run prepare/before hooks,
  │           read prior rows, check versions, policy and approval requirements
  ├─ GATE     continue immediately or persist one pending approval
  ├─ COMMIT   lock, recheck invariants, write the graph, history, audit,
  │           browser outcome and sync capture in one transaction
  └─ SETTLE   after-hooks, change events, embeddings and host sync handoff
```

An included `cascade(...)`-owned many relationship is complete desired state: submitted children are
inserted or updated, stored children omitted from that included relationship are deleted through
the same walk a parent delete uses, and `[]` deletes every owned child. Omitting a stored child from
an included relationship the parent does not own is refused. An omitted relationship key is
untouched. Unlinking is a write to the child's foreign key, not an omission. Nested graph writes and
cascading deletes are bounded to eight levels.

Authored hooks have five explicit sites: `mutate.prepare`, `mutate.before`, `mutate.after`,
`delete.before`, and `delete.after`. A before refusal commits no domain write. An after refusal names
that the write already committed; it is never flattened into the same failure as a preparation
refusal. Hook-triggered writes use the same service and have an eight-level nesting guard.

## Approval and idempotency

Approval is a mutation gate, not a second write path. PREPARE records the exact proposed operation;
an approval decision either resumes that operation through `collections.resume` or settles it
without publishing provisional values. Existing rows may carry `approval_id` while held so a
conflicting write cannot pass. See [approvals](../access/approvals.md).

Browser mutations are keyed by tenant, environment, principal, effective authority, command, and
idempotency key. The durable outcome distinguishes committed, pending approval, version conflict,
rejected, and quarantined work. Reusing a key with different canonical input is refused. A matching
schema transition may rebase; an uninterpretable release mismatch stays quarantined rather than
being reported saved.

## Side effects and durable evidence

- History records create, update, and delete revisions; its default projected horizon is 256.
- Audit joins data writes, browser outcomes, and approval decisions without inventing a second
  mutation history.
- Change events are emitted from committed graph coordinates.
- Record embeddings are refreshed after writes and claimed in bounded batches of at most 512.
- Sync change capture is part of COMMIT. Host handoff happens during SETTLE and cannot change whether
  the database transaction committed.

The database remains the only durable row truth. Browser optimistic state and live-query registries
are projections with explicit settlement and reconnect behavior, never replicas.
