# RFC: first-class polymorphic references in Bolt models

- **Status:** Accepted; forward-reference v1 implemented
- **Scope:** `@norbital-ai/bolt` authoring, schema compilation, collection runtime, generated
  workspace types, and the HR Payroll template
- **Primary implementation target:** PostgreSQL and PGlite
- **Drizzle baseline:** `drizzle-orm` and `drizzle-kit` `1.0.0-rc.4`

The implemented v1 covers the logical handle, exclusive-arc DDL, direct foreign keys, partial
indexes, compound-index expansion, read/write/replica codecs, logical filters, and batched
access-controlled forward hydration. Explicit inverse `via` declarations, reference-valued authored
row-scope predicates, deferred cyclic foreign keys, and logical constraint-error translation remain
follow-up work; they are retained below as the full proposal rather than being implied to exist
already.

## Decision

Bolt should add a first-class `reference()` field builder to `defineModel`.

An authored reference is one logical field whose value is a closed discriminated union. It must not
appear to application code as one nullable property per possible target.

```ts
import { defineModel, reference, text, uuid } from '@norbital-ai/bolt/authoring';

export default defineModel({
	payslip_id: uuid().notNull(),
	source: reference({
		TIME_ENTRY: 'time_entries',
		LEAVE_REQUEST: 'leave_requests'
	})
		.notNull()
		.unique(),
	period: text().notNull()
});
```

The compiler should lower that one logical field to an **exclusive arc**: one hidden UUID column and
one real foreign key for each allowed target, plus a check constraint that permits exactly one arm
for a required reference or at most one arm for an optional reference.

The reference itself declares the forward relationship. Authors should only use
`src/collections/+relationship.ts` when they want a named inverse traversal, a through relation, or
another relationship that cannot be inferred from a stored field.

This is intentionally a closed-set feature. A field cannot point to an arbitrary collection name.
To-many relationships and relationship records with their own attributes remain explicit edge
collections.

## Why Drizzle's RC support is not the complete solution

Drizzle RC has useful pieces that Bolt should build on, but it does not provide the model field
described by this RFC.

- Drizzle's relations documentation says that predefined relation `where` clauses are “a type of
  polymorphic relations implementation,” and immediately qualifies that they are not a full
  implementation. They define filtered query paths; they do not define one polymorphic field.
- Drizzle relations are application/query metadata and do not create database foreign keys.
- Drizzle's relations fundamentals show the conventional `type` plus `id` layout and explicitly note
  that standard SQL cannot directly enforce a foreign key from that pair to several unrelated
  tables.

Those capabilities can help generate target-specific query paths under Bolt, but Bolt still owns the
logical value, exact TypeScript inference, physical constraints, codecs, access-controlled hydration,
and migrations.

The common alternatives establish the design space:

| Strategy                               | Integrity                              | Per-row storage                                  | Main problem for Bolt                                                        |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `target_type` + `target_id`            | Application only                       | Compact                                          | No real target foreign key; type values can drift on rename                  |
| JSONB union + generated target columns | Real target FKs                        | JSONB plus one duplicated UUID                   | Enforceable, but duplicates state and requires handwritten projections       |
| Universal record registry              | One FK to a registry row               | Compact reference plus a registry row per target | Adds write amplification and registry lifecycle to every referenceable model |
| PostgreSQL table inheritance           | Incomplete                             | Varies                                           | PostgreSQL does not extend uniqueness/FKs across an inheritance hierarchy    |
| Exclusive arc                          | Real FK per target and exact-one check | One UUID value; other arms are null              | Adds schema columns as the closed target set grows                           |

For the small, closed unions Bolt can type statically, the exclusive arc gives the best trade-off. It
does not duplicate the ID, does not add a global registry write, and uses ordinary PostgreSQL
constraints and indexes. A very large or open target set is not the same abstraction and should not
silently receive weaker guarantees.

## Goals and non-goals

### Goals

1. One authored field and one returned property.
2. An exact discriminated union on insert, update, select, filters, and hydrated results.
3. Database enforcement that the selected target exists and is one of the declared collections.
4. Automatic physical columns, checks, foreign keys, indexes, codecs, and forward query metadata.
5. Access-controlled, batched hydration without an N+1 query pattern.
6. Explicit and predictable behavior for optional references, uniqueness, deletion, aliases, and
   target-set changes.

### Non-goals

