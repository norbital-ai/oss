// AI filtering: the view popover's "Describe what to show…" becomes a typed `Where` and
// `OrderBy` through `infer_facility` (`sys_2`, with reasoning allowed).
//
//   1. Schema: the model's exposure narrowed to what the caller reads — own fields, one-relations,
//      many-relations (any / all / none, count, child aggregates, and nested exposed layers),
//      search index (`$search`), embedding (`$similar`), and sortable keys.
//   2. Lookup tool: caller-scoped read tool (`lookup`) lets the model resolve named records,
//      locations, and named days (holidays/events) on demand — zero DB reads when unneeded.
//   3. Draft + validate loop: the model emits `{ where?, order_by? }` via `edit` + `submit`,
//      validated strictly against `decodeDescribed` (store grammar + caller exposure) and UI
//      round-trip compatibility (`fromWhere` / `parseOrder`). Any validation error feeds back to
//      the model so it repairs or calls `refuse({ message })` with a clear user-facing error.
//   4. `filter.options`: shares the caller-scoped field/operator catalogue with the manual builder.
import { Array as EffectArray, Effect, Option, Result, Schema } from 'effect';
import { label_paths } from '@norbital-ai/store/label';
import { KIND, type Kind } from '@norbital-ai/store/kind';
import type { ViewBolt } from '@norbital-ai/ui';
import { Ai } from '../ports.ts';
import { Manifest, Reads, type ReadsShape } from '../services.ts';
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, CrossAnswer, RowData } from '../contracts.ts';
import type { Pred } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import type { DescribeStep, LocalFilterField } from '../../protocol/schema.ts';
import { type EngineError } from '../errors.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { infer_facility, type InferProgress, type InferTool } from '../agent/ai.ts';
import { catalog_of } from '../access/pred.ts';
import { readsAny, viewOutput } from '../access/authority.ts';
import { midnight, startOfDate } from '../query/eval.ts';
import { materialize } from '../runs/time.ts';
import {
	can_aggregate_where,
	catalog_for,
	DEFAULT_OUTPUT,
	exposed_field,
	KindSpec,
	UNSORTABLE,
	type Catalog,
	type ExposureInfo,
	type FieldInfo
} from '@norbital-ai/store';
import * as ir from '../../protocol/reads.ts';
import { order, where as decodeWhere } from '@norbital-ai/store';

const FILTER_MAX_TEXT = 500;
/** Wall for filter description (DeepSeek with reasoning + optional lookup tool calls). */
const FILTER_DEADLINE_MS = 30_000;
/** Relation hops `filter.options` exposes to the manual builder. */
const OPTIONS_MAX_HOPS = 2;
/** Max layer depth described to the planner (includes nested exposed layers inside many-relations). */
const SCHEMA_MAX_DEPTH = 3;
/** Max tool turns for filter planning (lookups + edit/submit/repair). */
const FILTER_MAX_STEPS = 6;
/** Max sort keys supported by store and UI. */
const ORDER_MAX_KEYS = 4;
/** Max rows returned per lookup call. */
const LOOKUP_MAX_ROWS = 10;
/** Max dated models advertised as holiday/event sources. */
const MAX_DATED_MODELS = 16;

const DAY_KINDS = new Set(['date', 'instant']);
const NUMERIC = new Set(
	Object.entries(KIND)
		.filter(([, kind]) => kind.traits.numeric)
		.map(([name]) => name)
);
const AGGS = [
	['total', 'sum'],
	['average', 'avg'],
	['lowest', 'min'],
	['highest', 'max']
] as const;

/** The same catalogue and nesting paths the builder receives, without a browser runtime dependency. */
type CatalogueOffer = Effect.Success<ReturnType<NonNullable<ViewBolt['options']>>>['fields'][number];
type FilterStep = CatalogueOffer['path'][number];
type ActorVar = 'actor.id' | 'actor.email' | 'actor.party' | 'actor.teams';
type FilterArg = { lit: Json } | { list: readonly Json[] } | { range: readonly [Json, Json] } | { var: ActorVar };
type FilterValue = { label: string; arg: FilterArg };
type FilterOffer = Omit<CatalogueOffer, 'values'> & { values?: readonly FilterValue[] };
type FilterCatalogue = readonly FilterOffer[];
type Failed = { ok: false; code: string; message: string; steps?: readonly DescribeStep[] };
type Described = { ok: true; where?: Json; order_by?: Json; steps?: readonly DescribeStep[] } | Failed;
type FilterOptions = Failed | { ok: true; fields: FilterCatalogue };
type Op = { op: CatalogueOffer['op']; label: string };
type Field = {
	label: string;
	path: readonly FilterStep[];
	kind: string;
	ops: readonly Op[];
	values: FilterValue[];
	sort?: string;
};

type FilterDescribeConfig = {
	manifest: EngineManifest;
	read: ReadsShape['run'];
	ai: Ai['Service'];
};

const human = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const isJsonArray = (v: Json | undefined): v is readonly Json[] => Array.isArray(v);
const isJsonObject = (v: Json | undefined): v is { readonly [key: string]: Json } =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const isPoint = Schema.is(Schema.Struct({ lat: Schema.Number, lng: Schema.Number }));
const isVarObject = (v: Json | undefined): v is { readonly var: string } =>
	isJsonObject(v) && Object.keys(v).length === 1 && typeof v['var'] === 'string';

const fieldOps = (items: readonly (readonly [Op['op'], string])[]): readonly Op[] =>
	items.map(([op, label]) => ({ op, label }));
const CMP_OPS = fieldOps([
	['eq', 'is'],
	['ne', 'is not'],
	['gt', 'more than'],
	['gte', 'at least'],
	['lt', 'less than'],
	['lte', 'at most']
]);
const LIST = fieldOps([
	['in', 'is any of'],
	['not_in', 'is none of']
]);
const EQUALITY_OPS = [...CMP_OPS.slice(0, 2), ...LIST];
const NUMBER_OPS = [...CMP_OPS, ...LIST];
const DATE_OPS = fieldOps([
	['during', 'is within'],
	['eq', 'is'],
	['ne', 'is not'],
	['gt', 'after'],
	['gte', 'on or after'],
	['lt', 'before'],
	['lte', 'on or before']
]);
const NULL_OPS = fieldOps([
	['is_null', 'is empty'],
	['not_null', 'is not empty']
]);
const YES_NO: readonly FilterValue[] = [
	{ label: 'yes', arg: { lit: true } },
	{ label: 'no', arg: { lit: false } }
];
const OPS_BY_KIND: Readonly<Record<string, readonly Op[]>> = {
	enum: EQUALITY_OPS,
	state: EQUALITY_OPS,
	id: EQUALITY_OPS,
	currency: EQUALITY_OPS,
	bool: fieldOps([['eq', 'is']]),
	text: [{ op: 'like', label: 'contains' }, ...EQUALITY_OPS],
	int: NUMBER_OPS,
	decimal: NUMBER_OPS,
	money: NUMBER_OPS,
	number: NUMBER_OPS,
	count: NUMBER_OPS,
	sum: NUMBER_OPS,
	date: DATE_OPS,
	instant: DATE_OPS,
	time: CMP_OPS,
	period: fieldOps([
		['contains', 'in force on'],
		['overlaps', 'overlaps'],
		['contained_by', 'is within'],
		['starts_within', 'starts within'],
		['ends_within', 'ends within']
	]),
	json: fieldOps([['contains', 'contains']]),
	point: [],
	file: [],
	vector: [],
	custom: [],
	ref: []
};

/** Spans offered by `filter.options` for date/instant fields in the manual builder. */
function spans(kind: 'date' | 'instant', today: string, tz: string): FilterValue[] {
	const end = (date: string): Json => (kind === 'date' ? date : midnight(date, tz));
	const range = (lo: string, hi: string): FilterArg => ({ range: [end(lo), end(hi)] });
	const at = (unit: string, shift: number) => startOfDate({ unit, shift }, today);
	const out: FilterValue[] = [];
	if (kind === 'date') {
		const off = (n: number): Json =>
			n === 0 ? { var: 'today' } : { var: `today ${n > 0 ? '+' : '-'} days(${Math.abs(n)})` };
		for (const [label, [a, b]] of [
			['today', [0, 1]],
			['yesterday', [-1, 0]],
			['last 7 days', [-7, 1]],
			['next 7 days', [0, 8]],
			['last 30 days', [-30, 1]]
		] as const)
			out.push({ label, arg: { range: [off(a), off(b)] } });
	}
	for (const unit of ['week', 'month', 'quarter', 'year']) {
		out.push({ label: `this ${unit}`, arg: range(at(unit, 0), at(unit, 1)) });
		out.push({ label: `last ${unit}`, arg: range(at(unit, -1), at(unit, 0)) });
		if (unit === 'week') out.push({ label: `next ${unit}`, arg: range(at(unit, 1), at(unit, 2)) });
	}
	return out;
}

