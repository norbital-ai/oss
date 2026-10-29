# Store

Store declares data and emits SQL. A host owns its connections, transactions, batching and prepared statements.
Data compilers return Effects with a tagged `StoreError`; no driver is installed by Store.
`postgresMaintenance` supplies fixed, prepared catalog and database-administration programs, with quoted
identifiers and separate value parameters. `destroyNamespace` compiles an explicit factory reset of a dedicated
namespace, including objects from old declarations. These programs accept structured arguments; there is no
custom-SQL statement constructor on `store`.

`@norbital-ai/store/sqlserver` owns structured external database programs. `SqlServerRequest` decodes
qualified reads, bound values/procedure arguments, CDC metadata/pages and immutable submissions;
`compileSqlServer` returns the host's TDS statement or native procedure RPC, with bound parameters. It installs no driver. CDC projections
declare key/columns, filters, decimal/date formats and a native delete policy. Their cursor fixes the inclusive
LSN range and orders sequence, operation and key. `insertOnce` compiles the key/fingerprint checks, transaction
lock, UUID header, typed XML children, optional approval procedure and exact receipt together; the host must run
that program serializably. XML attributes use singleton paths required by SQL Server's
[value method](https://learn.microsoft.com/sql/t-sql/xml/value-method-xml-data-type).
External table contracts describe vendor-owned data; workspace-owned PostgreSQL schema and migrations use
the declarations below.

```ts
import { schema, store, table } from '@norbital-ai/store';

const records = schema({
	company: table({ key: 'text', fields: { name: { kind: 'text' } } }),
	person: table({
		fields: {
			name: { kind: 'text' },
			company: { kind: 'ref', to: 'company', inverse: 'people' },
			address: { kind: 'object', fields: { city: { kind: 'text' } } }
		}
	})
});
const db = store(records);

const statement =
	yield *
	db.read('person', {
		where: { address: { city: 'Seoul' } },
		select: { name: true },
		with: { company: { select: { name: true } } },
		limit: 50
	});
const rows = yield * execute(statement.sql);
const page = yield * statement.decode(rows);
```

This is the standalone store's own read form over a whole schema. Bolt never sends it: its one read is a read
request (`query({ person: { … }, 'person.company': { fields: ['name'] } })`), which Bolt lowers to this IR with the
catalog's read layers of the output the root names. A scoped read (a `Scope`) nests only that output's layers, each
scoped by its root's arms for that output and path (`Scope.rows(path, output)`); a `where` may still cross any relation
into a model the reader reads, through that model's own access point.

`statement.shape` is a stable hash of SQL text for the host's prepared cache. Parameters remain separate.
The result type follows the literal projection, with the primary key included. One nested read emits one statement;
relations use bounded correlated subqueries. Ordinary refs, inverses, self refs, join tables and polymorphic refs use
the same query language. A polymorphic ref stores one nullable foreign-key column per target. Its `with` arm can name
each target's own `select` and `with`, and the result discriminates them by `model`.

`store.read` accepts `firstPer: ['group_column']` to select one matching row per group. Group columns lead
the result order; `orderBy` chooses the row within each group, with primary keys breaking ties. PostgreSQL
selects each group's first row before applying the cursor, so older rows cannot reappear on later pages.
Filtering, projections, relation bounds and page byte limits still apply. Group columns must be sortable
and readable; this option cannot be combined with search ranking.

Inline `object`, `list` and shaped `json` fields store as jsonb. Their declared scalar paths can filter, sort and use
expression indexes. Updates accept deep `$patch` for objects and `$append` / `$remove` for lists. The field's codec
validates values at the boundary. Decimal, date and instant values decode through the shared kind codecs.

Tables may use UUID, text, identity or declared composite primary keys. Audit columns are opt in. An `int` uses
PostgreSQL integer storage; `storage: 'int64'` selects bigint. A `number` uses double precision. `indexes.on` accepts
field names, `{ lower: field }` and `{ expr: expression }`.

Updates and upserts accept `now: ['ready_at']` for declared instant fields. The database assigns `now()` inside
the write; the caller supplies no timestamp. An update can use an empty `set` for a clock-only change. An upsert
applies this option only on conflict, preserving the insert's explicit values or declared defaults. It cannot
combine clock assignment with `update: 'keep'` or assign the same field through both `set` and `now`. State edit
locks, conditional writes and observed revisions still apply; keys, computed fields and managed audit columns
cannot be assigned this way.

Host queries also use declared fields and values. `related` resolves an explicit scalar join in one statement;
`union` selects distinct field values across declared sources. `updateMany` makes one set-based scalar update,
with an independent key and optional pre-image fence for each candidate. Stateful tables continue to use guarded
`update` operations in a transaction. Deletion can `keep` the first rows in a declared order or require a joined
record to be `absent`. These operations accept no SQL strings or caller-created statements.

Upserts can `merge: { value: 'add' }` or `'max'` inside the native conflict update. A single primary-key candidate
can declare `limits: [{ by: ['tenant'], sum: 'bytes', max: 1024 }]`; the database checks the group's sum with that
candidate replacing its prior value. The executor must serialize group writers before the statement's snapshot,
using a host advisory lock or a serializable transaction. An unchanged retry should be resolved before admission.

`rollup` summarizes floating-point measurements: it sums sources at each instant before calculating bucket peaks,
totals and the last reading. `latestPer` sums each source's newest gauge; `carry` produces bounded time steps while
retaining each source's latest value, including zero. Group keys and results retain their declared types. Decimal
financial data continues to use exact decimal aggregates. Text predicates support `folded` and `digits` matching;
instant predicates support `olderThan` against the database clock.

Foreign keys restrict parent deletion by default. `owned: true` defaults to database cascade; an explicit
`onDelete` selects `cascade`, `restrict`, or `setNull` (which requires an optional ref). These rules apply to plain
and audited tables. A database update that leaves an audited row's incoming revision unchanged advances its revision
and timestamp and clears its unknown `updated_by` actor; explicit Store updates advance the revision once.
This includes a foreign key setting its child reference to null, so a previously observed revision becomes stale.
Primary keys are immutable, including direct SQL updates; foreign keys explicitly use `ON UPDATE RESTRICT`.
`SET DEFAULT` and mutable referenced keys are not supported. Current constructors stamp an internal physical-schema
version; historical snapshots retain their original definitions and are upgraded with a new migration.

Native primary/foreign keys, required columns, enum membership, uniqueness, checks and exclusions reject invalid
direct SQL. Native row triggers enforce state initialization, transitions and edit locks, immutable primary keys
and creation metadata, and monotonic audited revisions. Owned inverse and through-relation writes lock and check
their parent's state. `SET NULL` must also satisfy the affected child's other constraints and state edit policy.
Shaped JSON, objects, lists, records, unions and file handles use a recursive schema-derived SQL validator, including
nested required/optional/defaulted members, list bounds and discriminated union tags. Bare JSON accepts any JSON
value. File MIME/size hints cannot authenticate stored bytes, and target-selection `ref.where` policies remain host
validation. Arbitrary business callbacks and caller authorization remain host responsibilities. Nested instants
support canonical UTC wire values and ordinary ISO forms; the database does not reproduce JavaScript's entire
permissive `Date.parse` language.

## Append-only logs

`AppendOnlyLogSpec` declares a dedicated namespace, scope, JSON envelope, indexed paths, pending-operation
matching and bounded retention. `logDdl` compiles its native checks, generated search document/payload size,
indexes and immutable programs. `logStatements` compiles scoped append/search/detail/recovery and maintenance
operations. Identical retries succeed; changed content under one id refuses the entire append. Scoped logs keep
durable retirement tombstones and protect maintenance with a private backend/transaction capability.

Hosts keep these payloads in a separate database. Bolt supplies its audit envelope through `auditLogSpec`;
both standalone adapters and managed hosts use Store's compiled operations. Retention follows native wall-clock
recording time, independently of an event's occurrence time.

Log migrations have their own decoded snapshot and native/security inspection, rather than an empty relational
schema. `verifyLog` compares independent history replay with fresh declaration compilation and records every
prefix. Inspection includes namespace/table/column/routine privileges and extension placement. An existing
layout can be adopted only when its entire native/security prefix matches; adoption records a receipt without
recreating tables or reactivating retired scopes. A later migration installs new checks without validating old
rows, then a separate transaction validates them while permitting ordinary reads and writes.

## Migrations

`generate(previous, next, { number, name })` returns an editable SQL file and canonical `snapshot.json`. Its step
comments name additive, rename, backfill, validating and destructive changes. A destructive block requires its
explicit `-- accept: <step>` line. `was` on a table or field emits a rename and preserves data. Inline shape changes
leave a data step for an authored transform followed by a row-count validation.

The host replays all files on a scratch database, builds the declared schema on another, and passes the two
`INTROSPECT` results to `verify`. The resulting `migrations.lock.json` records every SQL checksum and the snapshot
checksum. Commit the SQL files, snapshot and lock together. Editing a file requires replay verification again.

At application time `pending` validates the lock and the database's applied prefix. The host runs each pending file
and `recordApplied(file)` in one transaction. Once applied, a file's text is immutable; subsequent changes belong in
the next file. Store supplies the format and SQL; the host owns scratch databases, file I/O and execution.

Bolt's `bolt build` creates or extends the workspace's `migrations/` directory and verifies it. `bolt check` verifies
an existing history. The artifact includes the verified files in its digest. A host applies those files before
activation. A host's control store uses the same declarations and file format with its own native connections.

A standalone Store state field supplies an `initial` value and declared `to` transitions. Normal creates begin in
that initial state. Updates lock their matched rows, check the actual changed fields against the current state's
`edit` policy, and admit only a declared transition. A refused row prevents the entire update statement from
mutating any matched row. Restating an unchanged value does not count as an edit. Stateful upserts support
`update: 'keep'`; mutating conflict policies return a typed admission error and require an explicit transactional
create/update workflow. Native hosts transport a private transaction-local `store.write` context for seed and
approval restoration. Those modes may cross ordinary state edges and edit locks; primary keys, ordinary constraints
and increasing update revisions still apply. This context transports trusted engine intent and actor metadata;
it does not authenticate a database owner, who already controls SQL and schema definitions.

`migrationStatus` validates the source lock, distinguishes original and squash histories, and reports applied and
pending files. When given actual introspection lines, it compares them with the last executed file's physical proof;
checksum agreement alone does not excuse an extra or missing column. A host records a proof for every replayed
prefix and checks the actual prefix before and after applying each file. `migrationGuard` compiles exact ledger
and physical-definition checks for the host's prepared atomic batch. Concurrent schema observation also needs
the host's migration lock; filtering malformed catalog rows would conceal drift. `INTROSPECT` includes noninternal triggers
and function overload identities; extension-owned implementation definitions are excluded, with extension names
retained. These proofs assume the same schema namespace used by scratch replay (Bolt uses `public`).
`physicalDefinitionsOf` serializes shared native definitions once across prefixes;
`readPhysicalDefinitions` expands the indexed file or an existing unindexed proof. Prefix hashes still cover the
exact expanded definitions. Invalid references and changed definitions are refused before migration execution.

A safe widening from integer to bigint or numeric uses `ALTER COLUMN TYPE` and preserves rows. Other unsupported
or narrowing changes retain explicit destructive/manual handling. Statement risk metadata exposes exclusive locks,
blocked writes, validation scans, index rebuilds and possible rewrites. Ordinary indexes and per-file atomic DDL
cannot promise zero downtime. Bolt bounds lock waits to five seconds and rolls back on refusal; retry after removing
the blocker. `CONCURRENTLY` index operations and transaction-control statements are refused inside atomic files.
For larger changes, use expand/backfill/contract releases; externally coordinated online index creation is outside
this atomic file workflow.

`generateSquash` creates an alternative baseline for an exact original prefix. The host verifies the original and
baseline replays against the same physical schema, retains the original SQL and checksums, and supplies both to
`pending`. A fresh ledger chooses the longest verified baseline. A partially or fully migrated original history
continues its exact original suffix; an older baseline continues the suffix after its own cutoff. No applied ledger
record is rewritten. Data transformations, row-creating histories, and unproved sequence operations cannot be
replaced by a schema-only baseline. Bolt exposes this as `bolt build --squash=<name>` and commits retained originals
under `migrations/archive/`, alternatives under `migrations/squashes/`, and their receipts in the same lock.

The focused acceptance coverage is kept with its owner:

| Behavior                                                               | Edge case coverage                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Related entities, locality, one statement and indexed lookup plans     | `tests/read.test.ts`, `tests/explain.test.ts`                                  |
| Cascade, restrict, optional set-null and audited stale revisions       | `tests/delete.test.ts`                                                         |
| Initial states, transition/edit guards and atomic refusal              | `tests/state.test.ts`, `tests/schema-validation.test.ts`                       |
| Direct SQL constraints, immutable keys, state and audit rules          | `tests/native-invariants.test.ts`                                              |
| Persisted JSON structures and codec null/default/union parity          | `tests/json-invariants.test.ts`                                                |
| Literal projections, paths, references, aggregates and rejected inputs | `tests/types.test.ts`, `tests/value-types.test.ts`                             |
| Preserved rows on safe widening and operational risks                  | `tests/planning.test.ts`                                                       |
| Edited SQL/source mismatch and live drift refusal                      | Bolt `tests/migrations.integration.test.ts`                                    |
| Immutable squash receipts, partial histories and repeated squashes     | `tests/migration-history.test.ts`, Bolt `tests/migrations.integration.test.ts` |
| Native PostgreSQL parameter parity for JSON, arrays and relations      | Deployed Neon acceptance (not a local suite)                                   |