1. An open-ended `{ collection: string, id: string }` pointer.
2. Cross-database or external-service referential integrity.
3. Arrays of foreign IDs inside one field. Those require an edge collection.
4. Treating every tagged business value as a polymorphic reference. A value that can refer to zero,
   one, or several records is a structured variant, not one reference.
5. Automatically hydrating every reference on every read.

## 1. Authoring surface

### 1.1 Declaration

The recommended form maps stable domain tags to collection names:

```ts
source: reference({
	TIME_ENTRY: 'time_entries',
	LEAVE_REQUEST: 'leave_requests'
});
```

The object must satisfy all of these rules at sync time:

- It contains at least two targets for the initial polymorphic release.
- Every target is a generated `CollectionName`.
- Tags are unique and valid stable identifiers.
- A target collection appears only once in a reference. If two semantic roles point to the same
  collection, they are two fields or a higher-level variant, not two arms of one reference.
- Every target uses the platform system UUID `id`. Composite and non-system keys are out of scope.

The implemented fluent modifiers are:

```ts
reference(targets).onDelete('restrict').notNull().unique();
```

- References are optional unless `.notNull()` is present.
- `onDelete` defaults to `restrict`. `cascade` is opt-in and should mean genuine ownership.
- `set null` is allowed only on an optional reference.
- `.unique()` means a concrete target row may be referenced by at most one row of this collection.
  It compiles to one partial unique index per arm.

Per-arm delete behavior is not part of v1. If arms have different ownership semantics, the model is
usually combining different relationships under one field. We can add an arm override later without
changing the logical value shape.

### 1.2 Insert and update values

The write value is one atomic discriminated union:

```ts
type PayslipSourceReference =
	| { readonly kind: 'TIME_ENTRY'; readonly id: string }
	| { readonly kind: 'LEAVE_REQUEST'; readonly id: string };
```

```ts
await api.db.mutation.payslip_sources.create({
	payslip_id,
	source: { kind: 'TIME_ENTRY', id: timeEntry.id },
	period
});
```

An update replaces `source` atomically. Authors cannot patch `source.kind` and `source.id`
independently, which prevents transient or persistent mixed states.

The generated insert type rejects an unknown kind, a missing ID, multiple target properties, and a
bare UUID. An optional reference additionally accepts `null` or omission according to the existing
insert rules.

### 1.3 Select values

Without `with`, a select returns the handle and performs no target query:

```ts
const claim = await api.db.query.payslip_sources.findFirst();

claim?.source;
// | { kind: 'TIME_ENTRY'; id: string }
// | { kind: 'LEAVE_REQUEST'; id: string }
```

Hydration stays under the same property:

```ts
const claim = await api.db.query.payslip_sources.findFirst({
	with: { source: true }
});

claim?.source;
// | { kind: 'TIME_ENTRY'; id: string; record: TimeEntryRow | null }
// | { kind: 'LEAVE_REQUEST'; id: string; record: LeaveRequestRow | null }
```

`record` is nullable even for a required database reference because target-row read policy and field
masking still apply. A foreign key proves existence; it does not grant the caller permission to see
the target. The runtime must never bypass target access control merely because the source row is
readable.

Target-specific projections preserve an exact union:

```ts
const claim = await api.db.query.payslip_sources.findFirst({
	with: {
		source: {
			TIME_ENTRY: { columns: { entry_date: true, duration: true } },
			LEAVE_REQUEST: { columns: { start_date: true, end_date: true } }
		}
	}
});
```

The result still has one `source` property. It must never become sibling
`sourceTimeEntry`/`sourceLeaveRequest` properties.

### 1.4 Filters

Reference filters operate on logical handles and compile directly to one or more arm columns:

```ts
where: {
	source: { eq: { kind: 'TIME_ENTRY', id: timeEntryId } }
}
```

```ts
where: {
	source: {
		in: [
			{ kind: 'TIME_ENTRY', id: timeEntryId },
			{ kind: 'LEAVE_REQUEST', id: leaveRequestId }
		]
	}
}
```

```ts
where: {
	source: {
		kind: {
			eq: 'TIME_ENTRY';
		}
	}
}
```

`isNull` and `isNotNull` are available for optional references. An ID without a kind is deliberately
not a valid equality operand because UUID equality does not identify a target collection.

### 1.5 Relationship declarations

No relationship-side declaration is required for the forward path:

```ts
with: { source: true }
```

No inverse authoring API is exposed in v1. Reverse lookup uses the logical reference filter:

```ts
await api.db.query.payslip_sources.findMany({
	where: { source: { eq: { kind: 'TIME_ENTRY', id: timeEntryId } } }
});
```