function fieldOptions(
	f: Pick<FieldInfo, 'kind' | 'many' | 'period_of' | 'team' | 'email'>,
	s: Kind | undefined,
	optional: boolean,
	tz: string,
	today: string
): { ops: Op[]; values: FilterValue[] } | undefined {
	const values: FilterValue[] = [];
	const add = (label: string, arg: FilterArg) => {
		let l = label,
			n = 2;
		while (values.some((v) => v.label === l)) l = `${label} (${n++})`;
		values.push({ label: l, arg });
	};
	const k = f.kind;
	let ops: Op[] = [...(OPS_BY_KIND[k] ?? [])];
	if (f.many) {
		if (k === 'enum') for (const v of s?.kind === 'enum' ? s.values : []) add(v, { lit: v });
		else if (k === 'bool') for (const v of YES_NO) add(v.label, v.arg);
		return {
			ops: [
				...fieldOps([
					['has', 'has'],
					['has_any', 'has any of'],
					['has_all', 'has all of'],
					['is_empty', 'is empty'],
					['not_empty', 'is not empty']
				])
			],
			values
		};
	}
	if (k === 'enum' || k === 'state') {
		const states: { readonly [state: string]: { readonly to?: readonly string[] } } =
			s?.kind === 'state' ? s.states : {};
		for (const v of k === 'enum' ? (s?.kind === 'enum' ? s.values : []) : Object.keys(states))
			add(v, { lit: v });
		if (k === 'state')
			add('a final state', {
				list: Object.entries(states)
					.filter(([, state]) => (state.to ?? []).length === 0)
					.map(([name]) => name)
			});
	} else if (k === 'bool') for (const v of YES_NO) add(v.label, v.arg);
	else if (k === 'text') {
		if (f.team) add('my team', { var: 'actor.teams' });
		if (f.email) add('my email', { var: 'actor.email' });
	} else if (NUMERIC.has(k)) {
	} else if (k === 'date' || k === 'instant' || k === 'time') {
		if (k !== 'time') for (const v of spans(k, today, tz)) add(v.label, v.arg);
	} else if (k === 'period' && f.period_of === 'date') {
		add('today', { lit: { var: 'today' } });
		for (const v of spans('date', today, tz)) add(v.label, v.arg);
	} else if (k === 'json' || k === 'id' || k === 'currency') {
	} else if (k === 'point' || k === 'file' || k === 'vector' || k === 'custom' || k === 'ref') {
		ops = [];
	} else return undefined;
	if (optional) ops.push(...NULL_OPS);
	return ops.length === 0 && k !== 'point' ? undefined : { ops, values };
}

/** The level a hop from `x` through `rel` into `target` reads: its declared layer, or the target's root where `x` declares every relation. */
const levelOf = (cat: Catalog, x: ExposureInfo, rel: string, target: string) => {
	const layer = cat.layers.get(`${x.path}.${rel}`);
	if (layer?.name === target) return layer;
	return x.relations === 'all' ? cat.exposures.get(target) : undefined;
};

/** Compact description of a declared JSON shape so the planner knows valid `contains` structure. */
function shapeSummary(k: Kind | undefined, depth = 0): Json | undefined {
	if (k === undefined || depth > 3) return undefined;
	if (k.kind === 'json') return k.shape === undefined ? 'json' : shapeSummary(k.shape, depth);
	if (k.kind === 'enum') return { kind: 'enum', values: [...k.values], ...(k.many ? { many: true } : {}) };
	if (k.kind === 'object')
		return {
			kind: 'object',
			...(k.many ? { many: true } : {}),
			fields: Object.fromEntries(
				Object.entries(k.fields).map(([name, child]) => [name, shapeSummary(child, depth + 1) ?? child.kind])
			)
		};
	if (k.kind === 'union' && 'arms' in k)
		return {
			kind: 'union',
			by: k.by,
			...(k.many ? { many: true } : {}),
			arms: Object.fromEntries(
				Object.entries(k.arms).map(([arm, fields]) => [
					arm,
					Object.fromEntries(
						Object.entries(fields).map(([name, child]) => [name, shapeSummary(child, depth + 1) ?? child.kind])
					)
				])
			)
		};
	if (k.kind === 'record')
		return { kind: 'record', of: shapeSummary(k.of, depth + 1) ?? k.of.kind, ...(k.many ? { many: true } : {}) };
	return k.many ? `${k.kind}[]` : k.kind;
}

const FILTER_OUTPUT_SCHEMA: Json = {
	type: 'object',
	additionalProperties: false,
	properties: {
		where: {
			type: 'object',
			description: 'Bolt Where predicate object. Omit when the request is sort-only.'
		},
		order_by: {
			description:
				'Bolt OrderBy object ({ field: "asc" | "desc" }, nested one-relation { rel: { field: "asc" | "desc" } }, nearest { pointField: { near: { lat, lng } } }) or an array of up to 4 such objects. Omit when no ordering is requested.'
		}
	}
};

const LookupInput = Schema.Struct({
	model: Schema.NonEmptyString,
	query: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LOOKUP_MAX_ROWS })))
});

const FILTER_SYSTEM_PROMPT = `You translate a user's natural-language view description into a Bolt filter (\`where\`) and/or sort (\`order_by\`) for the exposed model schema below.

## Output rules
- Set \`/where\` and/or \`/order_by\` with \`edit\`, then call \`submit\` in the SAME reply (one turn whenever no lookup is needed).
- Only set \`/order_by\` when the user explicitly asks to sort or order.
- If the request cannot be expressed on this view, call \`refuse\` immediately with a concise 1–2 sentence plain-language message (in the user's language, no markdown, no raw JSON/operator syntax, no follow-up chat questions like "Want me to..." since this is a single-shot filter bar). Explain briefly why and suggest 1 concrete alternative phrase they can type. Never guess or substitute an unrelated field.
- Use the \`lookup\` tool first whenever the user names a specific record (person, company, site, location) or a named holiday/event day whose ID, coordinates, or date is not already in the schema.
- Only use fields, relations, enum/state values, search indexes, and sort keys explicitly listed in the provided schema.

## Bolt \`where\` grammar (must also round-trip through the view filter editor)
- **Boolean composition** (arbitrary nesting at root and inside \`some\`/\`every\`/\`none\`):
  - \`{ "and": [p1, p2, ...] }\`, \`{ "or": [p1, p2, ...] }\`, \`{ "not": p }\`
  - IMPORTANT: Do NOT put \`not\` directly inside a one-relation \`is\` block. Instead put \`not\` at root (or \`many\`) scope, e.g. \`{ "not": { "assignee": { "is": { "name": { "eq": "Bob" } } } } }\`, or use \`ne\` on the inner field.
- **Scalar operators**: \`eq\`, \`ne\`, \`lt\`, \`lte\`, \`gt\`, \`gte\`, \`in\` (non-empty array), \`is_null\` (\`true\` or \`false\`).
  - For "is none of" / \`not_in\`: \`{ "not": { "<field>": { "in": [...] } } }\`.
  - Multiple conditions on the same field are supported via \`and\`/\`or\`, e.g. \`{ "or": [{ "hours": { "lt": 2 } }, { "hours": { "gt": 10 } }] }\`.
  - Same-row field comparison: \`{ "end_date": { "gt": { "field": "start_date" } } }\`.
- **Text substring**: \`{ "<field>": { "like": "%words%" } }\` — ALWAYS start and end with \`%\`, escape literal \`%\`/\`_\` as \`\\%\`/\`\\_\`, no unescaped \`_\`.
  - "does not contain": \`{ "not": { "<field>": { "like": "%words%" } } }\`.
- **List fields** (\`many: true\`):
  - Has one: \`{ "<field>": { "has": "v" } }\`
  - Has any: \`{ "or": [{ "<field>": { "has": "a" } }, { "<field>": { "has": "b" } }] }\`
  - Has all: \`{ "and": [{ "<field>": { "has": "a" } }, { "<field>": { "has": "b" } }] }\`
  - Empty / non-empty: \`{ "or": [{ "<field>": { "is_null": true } }, { "<field>": { "eq": [] } }] }\` / \`{ "and": [{ "<field>": { "is_null": false } }, { "<field>": { "ne": [] } }] }\`
- **Dates & instants**:
  - For rolling day windows on \`date\` fields, keep relative variables so saved filters roll over daily:
    - today: \`{ "gte": { "var": "today" }, "lt": { "var": "today + days(1)" } }\` (or \`{ "eq": { "var": "today" } }\` for exact day)
    - yesterday: \`{ "gte": { "var": "today - days(1)" }, "lt": { "var": "today" } }\`
    - last N days: \`{ "gte": { "var": "today - days(N)" }, "lt": { "var": "today + days(1)" } }\`
    - next N days: \`{ "gte": { "var": "today" }, "lt": { "var": "today + days(N + 1)" } }\`
  - For calendar spans (this/last/next week [Monday start], month, quarter, year) or explicit dates, compute exact ISO \`YYYY-MM-DD\` (for \`date\`) or ISO zoned-midnight UTC timestamps (for \`instant\`, using the provided \`timezone\`), using half-open \`{ "gte": lo, "lt": hi }\`.
  - For an explicit day on an \`instant\` field, use \`{ "gte": "<day 00:00 in tz>", "lt": "<next day 00:00 in tz>" }\`.
- **Date periods** (\`kind: "period"\`, \`period_of: "date"\`):
  - Active / current / in force today: always use \`{ "<field>": { "contains": { "var": "today" } } }\` (rolls over daily); for a specific date use \`"YYYY-MM-DD"\`.
  - Span tests (\`to\` is inclusive last day): \`overlaps\`, \`contained_by\`, \`starts_within\`, \`ends_within\` with \`{ "from": "...", "to": "..." }\`.
- **JSON / inline shaped fields**:
  - Bare unshaped \`json\`: \`{ "<field>": { "contains": <json> } }\` or \`is_null\`.
  - Shaped \`object\` / \`record\`: filter directly on nested paths with full scalar operators and \`and\`/\`or\`/\`not\`, e.g. \`{ "meta": { "location": { "floor": { "gte": 4 } } } }\` (or \`contains\`/\`is_null\`).
  - Shaped discriminated \`union\` (\`by\`, \`arms\`):
    - Filter on the discriminator (\`by\`) as an enum: \`{ "rate": { "unit": { "eq": "MONTHLY" } } }\`.
    - Filter inside a specific arm by arm name (automatically guards the discriminator in SQL): \`{ "rate": { "MONTHLY": { "amount": { "gt": 5000 } } } }\`.
    - Inside a union arm, prefer \`ne\` over bare \`not\` (bare \`not\` inside a union arm does not round-trip in the view editor, except \`not: { field: { in: [...] } }\`).
  - Inline arrays (\`many: true\` inside \`json\`): use \`contains\` or \`is_null\` (array quantifiers inside JSON are not rendered by the view editor).
- **Point fields**: \`{ "<field>": { "near": [{ "lat": 1.3, "lng": 103.8 }, 1000] } }\` (metres; default 1000 m if radius unstated).
- **Actor variables** (only when the user explicitly filters by their own identity — "show me / give me / 给我" is a display verb, NOT ownership):
  - \`{ "var": "actor.id" }\` on \`sys_user\` ref fields (\`eq\`/\`ne\`)
  - \`{ "var": "actor.party" }\` on party ref fields when listed (\`eq\`/\`ne\`)
  - \`{ "var": "actor.email" }\` on email text fields (\`eq\`/\`ne\`)
  - \`{ "var": "actor.teams" }\` on team text fields (\`in\`)
- **One-relations**:
  - Match by looked-up record ID: \`{ "<rel>": { "is": { "id": { "eq": "<id>" } } } }\` (or \`in\` for multiple IDs). Do not mix \`id\` with other keys in the same \`is\` object.
  - Match by related fields (up to 2 hops): \`{ "<rel>": { "is": { "<field>": ... } } }\`.
  - Polymorphic arcs: \`{ "<rel>": { "<arm>": { "is": ... } } }\`.
  - Null check / actor var on FK: \`{ "<rel>": { "is_null": true } }\`, \`{ "<rel>": { "eq": { "var": "actor.id" } } }\`.
- **Many-relations** (at root or 1 one-relation hop on, with full nested predicates inside):
  - Quantifiers: \`{ "<rel>": { "some": <child where> } }\`, \`{ "<rel>": { "every": <child where> } }\`, \`{ "<rel>": { "none": <child where> } }\`.
  - Multiple conditions on the SAME related record belong together inside one \`some\`/\`every\`/\`none\`.
  - "Has at least one AND all match": \`{ "and": [{ "<rel>": { "count": { "gt": 0 } } }, { "<rel>": { "every": <child where> } }] }\`.
  - "No records OR at least one matching": \`{ "or": [{ "<rel>": { "count": { "eq": 0 } } }, { "<rel>": { "some": <child where> } }] }\`.
  - Multiple distinct quantifiers on the same relation (e.g. "has an active X and no failed X"): combine in root \`and\`/\`or\`.
  - Counts & aggregates (apply to ALL children of the relation):
    - \`{ "<rel>": { "count": { "gte": 2 } } }\`
    - \`{ "<rel>": { "sum": { "of": "<field>", "gte": 500 } } }\` (also \`avg\`, \`min\`, \`max\`; \`min\`/\`max\` also accept dates/instants).
- **Search / semantic** (only if listed on that layer): \`{ "$search": "words" }\` (full-text), \`{ "$similar": "topic" }\` (semantic topic).
- **Sorting (\`order_by\`)**:
  - Single key: \`{ "scheduled_on": "desc" }\`, one-hop related key: \`{ "assignee": { "name": "asc" } }\`, nearest point: \`{ "spot": { "near": { "lat": 1.3, "lng": 103.8 } } }\`.
  - Multiple keys (up to 4): \`[{ "status": "asc" }, { "scheduled_on": "desc" }]\`.
  - Sorting is ONLY allowed on keys in \`sortable_keys\` or \`nearest_sort_fields\`.

## When to call \`refuse\`
- The user asks to filter or sort by a field that does not exist (or is not exposed) on this view.
- The user asks to **sort** by a field inside a many-relation, an aggregate, or an unsortable field (explain clearly where the field lives if it exists on a child relation, list a few valid sortable fields, and mention if they can filter by it instead).
- The user asks for cross-record ranking, top-N/limit ("top 5", "first 3", "only the highest"), or per-group max/min ("latest per customer") when no exposed flag or aggregate represents it.
- The user asks for a count (> 1), sum, or average of a **filtered subset** of related children ("at least 2 open orders", "sum of September repayments > 1000") — aggregates apply to the whole relation, not a filtered subset.
- A \`lookup\` finds no matching record for a named entity or holiday.
- The input is not a filter/sort request (e.g., an action like "delete inactive records").`;

