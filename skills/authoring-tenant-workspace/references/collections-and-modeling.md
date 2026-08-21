# Collections and Modeling

## Column types the platform owns

**Read this table before you reach for `custom()`. If a type is here, the platform owns it — do not
hand-write a schema or a renderer for it.** Everything below is a named export of
`@norbital-ai/bolt/authoring`, and every one renders natively with its own display and input.

| import                   | stores           | notes                                                    |
| ------------------------ | ---------------- | -------------------------------------------------------- |
| `text()`                 | text             | `{ search: true }` puts it in the search index           |
| `numeric()`              | exact decimal    | never `number` for anything you do arithmetic on         |
| `integer()`              | integer          |                                                          |
| `boolean()`              | boolean          |                                                          |
| `uuid()`                 | uuid             | foreign keys and ids                                     |
| `date()`                 | date             | no time component                                        |
| `timestamp()`            | timestamptz      | an instant                                               |
| `clockTime()`            | wall-clock time  | a time of day with no date                               |
| `dateRange()`            | a start/end pair | one value, so the ends cannot separate                   |
| `enums([...])`           | a closed set     | the members reach the manifest                           |
| `file()`                 | a file           | the column carries the file                              |
| `geolocation()`          | a point          | picker and map come with it                              |
| `phone()`                | a phone number   |                                                          |
| `vector({ dimensions })` | an embedding     |                                                          |
| `jsonb()`                | opaque JSON      | last resort; nothing can query or render it meaningfully |

`custom('<name>')` is the escape hatch for a shape **none of the above covers** — `money`,
`payslip_source`, `leave_event`, `work_pattern`. It is not a way to add flavour to a type that
already exists.

> **The rule: never hand-write something the platform owns.** If a universal shape is missing from
> the table, keep the workspace datatype intact until the platform owns both a field builder and a
> renderer for it. A renderer alone does not make a datatype built in.

`std/finance/money.ts` is a **separate concern**: it manipulates money _values_ — `addAmount`,
`assertSameCurrency`, `toMinorUnits`. A workspace `money` datatype declares the column shape; the
finance helpers do arithmetic on its values. Never fold one into the other.

## Collection model

`src/collections/sites/+model.ts`:

```ts
import { defineModel, enums, geolocation, text } from '@norbital-ai/bolt/authoring';

export default defineModel(
	{
		name: text().notNull(),
		project_code: text(),
		location: geolocation(),
		status: enums(['active', 'complete'])
	},
	{
		description: 'Construction site',
		recordLabel: 'name',
		icon: 'lucide:map-pin',
		indexes: [{ columns: ['project_code'], unique: true }]
	}
);
```

The directory owns the collection ID. Models hold storage and data identity only: columns, `description`,
`recordLabel`, `icon`, and indexes. Column declaration order and kind provide schema-derived defaults;
applications own presentation. Use `enums([...])` for closed values. Do not put visual metadata, enum
colors, default sorting, or renderer variants in a model.

## Files (`file()`)

A `file()` column is one `jsonb` value holding the whole file:

```ts
{
	storage_key: string;
	file_name: string;
	file_size: number;
	mime_type: string;
}
```

```ts
import { defineModel, file, text } from '@norbital-ai/bolt/authoring';

export default defineModel({
	caption: text(),
	photo: file({ mimeTypes: ['image/jpeg', 'image/png'] }).notNull(),
	attachments: file({ multiple: true })
});
```

Read it with `api.readFileAsset(record.photo)` and pass it to a model with
`images: [{ file: record.photo }]`. There is no id to resolve and no second table: the metadata is a
field of the record that owns it, so it inherits that record's row predicate and field mask.

**Use `file({ multiple: true })`, never `file().array()`.** `.array()` throws at declaration. A
dimensioned builder records only its dimensions and drops the scalar type, so the write would bind a
JSON array as a Postgres array; `multiple: true` is one `jsonb` column holding a JSON array, which
takes the binding path that works.

## Embeddings (pgvector)

One column type: `vector({ dimensions })`. Use it for Meta PDQ (256-dim 0/1 via
`hexToBinaryEmbedding`, L2 ≈ √Hamming), Gemini multimodal / omni embeddings (cosine), and anything
else. Index with HNSW and the matching opclass:

```ts
indexes: [
	{
		name: 'photo_evidence_pdq_hnsw',
		method: 'hnsw',
		columns: ['perceptual_embedding'],
		opclass: { perceptual_embedding: 'vector_l2_ops' }
	},
	{
		name: 'items_embedding_hnsw',
		method: 'hnsw',
		columns: ['embedding'],
		opclass: { embedding: 'vector_cosine_ops' }
	}
];
```

Nearest-neighbor search is **server-only** (`api.db.query.<collection>.findNearest` in hooks /
functions / automations). The browser replica remaps `vector` to text and cannot evaluate distance
operators. A future per-record omni embedding system column reuses this same path — do not invent a
parallel one.

## Temporal fields