A later inverse API may add an explicit `via` declaration. It must validate that the reference
contains the enclosing target and require distinct names when multiple fields connect the same
collections; v1 does not accept or silently ignore that syntax.

Many-to-many remains an edge model:

```ts
// One line can cite many source records and one source can explain many lines.
export default defineModel(
	{
		payslip_line_id: uuid().notNull(),
		source: reference({
			TIME_ENTRY: 'time_entries',
			LEAVE_REQUEST: 'leave_requests'
		}).notNull()
	},
	{
		indexes: [{ columns: ['payslip_line_id', 'source'], unique: true }]
	}
);
```

When an authored compound index includes a polymorphic field, the compiler expands it once per arm.
The example produces one partial unique index for a line/time-entry pair and one for a
line/leave-request pair.

## 2. How it works under the hood

### 2.1 Authoring and generated types

`ModelDeclaration` changes from a map of only `AnyPgColumnBuilder` values to a map of model field
builders:

```ts
type AnyModelFieldBuilder = AnyPgColumnBuilder | AnyReferenceBuilder;
```

`ReferenceBuilder` carries its targets, nullability, uniqueness, delete action, and deferrability as
literal type metadata. `TablesForModels` maps it to a handle union instead of asking Drizzle for a
single column's data type. Query inference replaces that handle with the hydrated union only when
`with.source` is requested.

The generated workspace augmentation knows the complete collection-name union and table row map, so
hydrated arms resolve to their exact target row types without importing one model file into another.
The migration compiler rejects a target that is not a collection in the workspace.

### 2.2 Catalog representation

`FieldDefinition.type` identifies references directly instead of disguising them as JSON. The
reference-specific metadata contains only facts that are not already field-level facts:

```ts
interface FieldDefinition {
	readonly type: 'reference';
	readonly required: boolean;
	readonly unique: boolean;
	readonly reference: {
		readonly onDelete: 'restrict' | 'cascade' | 'set null';
		readonly targets: ReadonlyArray<{
			readonly tag: string;
			readonly collection: string;
			readonly storageColumn: string;
		}>;
	};
}
```

This catalog entry is the single source for the migration schema, runtime codec, where compiler,
prefetcher, generated contract, UI metadata, access field names, and inverse-relation validation.

### 2.3 Physical schema

The payroll declaration compiles conceptually to:

```sql
CREATE TABLE payslip_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payslip_id uuid NOT NULL,
  source__time_entry_id uuid,
  source__leave_request_id uuid,
  period text NOT NULL,

  CONSTRAINT payslip_sources_source_exactly_one_ck
    CHECK (num_nonnulls(source__time_entry_id, source__leave_request_id) = 1),

  CONSTRAINT payslip_sources_source_time_entry_fk
    FOREIGN KEY (source__time_entry_id)
    REFERENCES time_entries(id)
    ON DELETE RESTRICT,

  CONSTRAINT payslip_sources_source_leave_request_fk
    FOREIGN KEY (source__leave_request_id)
    REFERENCES leave_requests(id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX payslip_sources_source_time_entry_uidx
  ON payslip_sources (source__time_entry_id)
  WHERE source__time_entry_id IS NOT NULL;

CREATE UNIQUE INDEX payslip_sources_source_leave_request_uidx
  ON payslip_sources (source__leave_request_id)
  WHERE source__leave_request_id IS NOT NULL;
```

For an optional reference, the check is `num_nonnulls(...) <= 1`. A normal reference gets partial
non-unique indexes instead of the two unique indexes above.

The storage column is derived from the stable tag rather than the target table name. Changing a
collection name therefore updates the FK target without changing the logical tag or rewriting every
reference value. Identifiers longer than PostgreSQL's limit use the existing stable shortening/hash
convention.

The hidden columns are migration and database details. They are excluded from generated row types,
mutation inputs, field policy names, forms, representations, serialized API values, and replicated
logical rows.

### 2.4 Write path

The collection runtime validates and authorizes the logical row first, then encodes a reference
immediately before constructing SQL:

```ts
{ source: { kind: 'TIME_ENTRY', id } }

// becomes
{
	source__time_entry_id: id,
	source__leave_request_id: null
}
```

All arms are assigned in the same insert/update statement. That makes kind changes atomic and lets
the check constraint guard raw SQL writers as well as Bolt. Hooks and policies only see `source`.

Logical constraint-error translation remains follow-up work. Until then, PostgreSQL still enforces
the invariant, but a violation can surface a generated constraint or storage-column name.

