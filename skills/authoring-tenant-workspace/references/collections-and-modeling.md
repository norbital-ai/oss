# Collections and Modeling

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
remotes / automations). The browser replica remaps `vector` to text and cannot evaluate distance
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
		before: {
			description: 'Rejects a visit against an unknown site and defaults the visit date to today.',
			handler: ({ input, api }) =>
				Effect.gen(function* () {
					const site = yield* api.db.query.sites.findFirst({
						where: { norbital_id: { eq: input.site_id } },
						columns: { norbital_id: true }
					});
					if (site == null) refuse('Referenced site does not exist.');
					return { ...input, visited_at: input.visited_at ?? new Date() };
				})
		}
	}
} satisfies Hooks;
```

Every hook point is `{ description, handler }` (create `before` also takes an optional `batchHandler`
for bulk writes). The bare-function form does not exist: the description is
mandatory because it travels into the manifest, and the Workspace Studio shows it to people reading a
collection who will never open `+hooks.ts`. Write what this hook does to this data — "runs before
create" repeats the key and says nothing.

Handlers are **Effect-native**: `handler` receives `{ input, api }` (create/update) or
`{ existing, api }` (delete), and every `api.db.*`, `api.infer`, and `api.readFileAsset` call
returns an `Effect.Effect` composed with `yield*`. The runtime executes hooks around create, update,
and delete — `before` returns the accepted payload or patch; `after` makes same-transaction database
or asset changes through the elevated `api.db.mutate` / `api.db.delete`. Neither may send traffic,
queue work, email, invoke AI (bounded `api.infer` for judgement on the write path excepted), or
notify. Reject a write with `refuse(message)`.

A `create.before` hook may validate the payload schema through its own Effect `Schema` by declaring
`create.input`; the compiler validates incoming writes through it before the handler runs.

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

An owned structured value lives in `custom-types/<name>/` with exactly a `+definition.ts` default-exporting
`defineCustomType({ name, description, schema })` and a mandatory `+renderer.svelte`. The description is
required and reaches the manifest, because a `custom('settlement_policy')` column says nothing about what
it holds. Models reference it through
`custom('<name>')`. A typed schema factory may accept a second options argument; for example,
`custom('money', { allowedCurrencies: ['MYR'] })`. The definition owns its schema and inferred value type,
and named custom values use JSONB storage. Collection helpers import that definition; a custom-type
definition must never import or re-export its schema from a collection. Keep scalar references as scalar columns plus relationships.
The compiler discovers the renderer statically; manual imports, registration calls, and runtime renderer
registries do not exist. `money` follows this same filesystem contract; it is not a built-in exception.

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