/** Check if a `like` pattern round-trips cleanly through UI `fromWhere` (`unlike`). */
const validUiLike = (pattern: string): boolean =>
	/^%.*%$/s.test(pattern) && !/(^|[^\\])(\\\\)*_/.test(pattern.slice(1, -1));

/** Validate a local-view filter/sort against its supplied fields. */
function validateLocal(
	fields: readonly LocalFilterField[],
	candidate: { where?: Json; order_by?: Json }
): string | undefined {
	const byName = new Map(fields.map((f) => [f.name, f]));
	const checkWhere = (w: Json, path: string): string | undefined => {
		if (!isJsonObject(w) || Object.keys(w).length === 0) return `${path}: expected non-empty predicate object`;
		for (const [k, v] of Object.entries(w)) {
			if (k === 'and' || k === 'or') {
				if (!isJsonArray(v) || v.length === 0) return `${path}.${k}: expected non-empty array`;
				for (const [i, item] of v.entries()) {
					const err = checkWhere(item, `${path}.${k}[${i}]`);
					if (err !== undefined) return err;
				}
				continue;
			}
			if (k === 'not') {
				const err = checkWhere(v, `${path}.not`);
				if (err !== undefined) return err;
				continue;
			}
			const f = byName.get(k);
			if (f === undefined) return `${path}: unknown local field '${k}'`;
			if (!isJsonObject(v) || Object.keys(v).length === 0) return `${path}.${k}: expected operator object`;
			for (const [op, arg] of Object.entries(v)) {
				if (op === 'is_null') {
					if (f.optional !== true) return `${path}.${k}: field is not optional`;
					if (typeof arg !== 'boolean') return `${path}.${k}.is_null: expected boolean`;
					continue;
				}
				if (f.kind === 'text') {
					if (op === 'like') {
						if (typeof arg !== 'string' || !validUiLike(arg))
							return `${path}.${k}.like: pattern must start and end with '%' and have no unescaped '_'`;
					} else if (op === 'eq' || op === 'ne') {
						if (typeof arg !== 'string') return `${path}.${k}.${op}: expected string`;
					} else if (op === 'in') {
						if (!EffectArray.isArray(arg) || arg.length === 0 || !arg.every((x) => typeof x === 'string'))
							return `${path}.${k}.in: expected non-empty array of strings`;
					} else return `${path}.${k}: unsupported operator '${op}' for text`;
				} else if (f.kind === 'number') {
					if (['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op)) {
						if (typeof arg !== 'number' || !Number.isFinite(arg))
							return `${path}.${k}.${op}: expected finite number`;
					} else if (op === 'in') {
						if (
							!EffectArray.isArray(arg) ||
							arg.length === 0 ||
							!arg.every((x) => typeof x === 'number' && Number.isFinite(x))
						)
							return `${path}.${k}.in: expected non-empty array of numbers`;
					} else return `${path}.${k}: unsupported operator '${op}' for number`;
				} else if (f.kind === 'bool') {
					if (op !== 'eq' || typeof arg !== 'boolean')
						return `${path}.${k}: boolean supports only { eq: true | false }`;
				}
			}
		}
		return undefined;
	};
	if (candidate.where !== undefined) {
		const err = checkWhere(candidate.where, 'where');
		if (err !== undefined) return err;
	}
	if (candidate.order_by !== undefined) {
		const items = isJsonArray(candidate.order_by) ? candidate.order_by : [candidate.order_by];
		if (items.length === 0 || items.length > ORDER_MAX_KEYS)
			return `order_by: expected 1 to ${ORDER_MAX_KEYS} sort keys`;
		const seen = new Set<string>();
		for (const item of items) {
			if (!isJsonObject(item) || Object.keys(item).length !== 1)
				return 'order_by: each sort entry must be { "<field>": "asc" | "desc" }';
			const entry = Object.entries(item)[0];
			if (entry === undefined) return 'order_by: empty sort entry';
			const [field, dir] = entry;
			if (!byName.has(field)) return `order_by: unknown local field '${field}'`;
			if (dir !== 'asc' && dir !== 'desc') return `order_by.${field}: direction must be 'asc' or 'desc'`;
			if (seen.has(field)) return `order_by: duplicate sort field '${field}'`;
			seen.add(field);
		}
	}
	return undefined;
}

const unwrapShapeSpec = (k: KindSpec): KindSpec =>
	k.kind === 'json' && k.many !== true && k.shape !== undefined ? unwrapShapeSpec(k.shape) : k;

/** Mirrors UI `inlineFromWhere`: validates shaped JSON / union predicates for lossless UI round-trip. */
function checkInlineUi(
	shape: KindSpec | undefined,
	v: { readonly [key: string]: Json },
	insideArm: boolean,
	at: string
): string | undefined {
	if (shape === undefined) {
		const bad = Object.keys(v).find((op) => op !== 'contains' && op !== 'is_null');
		return bad === undefined
			? undefined
			: `${at}.${bad}: unshaped json fields only support 'contains' and 'is_null' in the view filter editor`;
	}
	const k = unwrapShapeSpec(shape);
	if (k.many === true) {
		const bad = Object.keys(v).find((op) => op !== 'contains' && op !== 'is_null');
		return bad === undefined
			? undefined
			: `${at}.${bad}: inline json arrays only support 'contains' and 'is_null' in the view filter editor`;
	}
	if (!['json', 'object', 'record', 'union'].includes(k.kind)) {
		if ('like' in v && !isVarObject(v['like'])) {
			if (typeof v['like'] !== 'string' || !validUiLike(v['like']))
				return `${at}.like: pattern must start and end with '%' and contain no unescaped '_'`;
		}
		return undefined;
	}
	for (const [op, val] of Object.entries(v)) {
		if (op === 'contains' || op === 'is_null') continue;
		if ((op === 'and' || op === 'or') && isJsonArray(val)) {
			for (const [i, item] of val.entries()) {
				if (!isJsonObject(item)) return `${at}.${op}[${i}]: expected object`;
				const err = checkInlineUi(k, item, insideArm, `${at}.${op}[${i}]`);
				if (err !== undefined) return err;
			}
			continue;
		}
		if (op === 'not' && isJsonObject(val)) {
			const keys = Object.keys(val);
			const only = keys.length === 1 ? val[keys[0] ?? ''] : undefined;
			const isNotIn =
				keys.length === 1 && isJsonObject(only) && Object.keys(only).length === 1 && 'in' in only;
			if (insideArm && !isNotIn)
				return `${at}.not: bare 'not' inside a union arm does not round-trip in the view editor; use 'ne' on the field instead`;
			const err = checkInlineUi(k, val, insideArm, `${at}.not`);
			if (err !== undefined) return err;
			continue;
		}
		if (k.kind === 'object') {
			const sub = k.fields?.[op] ?? k.rest;
			if (sub === undefined || !isJsonObject(val))
				return `${at}.${op}: unsupported key on inline object`;
			const err = checkInlineUi(sub, val, insideArm, `${at}.${op}`);
			if (err !== undefined) return err;
			continue;
		}
		if (k.kind === 'record') {
			if (!isJsonObject(val)) return `${at}.${op}: expected operator object`;
			const ofSpec = Option.getOrUndefined(Schema.decodeUnknownOption(KindSpec)(k.of));
			const err = checkInlineUi(ofSpec, val, insideArm, `${at}.${op}`);
			if (err !== undefined) return err;
			continue;
		}
		if (k.kind === 'union' && k.by !== undefined && k.arms !== undefined) {
			if (op === k.by && isJsonObject(val)) {
				const err = checkInlineUi({ kind: 'enum', values: Object.keys(k.arms) }, val, insideArm, `${at}.${op}`);
				if (err !== undefined) return err;
				continue;
			}
			const armFields = k.arms[op];
			if (armFields !== undefined && isJsonObject(val)) {
				const err = checkInlineUi({ kind: 'object', fields: armFields }, val, true, `${at}.${op}`);
				if (err !== undefined) return err;
				continue;
			}
		}
		return `${at}.${op}: unsupported operator on json field in the view filter editor`;
	}
	return undefined;
}

/**
 * Checks the extra structural rules UI `fromWhere` + `parseOrder` require so an AI answer never
 * fails UI round-trip silently after passing `decodeDescribed`.
 */
function checkUiCompatible(
	cat: Catalog,
	model: string,
	q: { where?: Json; order_by?: Json }
): string | undefined {
	const root = cat.exposures.get(model);
	if (root === undefined) return `unknown model '${model}'`;
	const walk = (w: Json, x: ExposureInfo, oneHops: number, at: string): string | undefined => {
		if (!isJsonObject(w)) return `${at}: expected object`;
		for (const [k, v] of Object.entries(w)) {
			if (k === 'and' || k === 'or') {
				if (!isJsonArray(v) || v.length === 0) return `${at}.${k}: expected non-empty array`;
				for (const [i, item] of v.entries()) {
					const err = walk(item, x, oneHops, `${at}.${k}[${i}]`);
					if (err !== undefined) return err;
				}
				continue;
			}
			if (k === 'not') {
				if (oneHops > 0)
					return `${at}.not: 'not' cannot be nested directly inside a one-relation 'is' block; move 'not' outside the 'is' block or use 'ne' on the field`;
				const err = walk(v, x, oneHops, `${at}.not`);
				if (err !== undefined) return err;
				continue;
			}
			if (k === '$search' || k === '$similar') {
				if (typeof v !== 'string' || v.trim() === '') return `${at}.${k}: expected non-empty string`;
				continue;
			}
			const many = x.model.many.get(k);
			if (many !== undefined) {
				if (oneHops > 1) return `${at}.${k}: many-relations are only supported at root or one one-relation hop`;
				const child = levelOf(cat, x, k, many.child);
				if (child === undefined || !isJsonObject(v)) return `${at}.${k}: unexposed relation`;
				for (const [qName, body] of Object.entries(v)) {
					if (qName === 'some' || qName === 'every' || qName === 'none') {
						const err = walk(body, child, 0, `${at}.${k}.${qName}`);
						if (err !== undefined) return err;
					}
				}
				continue;
			}
			const one = x.model.one.get(k);
			if (one !== undefined) {
				if (!isJsonObject(v)) return `${at}.${k}: expected object`;
				const arms: readonly (readonly [string | null, Json])[] =
					one.targets.length > 1 ? Object.entries(v) : [[null, v]];
				for (const [arm, body] of arms) {
					const targetName = arm ?? one.targets[0];
					if (targetName === undefined || !isJsonObject(body)) continue;
					if ('is' in body) {
						const inner = body['is'];
						if (!isJsonObject(inner)) return `${at}.${k}.is: expected object`;
						if ('id' in inner) {
							if (Object.keys(inner).length !== 1)
								return `${at}.${k}.is: 'id' cannot be combined with sibling keys inside the same 'is' object; split into separate 'and' clauses`;
							continue;
						}
						if (oneHops + 1 > 2)
							return `${at}.${k}: one-relation chaining cannot exceed 2 hops in the filter editor`;
						const target = levelOf(cat, x, k, targetName);
						if (target === undefined) return `${at}.${k}: unexposed relation`;
						const err = walk(inner, target, oneHops + 1, `${at}.${k}.is`);
						if (err !== undefined) return err;
					}
				}
				continue;
			}
			const f = x.model.fields.get(k);
			if (f !== undefined && isJsonObject(v)) {
				if (['json', 'object', 'record', 'union'].includes(f.kind)) {
					const err = checkInlineUi(f.shape, v, false, `${at}.${k}`);
					if (err !== undefined) return err;
				} else if ('like' in v && !isVarObject(v['like'])) {
					if (typeof v['like'] !== 'string' || !validUiLike(v['like']))
						return `${at}.${k}.like: pattern must start and end with '%' and contain no unescaped '_'`;
				}
			}
		}
		return undefined;
	};
	if (q.where !== undefined) {
		const err = walk(q.where, root, 0, 'where');
		if (err !== undefined) return err;
	}
	if (q.order_by !== undefined) {
		const items = isJsonArray(q.order_by) ? q.order_by : [q.order_by];
		if (items.length === 0 || items.length > ORDER_MAX_KEYS)
			return `order_by: at most ${ORDER_MAX_KEYS} sort keys are allowed`;
		const seen = new Set<string>();
		const flat = (obj: Json, prefix: string): string | undefined => {
			if (obj === 'asc' || obj === 'desc') {
				if (seen.has(prefix)) return `order_by: duplicate sort key '${prefix}'`;
				seen.add(prefix);
				return undefined;
			}
			if (isJsonObject(obj) && Object.keys(obj).length === 1 && isPoint(obj['near'])) {
				if (seen.has(prefix)) return `order_by: duplicate sort key '${prefix}'`;
				seen.add(prefix);
				return undefined;
			}
			if (!isJsonObject(obj)) return `order_by: invalid sort value at '${prefix}'`;
			for (const [k, v] of Object.entries(obj)) {
				const err = flat(v, prefix === '' ? k : `${prefix}.${k}`);
				if (err !== undefined) return err;
			}
			return undefined;
		};
		for (const item of items) {
			const err = flat(item, '');
			if (err !== undefined) return err;
		}
	}
	return undefined;
}

function make_filter_describe(cfg: FilterDescribeConfig) {
	const m = cfg.manifest,
		cat = catalog_of(m);
	const reads = (a: Authority, c: string) => readsAny(a, c);
	const viewOf = (a: Authority, c: string) => {
		const output = viewOutput(m, a, c) ?? DEFAULT_OUTPUT;
		return catalog_for(cat, c, output).pipe(
			Effect.map((view) => ({ output, cat: view })),
			Effect.mapError(from_store)
		);
	};
	const readAs = Effect.fnUntraced(function* (
		a: Authority,
		c: string,
		q: Parameters<typeof ir.read>[2]
	) {
		const v = yield* viewOf(a, c);
		const read = yield* ir.read(v.cat, c, q);
		return v.output === DEFAULT_OUTPUT ? read : { ...read, output: v.output };
	});
	const owner = (x: ExposureInfo) => x.path.split('.')[0] ?? x.path;
	const spec = (c: string, f: string) => m.models[c]?.fields[f];
	const nameOf = (c: string, f: string, fallback = f) =>
		m.messages?.[`models.${c}.fields.${f}`] ?? human(fallback);
	const helpOf = (c: string, f: string) => m.messages?.[`models.${c}.help.${f}`];

	/** Catalogue fields for `filter.options` (manual builder). Reads nothing. */
	const fieldsOf = Effect.fnUntraced(function* (
		model: string,
		a: Authority,
		b: Bindings
	): Effect.fn.Return<Field[], BoltError> {
		const view = (yield* viewOf(a, model)).cat,
			out: Field[] = [];
		const walk = (
			tc: ExposureInfo,
			steps: readonly FilterStep[],
			prefix: string,
			sortFrom: string | undefined,
			hops: number,
			back?: string
		) => {
			const target = tc.name;
			if (!reads(a, owner(tc))) return;
			for (const f of tc.model.fields.values()) {
				const s = spec(target, f.name);
				const system = steps.length === 0 && (f.name === 'created_at' || f.name === 'updated_at');
				if (
					f.name.includes('.') ||
					(!system && s === undefined && !tc.model.one.has(f.name)) ||
					s?.hidden ||
					!exposed_field(tc, f.name)
				)
					continue;
				const rel = tc.model.one.get(f.name);
				const label =
					prefix +
					(system
						? f.name === 'created_at'
							? 'Created'
							: 'Updated'
						: nameOf(target, f.name, rel === undefined ? f.name : f.name.replace(/_id$/, '')));
				if (rel === undefined) {
					const o = fieldOptions(f, s, s?.optional === true, b.tz, b.today);
					if (o === undefined) continue;
					const sort =
						sortFrom === undefined || f.many || UNSORTABLE.has(f.kind)
							? undefined
							: sortFrom === ''
								? f.name
								: `${sortFrom}.${f.name}`;
					out.push({
						label,
						path: [...steps, { k: 'field', name: f.name }],
						kind: f.kind,
						...o,
						...(sort === undefined ? {} : { sort })
					});
					// Expand shaped inline JSON fields (`object` and discriminated `union`) up to depth 2 for manual picker parity
					if (s !== undefined && !f.many && ['json', 'object', 'union'].includes(f.kind)) {
						const pushInline = (
							basePath: readonly FilterStep[],
							baseLabel: string,
							shape: Kind,
							depth: number
						) => {
							const inner = shape.kind === 'json' && shape.many !== true && shape.shape !== undefined ? shape.shape : shape;
							if (inner.many === true || depth > 2) return;
							if (inner.kind === 'object') {
								for (const [kName, child] of Object.entries(inner.fields)) {
									const nextPath: readonly FilterStep[] = [...basePath, { k: 'field', name: kName }];
									const nextLabel = `${baseLabel} › ${human(kName)}`;
									const childInfo = fieldOptions(
										child.many === true ? { kind: child.kind, many: true } : { kind: child.kind },
										child,
										child.optional === true,
										b.tz,
										b.today
									);
									if (childInfo !== undefined)
										out.push({ label: nextLabel, path: nextPath, kind: child.kind, ...childInfo });
									pushInline(nextPath, nextLabel, child, depth + 1);
								}
							} else if (inner.kind === 'union' && 'arms' in inner) {
								const discKind: Kind = { kind: 'enum', values: Object.keys(inner.arms) };
								const discOpts = fieldOptions({ kind: 'enum' }, discKind, false, b.tz, b.today);
								if (discOpts !== undefined)
									out.push({
										label: `${baseLabel} › ${human(inner.by)}`,
										path: [...basePath, { k: 'field', name: inner.by }],
										kind: 'enum',
										...discOpts
									});
								for (const [armName, armFields] of Object.entries(inner.arms)) {
									const parent = basePath.at(-1);
									if (parent?.k !== 'field') continue;
									const armPath: readonly FilterStep[] = [
										...basePath.slice(0, -1),
										{ k: 'arm', rel: parent.name, arm: armName }
									];
									const armLabel = `${baseLabel} (${human(armName)})`;
									for (const [kName, child] of Object.entries(armFields)) {
										const nextPath: readonly FilterStep[] = [...armPath, { k: 'field', name: kName }];
										const nextLabel = `${armLabel} › ${human(kName)}`;
										const childInfo = fieldOptions(
											child.many === true ? { kind: child.kind, many: true } : { kind: child.kind },
											child,
											child.optional === true,
											b.tz,
											b.today
										);
										if (childInfo !== undefined)
											out.push({ label: nextLabel, path: nextPath, kind: child.kind, ...childInfo });
										pushInline(nextPath, nextLabel, child, depth + 1);
									}
								}
							}
						};
						pushInline([...steps, { k: 'field', name: f.name }], label, s, 1);
					}
					continue;
				}
				if (hops === 0 || back === `${target}.${f.name}`) continue;
				for (const arm of rel.targets.length > 1 ? rel.targets : [undefined]) {
					const at = arm ?? rel.targets[0];
					if (at === undefined) continue;
					const optional = m.relationships[`${target}.${f.name}`]?.optional === true;
					const field: Field = {
						label: arm === undefined ? label : `${label} (${human(arm)})`,
						kind: 'record',
						path: [
							...steps,
							arm === undefined ? { k: 'field', name: f.name } : { k: 'arm', rel: f.name, arm }
						],
						ops: [...EQUALITY_OPS, ...(optional ? NULL_OPS : [])],
						values: []
					};
					if (at === 'sys_user') field.values.push({ label: 'me', arg: { var: 'actor.id' } });
					if (a.actor.kind === 'member' && a.actor.party?.model === at)
						field.values.push({ label: 'my party', arg: { var: 'actor.party' } });
					out.push(field);
					const layer = levelOf(view, tc, f.name, at);
					if (layer !== undefined)
						walk(
							layer,
							[
								...steps,
								arm === undefined ? { k: 'is', rel: f.name } : { k: 'arm', rel: f.name, arm }
							],
							`${field.label} › `,
							arm === undefined && steps.length === 0 ? f.name : undefined,
							hops - 1,
							`${target}.${f.name}`
						);
				}
			}
			if (hops > 0 && steps.every((x) => x.k === 'is'))
				for (const [r, rel] of tc.model.many) {
					const child = levelOf(view, tc, r, rel.child);
					if (
						child === undefined ||
						rel.column.includes('__') ||
						back === `${rel.child}.${rel.column}`
					)
						continue;
					const rl = prefix + human(r);
					for (const [q, word] of steps.length === 0
						? ([
								['some', 'any'],
								['every', 'all'],
								['none', 'none']
							] as const)
						: ([
								['some', 'any'],
								['none', 'none']
							] as const))
						walk(child, [...steps, { k: q, rel: r }], `${rl} (${word}) › `, undefined, 0);
					out.push({
						label: `${prefix}Number of ${human(r).toLowerCase()}`,
						path: [...steps, { k: 'count', rel: r }],
						kind: 'count',
						ops: CMP_OPS,
						values: [
							{ label: '0', arg: { lit: 0 } },
							{ label: '1', arg: { lit: 1 } }
						]
					});
					for (const f of child.model.fields.values()) {
						const s = spec(rel.child, f.name);
						if (s === undefined || s.hidden || f.many || !exposed_field(child, f.name)) continue;
						for (const [word, fn] of AGGS)
							if (can_aggregate_where(f.kind, fn))
								out.push({
									label: `${rl} › ${DAY_KINDS.has(f.kind) ? (fn === 'max' ? 'latest' : 'earliest') : word} ${nameOf(rel.child, f.name).toLowerCase()}`,
									path: [...steps, { k: 'agg', rel: r, fn, of: f.name }],
									kind: f.kind,
									ops: DAY_KINDS.has(f.kind) ? [...DATE_OPS] : CMP_OPS,
									values: DAY_KINDS.has(f.kind)
										? fieldOptions(f, s, false, b.tz, b.today)?.values ?? []
										: []
								});
					}
				}
			const whole = (fs: readonly string[]) => fs.every((x) => exposed_field(tc, x));
			if (tc.model.search.length > 0 && whole(tc.model.search))
				out.push({
					label: `${prefix}Search`,
					path: [...steps, { k: 'field', name: '$search' }],
					kind: 'search',
					ops: [{ op: 'search', label: 'has all the words' }],
					values: []
				});
			if (tc.model.semantic !== undefined && whole(tc.model.semantic.fields))
				out.push({
					label: `${prefix}Topic`,
					path: [...steps, { k: 'field', name: '$similar' }],
					kind: 'semantic',
					ops: [{ op: 'similar', label: 'is about' }],
					values: []
				});
		};
		const root = view.exposures.get(model);
		if (root !== undefined) walk(root, [], '', '', OPTIONS_MAX_HOPS);
		return out;
	});

	/** Compact, cacheable schema description of the caller's exposed view for `ai.infer`. */
	const schemaOf = Effect.fnUntraced(function* (model: string, a: Authority) {
		const view = (yield* viewOf(a, model)).cat;
		const root = view.exposures.get(model);
		if (root === undefined) return yield* Effect.fail(refuse(`'${model}' is not read by this caller`));
		const sortableKeys: string[] = [];
		const nearestSortFields: string[] = [];
		const lookupTargets = new Set<string>([model]);

		const describeLayer = (
			tc: ExposureInfo,
			depth: number,
			oneHops: number,
			sortPrefix: string | undefined,
			back: string | undefined,
			seen: ReadonlySet<string>
		): Json => {
			const target = tc.name;
			const fields: { [name: string]: Json } = {};
			const oneRels: { [name: string]: Json } = {};
			const manyRels: { [name: string]: Json } = {};
			for (const f of tc.model.fields.values()) {
				const s = spec(target, f.name);
				const system = depth === 0 && (f.name === 'created_at' || f.name === 'updated_at');
				if (
					f.name.includes('.') ||
					(!system && s === undefined && !tc.model.one.has(f.name)) ||
					s?.hidden ||
					!exposed_field(tc, f.name)
				)
					continue;
				const rel = tc.model.one.get(f.name);
				if (rel === undefined) {
					if (f.kind === 'file' || f.kind === 'vector' || f.kind === 'custom' || f.kind === 'ref')
						continue;
					const label = system
						? f.name === 'created_at'
							? 'Created'
							: 'Updated'
						: nameOf(target, f.name);
					const hint = system
						? f.name === 'created_at'
							? 'when this top-level record was created in the workspace'
							: 'when this top-level record was last updated in the workspace'
						: helpOf(target, f.name);
					const info: { [k: string]: Json } = { label, kind: f.kind };
					if (f.many) info['many'] = true;
					if (s?.optional === true) info['optional'] = true;
					if (f.period_of !== undefined) info['period_of'] = f.period_of;
					if (f.team) info['actor_var'] = 'actor.teams';
					if (f.email) info['actor_var'] = 'actor.email';
					if (hint !== undefined) info['help'] = hint;
					if (s?.kind === 'enum') info['values'] = [...s.values];
					if (s?.kind === 'state') {
						info['values'] = Object.keys(s.states);
						const finals = Object.entries(s.states)
							.filter(([, st]) => (st.to ?? []).length === 0)
							.map(([name]) => name);
						if (finals.length > 0) info['final_states'] = finals;
					}
					if (f.kind === 'json' && s !== undefined) {
						const shape = shapeSummary(s);
						if (shape !== undefined) info['shape'] = shape;
					}
					fields[f.name] = info;
					if (sortPrefix !== undefined) {
						const key = sortPrefix === '' ? f.name : `${sortPrefix}.${f.name}`;
						if (!f.many && !UNSORTABLE.has(f.kind)) sortableKeys.push(key);
						if (!f.many && f.kind === 'point') nearestSortFields.push(key);
					}
					continue;
				}
				if (back === `${target}.${f.name}`) continue;
				const optional = m.relationships[`${target}.${f.name}`]?.optional === true;
				const label = nameOf(target, f.name, f.name.replace(/_id$/, ''));
				const relInfo: { [k: string]: Json } = {
					label,
					targets: [...rel.targets],
					...(optional ? { optional: true } : {})
				};
				if (rel.targets.length === 1) {
					const t = rel.targets[0];
					if (t !== undefined) {
						if (reads(a, t)) lookupTargets.add(t);
						if (t === 'sys_user') relInfo['actor_var'] = 'actor.id';
						if (a.actor.kind === 'member' && a.actor.party?.model === t)
							relInfo['actor_var'] = 'actor.party';
						const layer = levelOf(view, tc, f.name, t);
						if (layer !== undefined && depth < SCHEMA_MAX_DEPTH && oneHops < 2 && !seen.has(layer.path)) {
							const nextSeen = new Set(seen);
							nextSeen.add(layer.path);
							relInfo['layer'] = describeLayer(
								layer,
								depth + 1,
								oneHops + 1,
								depth === 0 ? f.name : undefined,
								`${target}.${f.name}`,
								nextSeen
							);
						}
					}
				} else {
					const arms: { [arm: string]: Json } = {};
					for (const arm of rel.targets) {
						if (reads(a, arm)) lookupTargets.add(arm);
						const layer = levelOf(view, tc, f.name, arm);
						if (layer !== undefined && depth < SCHEMA_MAX_DEPTH && oneHops < 2 && !seen.has(layer.path)) {
							const nextSeen = new Set(seen);
							nextSeen.add(layer.path);
							arms[arm] = describeLayer(
								layer,
								depth + 1,
								oneHops + 1,
								undefined,
								`${target}.${f.name}`,
								nextSeen
							);
						}
					}
					if (Object.keys(arms).length > 0) relInfo['arms'] = arms;
				}
				oneRels[f.name] = relInfo;
			}
			if (depth < SCHEMA_MAX_DEPTH && oneHops <= 1) {
				for (const [r, rel] of tc.model.many) {
					const child = levelOf(view, tc, r, rel.child);
					if (
						child === undefined ||
						rel.column.includes('__') ||
						back === `${rel.child}.${rel.column}` ||
						seen.has(child.path)
					)
						continue;
					if (reads(a, rel.child)) lookupTargets.add(rel.child);
					const aggregates: { [field: string]: string[] } = {};
					for (const f of child.model.fields.values()) {
						const s = spec(rel.child, f.name);
						if (s === undefined || s.hidden || f.many || !exposed_field(child, f.name)) continue;
						const fns = (['sum', 'avg', 'min', 'max'] as const).filter((fn) =>
							can_aggregate_where(f.kind, fn)
						);
						if (fns.length > 0) aggregates[f.name] = [...fns];
					}
					const nextSeen = new Set(seen);
					nextSeen.add(child.path);
					manyRels[r] = {
						label: human(r),
						child: rel.child,
						...(Object.keys(aggregates).length > 0 ? { aggregates } : {}),
						layer: describeLayer(
							child,
							depth + 1,
							0,
							undefined,
							`${rel.child}.${rel.column}`,
							nextSeen
						)
					};
				}
			}
			const whole = (fs: readonly string[]) => fs.every((x) => exposed_field(tc, x));
			const desc = m.models[target]?.description;
			return {
				model: target,
				...(depth === 0 && desc !== undefined ? { description: desc } : {}),
				fields,
				...(Object.keys(oneRels).length > 0 ? { one_relations: oneRels } : {}),
				...(Object.keys(manyRels).length > 0 ? { many_relations: manyRels } : {}),
				...(tc.model.search.length > 0 && whole(tc.model.search)
					? { $search: [...tc.model.search] }
					: {}),
				...(tc.model.semantic !== undefined && whole(tc.model.semantic.fields)
					? { $similar: [...tc.model.semantic.fields] }
					: {})
			};
		};

		const rootSchema = describeLayer(root, 0, 0, '', undefined, new Set([root.path]));
		// Also advertise readable dated models for named holidays/events ("after National Day")
		let datedCount = 0;
		for (const name of cat.exposures.keys()) {
			if (datedCount >= MAX_DATED_MODELS || name.startsWith('sys_') || !reads(a, name)) continue;
			const x = (yield* viewOf(a, name)).cat.exposures.get(name);
			if (x === undefined) continue;
			const hasText = [...x.model.fields.values()].some(
				(f) => f.kind === 'text' && !f.many && exposed_field(x, f.name)
			);
			const hasDate = [...x.model.fields.values()].some(
				(f) => f.kind === 'date' && !f.many && exposed_field(x, f.name)
			);
			if (hasText && hasDate) {
				lookupTargets.add(name);
				datedCount++;
			}
		}
		const lookupModels: { [name: string]: Json } = {};
		for (const target of lookupTargets) {
			if (!reads(a, target)) continue;
			const x = (yield* viewOf(a, target)).cat.exposures.get(target);
			if (x === undefined) continue;
			const labelField = label_paths(m.models[target]?.record_label)[0] ?? 'name';
			const textFields = [
				...new Set([
					...(exposed_field(x, labelField) && x.model.fields.get(labelField)?.kind === 'text'
						? [labelField]
						: []),
					...x.model.search.filter(
						(f) => exposed_field(x, f) && x.model.fields.get(f)?.kind === 'text'
					)
				])
			];
			const dateFields = [...x.model.fields.values()]
				.filter((f) => f.kind === 'date' && !f.many && exposed_field(x, f.name))
				.map((f) => f.name);
			const pointFields = [...x.model.fields.values()]
				.filter((f) => f.kind === 'point' && !f.many && exposed_field(x, f.name))
				.map((f) => f.name);
			lookupModels[target] = {
				...(textFields.length > 0 ? { text_fields: textFields } : {}),
				...(dateFields.length > 0 ? { date_fields: dateFields } : {}),
				...(pointFields.length > 0 ? { point_fields: pointFields } : {})
			};
		}
		return {
			view,
			schema: {
				root: rootSchema,
				sortable_keys: sortableKeys,
				...(nearestSortFields.length > 0 ? { nearest_sort_fields: nearestSortFields } : {}),
				lookup_models: lookupModels
			}
		};
	});

	/** Caller-scoped lookup tool: resolves named records, coordinates, or named days on demand. */
	const makeLookupTool = (a: Authority, b: Bindings): InferTool => ({
		name: 'lookup',
		behavior: { data: true },
		description:
			'Search readable workspace records (as the caller) to resolve a named record ID, location coordinates, or a named holiday/event date. Pass { model, query?, limit? }.',
		input: {
			type: 'object',
			additionalProperties: false,
			required: ['model'],
			properties: {
				model: { type: 'string', description: 'Model name from lookup_models' },
				query: { type: 'string', description: 'Name, phrase, or keyword to match' },
				limit: { type: 'integer', minimum: 1, maximum: LOOKUP_MAX_ROWS }
			}
		},
		call: (raw) =>
			Effect.gen(function* () {
				const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(LookupInput)(raw));
				if (parsed === undefined)
					return { error: 'lookup takes { model: string, query?: string, limit?: 1..10 }' };
				if (!cat.exposures.has(parsed.model) || !reads(a, parsed.model))
					return { error: `Model '${parsed.model}' is not readable by this caller.` };
				const targetView = (yield* viewOf(a, parsed.model)).cat.exposures.get(parsed.model);
				if (targetView === undefined)
					return { error: `Model '${parsed.model}' is not readable by this caller.` };
				const labelField = label_paths(m.models[parsed.model]?.record_label)[0] ?? 'name';
				const textFields = [
					...new Set([
						...(exposed_field(targetView, labelField) &&
						targetView.model.fields.get(labelField)?.kind === 'text'
							? [labelField]
							: []),
						...targetView.model.search.filter(
							(f) => exposed_field(targetView, f) && targetView.model.fields.get(f)?.kind === 'text'
						),
						...[...targetView.model.fields.values()]
							.filter(
								(f) =>
									f.kind === 'text' &&
									!f.many &&
									!spec(parsed.model, f.name)?.hidden &&
									exposed_field(targetView, f.name)
							)
							.slice(0, 3)
							.map((f) => f.name)
					])
				];
				const extraFields = [...targetView.model.fields.values()]
					.filter(
						(f) =>
							(f.kind === 'date' || f.kind === 'point' || f.kind === 'enum' || f.kind === 'state') &&
							!f.many &&
							!spec(parsed.model, f.name)?.hidden &&
							exposed_field(targetView, f.name)
					)
					.slice(0, 6)
					.map((f) => f.name);
				const select = Object.fromEntries(
					[...new Set([...textFields, ...extraFields])]
						.filter((f) => exposed_field(targetView, f))
						.map((f) => [f, true])
				);
				const limit = parsed.limit ?? 5;
				const qText = parsed.query?.trim() ?? '';
				const runQuery = (q: Parameters<typeof ir.read>[2]) =>
					readAs(a, parsed.model, q).pipe(
						Effect.flatMap((read) => cfg.read([read], { as: 'caller', authority: a }, b)),
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Array(
									Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
								)
							)
						),
						Effect.map((pages): readonly RowData[] => pages[0]?.rows ?? [])
					);
				let rows: readonly RowData[] = [];
				if (qText !== '' && targetView.model.search.length > 0) {
					rows = yield* runQuery({ search: qText, select, limit });
				}
				if (rows.length === 0 && qText !== '' && textFields.length > 0) {
					const pattern = `%${qText.split(/\s+/).map(esc).join('%')}%`;
					const where: Json =
						textFields.length === 1 && textFields[0] !== undefined
							? { [textFields[0]]: { like: pattern } }
							: { or: textFields.map((f) => ({ [f]: { like: pattern } })) };
					rows = yield* runQuery({ where, select, limit });
				}
				if (rows.length === 0 && qText === '') {
					rows = yield* runQuery({ select, limit });
				}
				return {
					model: parsed.model,
					rows: rows.map((row) => row)
				};
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed<Json>({
						error: error instanceof Error ? error.message : String(error)
					})
				)
			)
	});

	const catalogue = (fields: readonly Field[]): FilterCatalogue =>
		fields.flatMap((f) =>
			f.ops.map((o) => ({
				label: f.label,
				path: f.path,
				op: o.op,
				opLabel: o.label,
				kind: f.kind,
				...(o.op === 'during' && f.values.length > 0 ? { values: f.values } : {}),
				...(f.sort === undefined ? {} : { sort: f.sort })
			}))
		);

	const localFields = (fs: readonly LocalFilterField[], today: string): Field[] =>
		fs.flatMap<Field>((f) => {
			const offered = fieldOptions({ kind: f.kind }, undefined, f.optional === true, m.workspace.tz, today);
			return offered === undefined
				? []
				: [
						{
							label: f.label,
							path: [{ k: 'field', name: f.name }],
							kind: f.kind,
							...offered,
							sort: f.name
						}
					];
		});

	const subject = (
		o: { model: string; authority: Authority; localFields?: readonly LocalFilterField[] },
		today: string
	): { fields?: Field[]; local?: readonly LocalFilterField[]; fail?: Failed } => {
		if (o.model !== '$local')
			return !cat.exposures.has(o.model) || !reads(o.authority, o.model)
				? { fail: { ok: false, code: 'not_found', message: 'Not found or no access.' } }
				: {};
		const fields = o.localFields;
		if (
			fields === undefined ||
			fields.length === 0 ||
			fields.length > 50 ||
			fields.some(
				(f) =>
					!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(f.name) ||
					f.label.length > 100 ||
					!['text', 'number', 'bool'].includes(f.kind)
			)
		)
			return { fail: { ok: false, code: 'invalid', message: 'Invalid local filter fields.' } };
		return { fields: localFields(fields, today), local: fields };
	};

	const describe = Effect.fn('Agents.describe')(function* (o: {
		model: string;
		text: string;
		authority: Authority;
		bindings: Bindings;
		localFields?: readonly LocalFilterField[];
		onStep?: (step: DescribeStep) => void;
	}): Effect.fn.Return<Described, EngineError> {
		const steps: DescribeStep[] = [];
		const emit = (step: DescribeStep) => {
			const idx = steps.findIndex((s) => s.id === step.id);
			if (idx >= 0) steps[idx] = step;
			else steps.push(step);
			o.onStep?.(step);
		};
		const fail = (message: string, code = 'invalid'): Described => ({
			ok: false,
			code,
			message,
			...(steps.length > 0 ? { steps: [...steps] } : {})
		});
		if (o.text.trim() === '' || o.text.length > FILTER_MAX_TEXT)
			return fail(`A description is 1–${FILTER_MAX_TEXT} characters.`);
		const subjectOf = subject(o, o.bindings.today);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const local = o.model === '$local';
		const modelContext = local ? undefined : yield* schemaOf(o.model, o.authority);
		const schemaPayload: Json = local
			? {
					model: '$local',
					fields: Object.fromEntries(
						(subjectOf.local ?? []).map((f) => [
							f.name,
							{ label: f.label, kind: f.kind, ...(f.optional ? { optional: true } : {}) }
						])
					),
					sortable_keys: (subjectOf.local ?? []).map((f) => f.name)
				}
			: (modelContext?.schema ?? {});

		const validate = (raw: Json): Effect.Effect<CrossAnswer> =>
			Effect.gen(function* () {
				if (!isJsonObject(raw))
					return { ok: false, error: { kind: 'invalid', message: 'Answer must be an object with where and/or order_by.' } };
				const hasWhere = raw['where'] !== undefined && isJsonObject(raw['where']) && Object.keys(raw['where']).length > 0;
				const hasOrder =
					raw['order_by'] !== undefined &&
					((isJsonObject(raw['order_by']) && Object.keys(raw['order_by']).length > 0) ||
						(EffectArray.isArray(raw['order_by']) && raw['order_by'].length > 0));
				if (!hasWhere && !hasOrder)
					return {
						ok: false,
						error: {
							kind: 'invalid',
							message: 'Provide at least one of where or order_by, or call refuse if the description cannot be expressed.'
						}
					};
				const candidate: { where?: Json; order_by?: Json } = {
					...(hasWhere ? { where: raw['where'] } : {}),
					...(hasOrder ? { order_by: raw['order_by'] } : {})
				};
				if (local) {
					const err = validateLocal(subjectOf.local ?? [], candidate);
					return err === undefined
						? { ok: true, value: candidate }
						: { ok: false, error: { kind: 'invalid', message: err } };
				}
				const view = modelContext?.view;
				if (view === undefined)
					return { ok: false, error: { kind: 'invalid', message: `'${o.model}' is not accessible.` } };
				const decoded = yield* Effect.result(
					decodeDescribed(view, o.authority, o.model, candidate, o.bindings)
				);
				if (Result.isFailure(decoded))
					return { ok: false, error: { kind: 'invalid', message: decoded.failure.message } };
				const uiErr = checkUiCompatible(view, o.model, candidate);
				if (uiErr !== undefined)
					return { ok: false, error: { kind: 'invalid', message: uiErr } };
				return { ok: true, value: candidate };
			});

		const system = `${FILTER_SYSTEM_PROMPT}\n\n## Exposed schema\n\`\`\`json\n${JSON.stringify(schemaPayload)}\n\`\`\``;
		const prompt = JSON.stringify({
			description: o.text.trim(),
			today: o.bindings.today,
			timezone: o.bindings.tz,
			locale: m.workspace.locale,
			weekStartsOn: 'Monday'
		});
		const tools: InferTool[] = local ? [] : [makeLookupTool(o.authority, o.bindings)];
		const activeLookups = new Map<string, { model: string; query?: string }>();
		let currentThinkId: string | undefined;
		let needsAdjust = false;
		const modelTitle = (name: string) => m.messages?.[`models.${name}.label`] ?? human(name);
		const onProgress = (event: InferProgress): Effect.Effect<void> =>
			Effect.sync(() => {
				if (event.kind === 'thinking') {
					const id = `think-${event.turn}`;
					currentThinkId = id;
					const label =
						event.turn === 1
							? 'Understanding request…'
							: needsAdjust
								? 'Adjusting filter…'
								: 'Planning filter…';
					emit({ id, label, status: 'running' });
					return;
				}
				if (currentThinkId !== undefined) {
					const prev = steps.find((s) => s.id === currentThinkId);
					if (prev !== undefined && prev.status === 'running') {
						emit({
							id: prev.id,
							label: prev.label
								.replace(/^Understanding request…$/, 'Understood request')
								.replace(/^Adjusting filter…$/, 'Adjusted filter')
								.replace(/^Planning filter…$/, 'Planned filter'),
							status: 'done'
						});
					}
					currentThinkId = undefined;
				}
				if (event.kind === 'tool_start') {
					if (event.name === 'lookup') {
						const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(LookupInput)(event.input));
						const target = parsed?.model ?? 'records';
						const query = parsed?.query?.trim();
						activeLookups.set(event.id, { model: target, ...(query ? { query } : {}) });
						const title = modelTitle(target);
						emit({
							id: event.id,
							label: query ? `Looking up ${title} matching “${query}”…` : `Checking ${title}…`,
							status: 'running'
						});
					} else if (event.name === 'edit') {
						emit({ id: event.id, label: 'Building filter rules…', status: 'running' });
					} else if (event.name === 'submit') {
						emit({ id: event.id, label: 'Checking filter…', status: 'running' });
					} else if (event.name === 'refuse') {
						emit({ id: event.id, label: 'Checking request…', status: 'running' });
					}
					return;
				}
				if (event.name === 'lookup') {
					const info = activeLookups.get(event.id);
					const title = modelTitle(info?.model ?? 'records');
					const rows =
						isJsonObject(event.result) && isJsonArray(event.result['rows'])
							? event.result['rows']
							: undefined;
					const errText =
						isJsonObject(event.result) && typeof event.result['error'] === 'string'
							? event.result['error']
							: undefined;
					if (errText !== undefined) {
						emit({ id: event.id, label: `Lookup failed for ${title}`, detail: errText, status: 'error' });
					} else {
						const count = rows?.length ?? 0;
						const qSuffix = info?.query ? ` for “${info.query}”` : '';
						emit({
							id: event.id,
							label:
								count === 0
									? `No ${title} matches${qSuffix}`
									: `Found ${count} ${title} ${count === 1 ? 'match' : 'matches'}${qSuffix}`,
							status: 'done'
						});
					}
				} else if (event.name === 'edit') {
					const errCount =
						isJsonObject(event.result) && isJsonArray(event.result['errors'])
							? event.result['errors'].length
							: 0;
					const ok = event.ok && errCount === 0;
					if (!ok) needsAdjust = true;
					emit({
						id: event.id,
						label: ok ? 'Built filter rules' : 'Filter rules needed adjustment',
						status: ok ? 'done' : 'error'
					});
				} else if (event.name === 'submit') {
					const errText =
						isJsonObject(event.result) && typeof event.result['error'] === 'string'
							? event.result['error']
							: undefined;
					if (!event.ok || errText !== undefined) {
						needsAdjust = true;
						emit({
							id: event.id,
							label: 'Filter needed adjustment',
							...(errText !== undefined ? { detail: errText.slice(0, 140) } : {}),
							status: 'error'
						});
					} else {
						emit({ id: event.id, label: 'Verified filter', status: 'done' });
					}
				} else if (event.name === 'refuse') {
					const msgText =
						isJsonObject(event.result) && typeof event.result['message'] === 'string'
							? event.result['message']
							: undefined;
					emit({
						id: event.id,
						label: 'Could not express filter',
						...(msgText !== undefined ? { detail: msgText.slice(0, 140) } : {}),
						status: 'error'
					});
				}
			});

		const infer = infer_facility(cfg.ai, {
			wallMs: FILTER_DEADLINE_MS,
			reasoningEffort: 'low',
			validate,
			onProgress
		});
		const answer = yield* infer(
			{
				_tag: 'ai.sys_2.infer',
				args: [
					{
						model: 'default',
						system,
						prompt,
						output: { json_schema: FILTER_OUTPUT_SCHEMA },
						steps: FILTER_MAX_STEPS,
						...(tools.length > 0 ? { tools: tools.map((t) => t.name) } : {})
					}
				]
			},
			tools
		).pipe(
			Effect.catch((error): Effect.Effect<CrossAnswer> =>
				Effect.succeed({
					ok: false,
					error:
						error._tag === 'Unavailable'
							? { kind: 'unavailable', facility: error.facility, reason: error.reason }
							: {
									kind: error.kind,
									message: error.message,
									...(error.status === undefined ? {} : { status: error.status })
								}
				})
			)
		);
		if (currentThinkId !== undefined) {
			const prev = steps.find((s) => s.id === currentThinkId);
			if (prev !== undefined && prev.status === 'running') {
				emit({
					id: prev.id,
					label: prev.label.replace(/…$/, ''),
					status: answer.ok ? 'done' : 'error'
				});
			}
			currentThinkId = undefined;
		}
		if (!answer.ok) {
			if (answer.error.kind === 'unavailable')
				return fail('AI filtering is not configured for this workspace.', 'unavailable');
			if (answer.error.kind === 'timeout')
				return fail('Describing this filter took too long. Try again.', 'timeout');
			if (answer.error.kind === 'rate_limited')
				return fail('Too many filter requests. Try again shortly.', 'rate_limited');
			return fail(
				answer.error.message || 'Could not build a filter from that description.',
				answer.error.kind
			);
		}
		const out = isJsonObject(answer.value) ? answer.value : {};
		return {
			ok: true,
			...(out['where'] === undefined ? {} : { where: out['where'] }),
			...(out['order_by'] === undefined ? {} : { order_by: out['order_by'] }),
			...(steps.length > 0 ? { steps: [...steps] } : {})
		};
	});

	const opts = Effect.fn('Agents.opts')(function* (o: {
		model: string;
		authority: Authority;
		bindings: Bindings;
		localFields?: readonly LocalFilterField[];
	}): Effect.fn.Return<FilterOptions, BoltError> {
		const subjectOf = subject(o, o.bindings.today);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		return {
			ok: true,
			fields: catalogue(subjectOf.fields ?? (yield* fieldsOf(o.model, o.authority, o.bindings)))
		};
	});

	return {
		describe: (input: Parameters<typeof describe>[0]) =>
			describe(input).pipe(
				Effect.timeoutOrElse({
					duration: FILTER_DEADLINE_MS,
					orElse: () =>
						Effect.succeed<Described>({
							ok: false,
							code: 'timeout',
							message: 'Describing this filter took too long. Try again.'
						})
				})
			),
		options: opts
	};
}