### 2.5 Read path

Raw rows are decoded before field masking and before they cross a public runtime boundary:

```ts
{
	source__time_entry_id: id,
	source__leave_request_id: null
}

// becomes
{ source: { kind: 'TIME_ENTRY', id } }
```

Zero non-null arms on a required field or multiple non-null arms are integrity faults, not values to
guess at. The runtime should report them with the collection, field, and record ID.

### 2.6 Hydration and access control

`attachRelations` is the right runtime extension point. For every requested reference it should:

1. Decode handles and group them by target tag.
2. Deduplicate target IDs within each group.
3. Issue one authorized `findMany` per target kind actually present, in parallel where safe.
4. Re-associate records by ID while preserving input order.
5. Return `record: null` where the caller cannot read the target.

This is `1 + K` queries for a page, where `K` is the number of target kinds present, not `1 + N`
queries for `N` rows. It reuses collection access predicates and masks instead of joining around
them.

### 2.7 Drizzle integration

Drizzle remains responsible for the physical tables, columns, ordinary foreign keys/indexes, SQL
expressions, and schema snapshots. Bolt is responsible for expanding one logical field into those
physical Drizzle objects and for keeping the physical columns out of the public model shape.

Drizzle relation-level filters may be emitted internally for inverse paths, but they are not the
source of truth. The reference catalog is, because it also drives schema integrity and exact types.

## 3. HR Payroll baseline

### 3.1 `payslip_sources.source`

This is a true singular polymorphic reference: every row consumes exactly one time entry or exactly
one leave request. The greenfield model declares that fact directly:

```ts
source: reference({
	TIME_ENTRY: 'time_entries',
	LEAVE_REQUEST: 'leave_requests'
})
	.notNull()
	.unique();
```

There is no custom datatype, authored projection column, target-side relationship declaration, or
compatibility write path. Settlement code reads and writes only the logical handle:

```ts
const claim =
	yield *
	api.db.query.payslip_sources.findFirst({
		where: {
			source: { eq: { kind: 'TIME_ENTRY', id: existing.id } }
		},
		columns: { period: true }
	});
```

`claims.ts` and persistence should converge on the inferred reference handle:

```ts
{ kind: 'TIME_ENTRY', id: timeEntry.id }
{ kind: 'LEAVE_REQUEST', id: leaveRequest.id }
```

The baseline enforces:

- One concrete attendance/leave row can be claimed once because `.unique()` expands per arm.
- One payslip can own many source rows.
- Deleting a draft payroll run still cascades through payslips to source rows via the ordinary
  `payslip_id` ownership relation.
- Deleting a claimed time entry or leave request is restricted by the source FK.

### 3.2 `payslip_lines.component`: do not misclassify it

`payslip_lines.component` is not one polymorphic reference. Its arms currently include:

- one pay-component reference;
- a pay-component **and** component-entry reference;
- a pay-component **and** repayment-agreement reference plus an instalment sequence;
- one statutory-contribution reference plus calculation evidence;
- no collection reference for derived overtime bands; or
- a pay-component plus an array of unpaid-leave request IDs.

Replacing this field with `reference([...])` would lose information and weaken the model. Keep the
strict custom tagged value and its database projections.

There is one integrity gap worth fixing separately: `leave_request_ids` is a to-many relationship
inside JSON and therefore cannot have a real foreign key. If line-level leave provenance is required,
move it to an edge collection such as `payslip_line_sources` (preferably linking a line to the
corresponding consumed `payslip_source` row). Give the edge ordinary FKs and a unique pair. Do not add
an array mode to `reference()`.

The repetitive generated projections inside tagged custom values motivate a separate
`structured()`/variant-field RFC. That feature can let structured arms declare zero, one, or several
nested reference slots and compile their projections automatically. It should not be smuggled into
the semantics of a singular polymorphic reference.

## 4. Default optimization

### 4.1 Storage and indexes

- The ID is stored exactly once. Null arms consume a null-bitmap bit rather than a UUID payload.
- Every non-unique arm receives a partial B-tree index because PostgreSQL does not automatically
  index referencing FK columns and reverse lookup/delete checks need it.
- `.unique()` emits a partial unique B-tree per arm and does not also emit a redundant normal index.
- Equality filters compile to the one relevant UUID column, with no JSON extraction and no
  discriminator scan.
- `kind` filters compile to `arm_column IS NOT NULL` and use the partial index when selective.
- Target hydration uses the target table's primary-key index.
- Compound logical indexes expand per arm with the arm predicate; they never build one mostly-null
  wide index.