Choose temporal primitives by domain meaning, not by maximum precision: `date()` for calendar days,
`clockTime()` for local wall-clock values, `timestamp()` for absolute instants, and `dateRange()` for
UTC instant intervals selected/displayed in the client timezone. Read
[dates-and-time.md](dates-and-time.md) before authoring temporal models, seeds, hooks, imports, or
filters.

## Relationships

`src/collections/+relationship.ts`:

```ts
import type { Relationships } from './$types.js';

export default ((r) => ({
	sites: { site_visits: r.many.site_visits() },
	site_visits: {
		site: r.one.sites({ from: r.site_visits.site_id, to: r.sites.norbital_id })
	}
})) satisfies Relationships;
```

Keep relation names explicit and stable: query `with` clauses and generated form projections use them.

## Hooks

`src/collections/site_visits/+hooks.ts`:

```ts
import { Effect, Schema } from 'effect';
import { refuse } from '@norbital-ai/bolt/authoring';
import type { Hooks } from './$types.js';

export default {
	create: {
		/** ONCE for the whole batch. Reads; decides nothing. Only `create` has one. */
		prepare: ({ inputs, api }) =>
			Effect.gen(function* () {
				const siteIds = [...new Set(inputs.map((input) => input.site_id))];
				const sites = yield* api.db.query.sites.findMany({
					where: { norbital_id: { in: siteIds } },
					columns: { norbital_id: true },
					limit: 5000
				});
				return { knownSites: new Set(sites.map((site) => site.norbital_id)) };
			}),
		perRecord: {
			before: {
				description:
					'Rejects a visit against an unknown site and defaults the visit date to today.',
				handler: ({ input, prepared }) => {
					if (!prepared.knownSites.has(input.site_id)) refuse('Referenced site does not exist.');
					return { ...input, visited_at: input.visited_at ?? new Date() };
				}
			}
		}
	}
} satisfies Hooks<{ readonly knownSites: ReadonlySet<string> }>;
```

**The nesting is the declaration's documentation**, and it is arranged by how often each part runs:
`prepare` once for the batch, `perRecord.before` and `perRecord.after` once per record. `update` and
`delete` take the same `perRecord` nesting; only `create` has `prepare`, because only a create
arrives as a batch. An earlier shape put a batch-wide function (`batchHandler`) _beside_ a per-record
one at the same level, and nothing about the declaration said which ran when, or that one was a rule
and the other a second copy of it — five collections shipped batch validation the runtime never
called.