export const filter_describe = Effect.gen(function* () {
	const manifest = yield* Manifest,
		reads = yield* Reads,
		ai = yield* Ai;
	return make_filter_describe({ manifest, read: reads.run, ai });
});

const refuse = (message: string) => BoltError.make('invalid', 'decode', message);

/**
 * The strict decode of a described filter and sort: `ir.where`/`ir.order`'s grammar, and every
 * field, relation and sort key within what the caller reads — the models it reads, their exposed fields
 * and relations, one-relation keys it reads. Anything else is `invalid`; nothing is dropped silently.
 */
const decodeDescribed = Effect.fnUntraced(function* (
	cat: Catalog,
	a: Authority,
	model: string,
	q: { where?: Json; order_by?: Json },
	at: { readonly today: string; readonly now: string }
): Effect.fn.Return<void, BoltError> {
	const root = cat.exposures.get(model);
	if (root === undefined || !readsAny(a, model))
		return yield* refuse(`'${model}' is not read by this caller`);
	const field = (x: ExposureInfo, f: string) => {
		const base = f.split('.')[0] ?? f;
		if (!exposed_field(x, base)) throw refuse(`'${x.path}.${f}' is not a field this caller reads`);
	};
	const rel = (x: ExposureInfo, r: string, target: string) => {
		const t = levelOf(cat, x, r, target);
		if (t === undefined) throw refuse(`'${x.path}.${r}' is not a relation this caller reads`);
		return t;
	};
	const walk = (p: Pred, x: ExposureInfo): void => {
		switch (p.t) {
			case 'const':
			case 'search':
			case 'similar':
				return;
			case 'and':
			case 'or':
				return p.of.forEach((y) => walk(y, x));
			case 'not':
				return walk(p.of, x);
			case 'one':
			case 'many':
				return walk(p.pred, rel(x, p.rel, p.target));
			case 'count':
				rel(x, p.rel, p.target);
				return;
			case 'agg':
				return field(rel(x, p.rel, p.target), p.of);
			case 'cmp':
				field(x, p.field);
				if (p.arg._tag === 'Field') field(x, p.arg.field);
				return;
			default:
				return field(x, p.field);
		}
	};
	const where =
		q.where === undefined
			? undefined
			: yield* decodeWhere(cat, model, materialize(q.where, at)).pipe(Effect.mapError(from_store));
	const keys =
		q.order_by === undefined
			? []
			: yield* order(q.order_by, cat, model).pipe(Effect.mapError(from_store));
	yield* Effect.try({
		try: () => {
			if (where !== undefined) walk(where, root);
			for (const k of keys) {
				const steps = k.field.split('.');
				let x = root;
				for (const s of steps.slice(0, -1))
					x = rel(x, s, x.model.one.get(s)?.targets[0] ?? '');
				field(x, steps.at(-1) ?? k.field);
			}
		},
		catch: (error) => (error instanceof BoltError ? error : refuse(String(error)))
	});
});