### 4.2 Query behavior

- References are not hydrated unless requested.
- Handles are decoded from the base row without another query.
- Hydration batches and deduplicates IDs by the kinds present on the page.
- Target batches can run concurrently, subject to the existing runtime's connection and Effect
  concurrency limits.
- Hidden arm columns are stripped before rows cross the public runtime or replica boundary.
- The query cache key includes the logical reference projection, not physical column names.

### 4.3 Guardrails

- Do not silently switch a large reference to application-only integrity or a registry-backed
  representation. Storage semantics must be explicit and stable across releases.
- Require an explicit edge model for to-many.
- Reject `.notNull()` plus `onDelete: 'set null'`.
- Reject duplicate targets, unknown targets, and non-system target keys at sync time.

## Edge-case matrix

| Case                                                | Contract                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Required to-one                                     | Exactly one arm non-null; target FK enforced                                                   |
| Optional to-one                                     | Zero or one arm non-null                                                                       |
| One-to-one                                          | `.unique()` creates one partial unique index per arm                                           |
| Self-reference                                      | Supported; the arm FK references the owning table                                              |
| Cyclic required references                          | Unsupported in v1; deferred reference constraints require a later explicit API                 |
| Multiple polymorphic fields between the same models | Supported; each logical field owns an independent exclusive arc                                |
| Target deleted                                      | Restrict by default; cascade opt-in; set-null only if optional                                 |
| Target not readable                                 | Handle remains subject to source-field policy; hydrated `record` is `null`                     |
| Target kind changes                                 | One atomic update clears old arm and sets new arm                                              |
| Add a target                                        | Add arm column/FK/index and replace the arm-count check                                        |
| Remove a target                                     | Destructive migration drops its FK/index/column and replaces the arm-count check               |
| Rename a target collection                          | Stable domain tag/column remains; migrate the FK target and generated type                     |
| Rename a tag                                        | Breaking API/storage rename; requires an explicit migration                                    |
| Same UUID exists in two target tables               | They are distinct references because kind is part of identity                                  |
| Many-to-many                                        | Explicit edge collection; never an ID array                                                    |
| Open/plugin-defined target set                      | Unsupported by this field; requires a separately designed registry/edge abstraction            |
| Cross-database target                               | Unsupported; use a validated external identifier, not a database reference                     |
| Raw SQL corruption                                  | Prevented by checks/FKs after validation; decoder treats impossible shapes as integrity errors |

## Implementation status

Implemented: `ReferenceBuilder`, exact generated types, catalog metadata, exclusive-arc DDL,
logical read/write/replica codecs, filters, batched access-controlled forward hydration, compound
index expansion, and the HR Payroll migration.

Deliberately not exposed in v1: inverse `via` declarations, reference-valued authored row-scope
predicates, deferred cyclic constraints, and logical constraint-error translation. Those features
need their own complete authoring-to-runtime implementation; there is no compatibility syntax or
partially active path for them.

## Acceptance criteria

The feature is complete when all of the following are true:

1. Invalid target declarations fail authoring or migration validation before DDL is applied.
2. A direct SQL write with zero/multiple arms or a missing target fails in PostgreSQL.
3. Generated public types expose only the logical reference field, never hidden arm columns.
4. `with: { source: true }` infers one discriminated union and enforces target access policy.
5. Reading a page with 100 references of two kinds performs at most three collection queries: one
   base query and two batched target queries.
6. Optional, unique, cascade/restrict/set-null, self-reference, add-target, and remove-target cases
   have migration and runtime coverage.
7. HR Payroll no longer authors the `payslip_source` JSON union, generated projection columns, their
   FK relationships, or their indexes by hand.
8. `payslip_lines.component` remains a correct audit variant and its to-many leave provenance is not
   falsely represented as a singular polymorphic reference.

## References

- [Drizzle relations](https://orm.drizzle.team/docs/relations)
- [Drizzle relations fundamentals and polymorphic relations](https://orm.drizzle.team/docs/relations-schema-declaration#polymorphic-relations)
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL generated columns](https://www.postgresql.org/docs/current/ddl-generated-columns.html)
- [PostgreSQL table inheritance caveats](https://www.postgresql.org/docs/current/ddl-inherit.html#DDL-INHERIT-CAVEATS)
- [Rails polymorphic associations](https://guides.rubyonrails.org/association_basics.html#polymorphic-associations)