`prepare` is for the reads, never for the rules. A hook is authored for one record, so a hook that
_reads_ per record is an N+1 by construction; the rule and the reads are separable and only the reads
want to be batched. Every decision lives in `perRecord`, written once, for one record, whether the
write was one row or four thousand. `prepare` returns data and is typed by what it returns —
`satisfies Hooks<Prepared>`. The batched-read reasoning, the phases, and the cost budget are in
[data-access.md](data-access.md#batch-genuine-bulk-work).

Every hook point is `{ description, handler }`. The bare-function form does not exist: the
description is mandatory because it travels into the manifest, and the Workspace Studio shows it to
people reading a collection who will never open `+hooks.ts`. Write what this hook does to this data —
"runs before create" repeats the key and says nothing.

Handlers are **Effect-native**: `perRecord.before` receives `{ input, prepared, api }` (create),
`{ input, existing, api }` (update) or `{ existing, api }` (delete); `perRecord.after` receives
`{ record, api }`, plus `prepared` on a create. Every `api.db.*`, `api.infer`, and `api.readFileAsset` call returns
an `Effect.Effect` composed with `yield*`. `before` returns the accepted payload or patch — and for a
create it may return a **nested graph**, the record plus the records that belong to it, keyed by the
relation name `+relationship.ts` declared. `after` makes follow-on database or asset changes through
the elevated `api.db.<collection>.mutate([...])` / `api.db.<collection>.delete([...])`. A collection
is always reached as a property, never as a first argument. Neither may send traffic, email, or
notify, and neither may invoke AI beyond a bounded `api.infer` for judgement on the write path.
Background work is the one exception and it has exactly one door: `api.automations.run(name, input,
{ after })` starts a **declared** automation, durably and with retry — there is deliberately no
`api.tasks`, because a second way to start background work would compete with the automations a
declaration already produces. Reject a write with `refuse(message)`.

## Where validation goes, and why it is not a preference

**`perRecord.before` refuses. `perRecord.after` cannot undo.**

```
PREPARE                     COMMIT              SETTLE
prepare · before · FLATTEN  one transaction     read-back · after · events
   │                           │                   │
   │                           │                   └─ past the transaction. Cannot roll back,
   │                           │                      and should not: the write is a fact.
   │                           │                      Failures are reported, never swallowed,
   │                           │                      and a caller must NOT retry — retrying
   │                           │                      writes the batch twice.
   │                           └─ atomic. A failure here wrote nothing either.
   └─ refuses here. Nothing written, nothing to undo; the whole batch fails clean.
```

The transaction is real now, and it is the thing to reason about. `applyGraph` issues one
`Transaction` for the batch — the parent record, every record its `perRecord.before` returned in a
nested graph, and every other row in the same batch, all in one envelope. What has **not** changed is
where `after` sits: it runs in SETTLE, on the far side of COMMIT, so by the time it runs the row is a
fact and nothing it does can take it back.

**So the rule is a correctness rule, not a preference: anything that must succeed or fail atomically
with the record belongs in `perRecord.before` and the graph it returns — never in `after`.**

Two failures record why. hr-payroll ran its whole engine, validation included, in `payroll_runs`
`create.after`: the run row committed, the build then refused because someone had an unclosed time
entry, and what was left behind was a DRAFT payroll run with no payslips under it — a record
asserting a period had been calculated, blocking the next period, describing a calculation that never
happened. The second is what the nested graph replaced: the run was committed and _then_ its payslips
were written in a second transaction, their lines in a third, their sources in a fourth, so a build
that died between them left a run with no payslips. The local database was holding 92 orphaned
payslips and 15 lines from exactly that.

So: **anything that can refuse the write belongs in `perRecord.before`**, where refusing costs
nothing and fails the whole batch clean. Anything the record is not true without belongs in the graph
that `before` returns, so it commits with the record. `after` is for work that only makes sense once
the record exists — announcing it, kicking off durable work through `api.automations.run`. Its
failures are reported to the caller rather than swallowed, and leave a record an operator can see and
act on; the failure carries the phase (`prepare` │ `commit` │ `settle`) precisely so a caller can tell
"nothing was written, retry" from "it was written, do not".

A refusal raised with `refuse(message)` reaches the caller as a typed refusal — HTTP 422 carrying
your sentence — not as a runtime fault. Write the sentence for the person who has to fix it.

A create may validate the payload schema through its own Effect `Schema` by declaring `create.input`;
the write boundary decodes through it before `prepare` or any handler runs.

## Pipelines and integrations

```ts
import type { Pipelines } from './$types.js';
import { exportPipeline } from './lib/export.js';

export default {
	export: {
		description: 'Emits a confirmed visit and its photos as the JSON payload the ERP accepts.',
		handler: exportPipeline
	}
} satisfies Pipelines;
```

```ts
import type { Integrations } from './$types.js';

export default { accounting: { receive: {}, send: {} } } satisfies Integrations;
```

Pipelines own canonical import/export behavior; integrations bind portable delivery facilities. Declare
secret requirements but never embed secret values. Import/export pipeline handlers are Effect-native
too — an `export` handler receives `({ records }, api)` and returns the export manifest
(`TExportManifest`), an `import` handler receives `({ input }, api)` and returns the insert payloads.

## Structured values

Inline custom schemas do not exist. Use a collection and relationship when a value has independent identity,
query, policy, hooks, or lifecycle. Represent mutually exclusive owned variants with a strict Effect
Schema, never nullable columns that can disagree.

An owned structured value lives in `datatypes/<name>/` with exactly a `+definition.ts` default-exporting
`defineCustomType({ name, description, schema })` and a mandatory `+renderer.svelte`. The description is
required and reaches the manifest, because a `custom('settlement_policy')` column says nothing about what
it holds. Models reference it through
`custom('<name>')`. A typed schema factory may accept a second options argument; for example,
`custom('work_pattern', { cycle: 'fortnightly' })`. The definition owns its schema and inferred value type,
and named custom values use JSONB storage. Collection helpers import that definition; a custom-type
definition must never import or re-export its schema from a collection. Keep scalar references as scalar columns plus relationships.
The compiler discovers the renderer statically; manual imports, registration calls, and runtime renderer
registries do not exist.

`money` currently follows this contract. Do not replace it with separate amount and currency
columns: keep it as one custom value until Bolt owns both a `money()` field builder and the renderer.

Custom-type schemas are **Effect Schema**, never zod. Compose with `Schema.Struct`, `Schema.Union`,
`Schema.Literals`, and `Schema.NullOr` from `effect`, and export the value type as
`Schema.Schema.Type<typeof valueSchema>`. The runtime validates through `~standard`
(`Schema.toStandardSchemaV1`, strict on excess properties), so declare a strict object with
`onExcessProperty: 'error'` — the platform default for custom-type values:

```ts
import { defineCustomType } from '@norbital-ai/bolt/authoring';
import { Schema } from 'effect';

const settlementSchema = Schema.Struct({
	currency: Schema.Literals('MYR', 'USD'),
	amount: Schema.Number,
	memo: Schema.optional(Schema.String),
	approved_on: Schema.NullOr(Schema.String)
});

export default defineCustomType({
	name: 'settlement_policy',
	description: 'One settlement rule: a currency, an amount, and an optional approval instant.',
	schema: Schema.toStandardSchemaV1(settlementSchema, {
		parseOptions: { onExcessProperty: 'error' }
	})
});
```
