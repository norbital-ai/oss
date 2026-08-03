# Collections and Modeling

## Collection model

`src/collections/sites/+model.ts`:

```ts
import { defineModel, enums, geolocation, text } from '@norbital-ai/pod/authoring';

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
import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input, db }) => {
			const site = await db.sites.findFirst({ where: { norbital_id: { eq: input.site_id } } });
			if (!site) throw new Error('Referenced site does not exist.');
			return { ...input, visited_at: input.visited_at ?? new Date() };
		}
	}
} satisfies Hooks;
```

`before` returns the accepted payload or patch. `after` makes same-transaction database or asset changes.
Neither may send traffic, queue work, email, invoke AI, or notify.

## Pipelines and integrations

```ts
import type { Pipelines } from './$types.js';
import { exportPipeline } from './lib/export.js';

export default { export: exportPipeline } satisfies Pipelines;
```

```ts
import type { Integrations } from './$types.js';

export default { accounting: { receive: {}, send: {} } } satisfies Integrations;
```

Pipelines own canonical import/export behavior; integrations bind portable delivery facilities. Declare
secret requirements but never embed secret values.

## Structured values

Inline custom schemas do not exist. Use a collection and relationship when a value has independent identity,
query, policy, hooks, or lifecycle. Represent mutually exclusive owned variants with a strict Zod
discriminated union, never nullable columns that can disagree.

An owned structured value lives in `custom-types/<name>/` with exactly a `+definition.ts` default-exporting
`defineCustomType({ name, schema })` and a mandatory `+renderer.svelte`. Models reference it through
`custom('<name>')`. A typed schema factory may accept a second options argument; for example,
`custom('money', { allowedCurrencies: ['MYR'] })`. The definition owns its schema and inferred value type,
and named custom values use JSONB storage. Collection helpers import that definition; a custom-type
definition must never import or re-export its schema from a collection. Keep scalar references as scalar columns plus relationships.
The compiler discovers the renderer statically; manual imports, registration calls, and runtime renderer
registries do not exist. `money` follows this same filesystem contract; it is not a built-in exception.
