// AI filtering: the view popover's "Describe what to show…" becomes a typed `Where` and an
// `OrderBy` key through ONE `sys_1` call. System 1 never writes a filter: it chooses among conditions the engine built.
//
//   1. Fields: the model's exposure narrowed to what the caller reads — own fields, one-relations and
//      many-relations (any / all / none, count, child totals) up to `FILTER_MAX_HOPS`, the search index (`$search`) and
//      the embedding (`$similar`). Plain data (`FilterStep` paths): `filter.options` hands the same catalogue to the builder.
//   2. Values: the description's own literals (dates, numbers, quoted strings, words, topic phrases), relative spans,
//      enum and state names, me / my team / my party, and ONE batched read as the caller: the records a relation's words
//      name (through the search index where declared), the phrases the model's own records hold, and named days —
//      a record the caller reads whose name the description holds and which has a date ("after National Day").
//   3. Conditions: per field, every (operator, value) its kind admits, each built and decoded as any read literal is
//      (`ir.where`). A condition that does not decode — a text operator on a number, a number against text, one day for
//      "is within" — is never offered, so it can never be chosen.
//   4. One call: per field one choice, "no condition" or one of its conditions (a list operator's values are a yes / no
//      each, as several can hold); one sort choice of (key, direction) or none; how the conditions combine; and whether
//      the ask needs a selection the grammar cannot express.
//   5. Relation predicates compose inside a shared quantifier (same-record AND); counts and aggregates stay separate.
//      Empty-list alternatives nest inside that relation group. The complete result decodes against the caller's exposure.
//
// No fallback (owner): a System 1 failure, or nothing chosen, applies nothing. The whole answers within
// `FILTER_DEADLINE_MS`. Sorting is by an own sortable field or, one hop through an exposed one-relation, a target field.
import { Array as EffectArray, Effect, Predicate, Result, Schema } from 'effect';
import { equal_json } from '@norbital-ai/store/kind';
import { label_paths } from '@norbital-ai/store/label';
import { KIND, type Kind } from '@norbital-ai/store/kind';
import type { ViewBolt } from '@norbital-ai/ui';
import { Ai } from '../ports.ts';
import { Decisions, Manifest, Reads, type DecisionsShape, type ReadsShape } from '../services.ts';
import { type DecisionRequest, Unavailable } from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, RowData } from '../contracts.ts';
import type { Pred } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import type { LocalFilterField } from '../../protocol/schema.ts';
import { type EngineError } from '../errors.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { choiceOf, noulOf, type DecisionEntry, type DecisionQuestion } from '../decision.ts';
import { catalog_of } from '../access/pred.ts';
import { readsAny, viewOutput } from '../access/authority.ts';
import { midnight, startOfDate } from '../query/eval.ts';
import { materialize } from '../runs/time.ts';
import {
	can_aggregate_where,
	catalog_for,
	DEFAULT_OUTPUT,
	exposed_field,
	UNSORTABLE,
	type Catalog,
	type ExposureInfo,
	type FieldInfo
} from '@norbital-ai/store';
import * as ir from '../../protocol/reads.ts';
import { order, where as decodeWhere } from '@norbital-ai/store';
/** A stored point (`{ lat, lng }`) among a row's values. */
const isPoint = Schema.is(Schema.Struct({ lat: Schema.Number, lng: Schema.Number }));
/** The stated conditions a description may produce. */
const FILTER_MAX_CONDITIONS = 12;
/** Fields asked about in the one request: the ones the description most plausibly names. */
const FILTER_MAX_FIELDS = 96;
const FILTER_MAX_TEXT = 500;
/** A description answers within this: its one read and its one `sys_1` call together. */
const FILTER_DEADLINE_MS = 3000;
/** Relation hops a condition path may take (a many-relation's quantifier is a hop). */
const FILTER_MAX_HOPS = 2;
const CANDIDATES = 5,
	WORDS = 8,
	MAX_TOPICS = 4;
/** Models searched for a named day, at most. ponytail: the first that hold a date; rank them if a workspace has more. */
const MAX_DATED = 8;
const NO = 'no condition',
	NO_ORDER = 'no particular order';
/** The likeness at which a typed token matches a label's token. */
const MATCH = 0.5;
/** A disjunction or a negation the text never states is System 1 misreading the composition. */
const DISJUNCTION = /\b(or|nor|either|neither|any of|whichever|ou|atau)\b|或者|或是|或|不是.*就是/i;
const NEGATION =
	/\b(neither|not all|none of (these|those|the conditions))\b|并非全部|並非全部|都不满足|都不滿足/i;
/** Words that put a day on a condition: only then are named days looked for. */
const DAY_WORDS =
	/\b(after|before|since|until|till|from|on|by|between|during|around|following|prior)\b/i;
const LIST_OPS = new Set(['in', 'not_in', 'has_any', 'has_all']);
const NO_VALUE = new Set(['is_null', 'not_null', 'is_empty', 'not_empty']);
const DAY_KINDS = new Set(['date', 'instant']);
/** The same catalogue and nesting paths the builder receives, without a browser runtime dependency. */
type CatalogueOffer = Effect.Success<ReturnType<NonNullable<ViewBolt['options']>>>['fields'][number];
type FilterStep = CatalogueOffer['path'][number];
/** A value offered for an operator: a literal, a list, a span (`[lo, hi)`) or an actor variable. */
type ActorVar = 'actor.id' | 'actor.email' | 'actor.party' | 'actor.teams';
type Point = { lat: number; lng: number };
type FilterArg = { echoed?: true } & (
	| { lit: Json }
	| { list: readonly Json[] }
	| { range: readonly [Json, Json] }
	| { var: ActorVar }
	/** A one-relation's records whose text field holds a phrase (the description's words a found record holds). */
	| { match: { field: string; phrase: string } }
	/** Within `metres` of a point (a found record's own location). */
	| { near: readonly [Point, number] }
);
type FilterValue = { label: string; arg: FilterArg };
type LiteralValue = { label: string; arg: Extract<FilterArg, { lit: Json }> };
/** One offered (field, operator) pair: a row the builder renders. Plain data. */
type FilterOffer = Omit<CatalogueOffer, 'values'> & { values?: readonly FilterValue[] };
type FilterCatalogue = readonly FilterOffer[];
type Failed = { ok: false; code: string; message: string };
type Described = { ok: true; where?: Json; order_by?: Json } | Failed;
type FilterOptions = Failed | { ok: true; fields: FilterCatalogue };
type Op = { op: CatalogueOffer['op']; label: string };
/** One field: its operators and values. */
type Field = {
	label: string;
	/** The field's declared help: what it means, in words a description may use ("when the person joined"). */
	hint?: string;
	path: readonly FilterStep[];
	kind: string;
	ops: readonly Op[];
	values: FilterValue[];
	sort?: string;
	/** The records the description's words found, named in its question. */ found?: string[];
	/** How strongly the description names the field: label words, a found record, one of its declared values. */ named?: number;
};
/** One whole condition System 1 may choose. `list`: a list operator's candidate values, each its own yes / no. */
type Cond = {
	label: string;
	op: string;
	arg?: FilterArg;
	list?: readonly LiteralValue[];
	value?: string;
	evidence: boolean;
	where: Json;
};
/** A sort System 1 may choose: a key and its direction, or nearest first from a found record. */
type Order = {
	label: string;
	key: string;
	dir: 'asc' | 'desc' | { near: Point };
};
const NUMERIC = new Set(
	Object.entries(KIND).filter(([, kind]) => kind.traits.numeric).map(([name]) => name)
);
const STOP = new Set(
	// from `sort` on: the sort's own words are never a value
	(
		'the and that this with for from are aren not isn all any show only first last next newest oldest week month ' +
		'year quarter today yesterday days done open what which who whose sort sorted order ordered ascending descending ' +
		'alphabetical alphabetically reverse highest lowest latest earliest'
	).split(' ')
);
const human = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
/**
 * Rule 16a's spans from `today`: day bounds on `date` fields as `{ var: 'today' }` variables, calendar bounds
 * (Monday weeks) on both; an instant's bound is that day's midnight in the workspace zone. A read takes values, never a time variable.
 */
function spans(kind: 'date' | 'instant', today: string, tz: string): FilterValue[] {
	const end = (date: string): Json => (kind === 'date' ? date : midnight(date, tz));
	const range = (lo: string, hi: string): FilterArg => ({ range: [end(lo), end(hi)] });
	const at = (unit: string, shift: number) => startOfDate({ unit, shift }, today);
	const out: FilterValue[] = [];
	if (kind === 'date') {
		// day spans stay time variables (`{ var: 'today - days(7)' }`): a kept filter rolls with the day; every
		// decode here materializes them, and so does the page before it reads
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
const MONTHS = 'january february march april may june july august september october november december'.split(' ');
const MONTH = String.raw`(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`,
	DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
/** "3rd October", "3 oct 2026", "the 3rd of October"; "October 3", "Oct 3rd, 2026". */
const DAY_MONTH = new RegExp(String.raw`\b${DAY}\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4}))?\b`, 'gi');
const MONTH_DAY = new RegExp(String.raw`\b${MONTH}\s+${DAY}(?:,?\s+(\d{4}))?\b`, 'gi');
/**
 * Quoted strings, numbers and dates (ISO, day-first `d/m/yyyy` — month-first in `en-US` — or a named month, its year
 * `today`'s when unstated) from the text.
 */
function literals(
	text: string,
	locale: string,
	today: string
): { strings: string[]; numbers: number[]; dates: string[] } {
	// Normalize numeral tokens, not surrounding words: the AI still sees the original description.
	const digits: Readonly<Record<string, number>> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
	text = text.replace(/[零〇一二两兩三四五六七八九十百千万萬]+/g, (token) => {
		if (![...token].some((ch) => digits[ch] === undefined))
			return [...token].map((ch) => digits[ch]).join('');
		let total = 0,
			section = 0,
			digit = 0;
		for (const ch of token) {
			if (digits[ch] !== undefined) digit = digits[ch];
			else if (ch === '万' || ch === '萬') {
				total += (section + digit) * 10000;
				section = 0;
				digit = 0;
			} else {
				section += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[ch] ?? 1);
				digit = 0;
			}
		}
		return String(total + section + digit);
	});
	const dates: string[] = [];
	const push = (y: string, m: string, d: string) => {
		const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
		// a day the month does not have (31 June) is no date
		if (
			!Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) &&
			new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso)
		)
			dates.push(iso);
		return ' ';
	};
	const month = (name: string) =>
		String(MONTHS.findIndex((x) => x.startsWith(name.toLowerCase().slice(0, 3))) + 1);
	const rest = text
		.replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (d) => (dates.push(d), ' '))
		.replace(
			/(\d{4})年\s*(\d{1,2})月(?:\s*(\d{1,2})[日号號]?)?/g,
			(_, y: string, m: string, d: string | undefined) => push(y, m, d ?? '1')
		)
		.replace(/(\d{1,2})月\s*(\d{1,2})[日号號]/g, (_, m: string, d: string) =>
			push(dates.at(-1)?.slice(0, 4) ?? today.slice(0, 4), m, d)
		)
		.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, a: string, b: string, y: string) =>
			locale === 'en-US' ? push(y, a, b) : push(y, b, a)
		)
		.replace(DAY_MONTH, (_, d: string, m: string, y?: string) =>
			push(y ?? today.slice(0, 4), month(m), d)
		)
		.replace(MONTH_DAY, (_, m: string, d: string, y?: string) =>
			push(y ?? today.slice(0, 4), month(m), d)
		);
	return {
		dates,
		strings: [...rest.matchAll(/(?:^|\s)["“']([^"”']+)["”']/g)].flatMap((x) =>
			x[1] === undefined ? [] : [x[1].trim()]
		),
		numbers: [...rest.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((x) => Number(x[0]))
	};
}
type DescriptionValues = {
	lit: ReturnType<typeof literals>;
	ws: readonly string[];
};
/** The radius the text states ("within 2 km", "500m"), else a kilometre. */
function metresOf(text: string): number {
	const x = /(\d+(?:\.\d+)?)\s*(km|kilomet(?:re|er)s?|m|met(?:re|er)s?)\b/i.exec(text);
	if (x === null) return 1000;
	const n = Number(x[1]);
	return Math.round(/^k/i.test(x[2] ?? '') ? n * 1000 : n);
}
/** Search terms: letters or digits, three or more ("595001", "grove"), no stop words. */
const terms = (text: string) =>
	[
		...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))
	].slice(0, WORDS);
const tokens = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const grams = (w: string) => [
	...new Set(Array.from({ length: w.length - 2 }, (_, i) => w.slice(i, i + 3)))
];
/** How alike two tokens are: one the other's prefix is 1, else their shared trigrams (a typo keeps most of them). */
const alike = (a: string, b: string) => {
	if (a === b || (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b))) return 1;
	if (a.length < 3 || b.length < 3) return 0;
	const x = new Set(grams(a)),
		y = grams(b);
	return y.filter((g) => x.has(g)).length / (x.size + y.length - y.filter((g) => x.has(g)).length);
};
/** The longest run of the text's tokens a label holds in order, spelled as the label spells it ("" when under two tokens). */
function held(text: string, label: string, least = 2): string {
	const t = tokens(text),
		l = tokens(label);
	let best: string[] = [];
	for (let i = 0; i < t.length; i++)
		for (let j = 0; j < l.length; j++) {
			const run: string[] = [];
			while (i + run.length < t.length && j + run.length < l.length) {
				const typed = t[i + run.length], label = l[j + run.length];
				if (typed === undefined || label === undefined || !(alike(typed, label) >= MATCH)) break;
				run.push(label);
			}
			if (run.length > best.length) best = run;
		}
	const first = best[0];
	return best.length >= least && (best.length > 1 || (first !== undefined && first.length >= 4 && !STOP.has(first)))
		? best.join(' ')
		: '';
}
/** Words that frame a topic rather than name it ("about", "after", "with"), and the calendar's own words. */
const FRAME = new Set([
	...STOP,
	...(
		'about regarding related relating similar like mention mentions mentioning involving concerning to of in on at by a an is was be ' +
		'has have had without after before since until between than more less over under me my our their his her its records ' +
		'record ones items entries or nor not no st nd rd th'
	).split(' '),
	...MONTHS,
	...'jan feb mar apr jun jul aug sep sept oct nov dec'.split(' ')
]);
/** The runs of the description's own words a search or a meaning could be about ("water leaks" in "jobs about water leaks
 * after 3rd October"): framing words, numbers and the model's and fields' names split them; quoted strings as given. */
function topics(text: string, names: readonly string[], quoted: readonly string[]): string[] {
	const named = new Set(
		names.flatMap((n) => tokens(n)).flatMap((t) => [t, t.replace(/s$/, ''), `${t}s`])
	);
	const runs: string[] = [];
	let run: string[] = [];
	const end = () => {
		if (run.length > 0) runs.push(run.join(' '));
		run = [];
	};
	for (const t of text
		.toLowerCase()
		.replace(/(?<=\p{L})['’]s\b/gu, '')
		.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu) ?? []) {
		if (/^[\p{L}]{2,}$/u.test(t) && !FRAME.has(t) && !named.has(t)) run.push(t);
		else end();
	}
	end();
	return [...new Set([...quoted, ...runs])].slice(0, MAX_TOPICS);
}
const words = (text: string) =>
	[
		...new Set(
			(
				text
					.toLowerCase()
					.replace(/'s\b/g, '')
					.match(/\p{L}{3,}/gu) ?? []
			).filter((w) => !STOP.has(w))
		)
	].slice(0, WORDS);
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** A `contains` pattern: the words in order, anything between them. */
const loose = (s: string) => `%${s.trim().split(/\s+/).map(esc).join('%')}%`;
/** The operators and values a field is offered with, or `undefined` when no option can express it. */
/** The values copied from the description (its words, quoted strings, numbers, dates): offered, but never evidence. */
const echoed = (x: Json): FilterArg => ({ lit: x, echoed: true });
const fieldOps = (items: readonly (readonly [Op['op'], string])[]): readonly Op[] =>
	items.map(([op, label]) => ({ op, label }));
const CMP_OPS = fieldOps([['eq', 'is'], ['ne', 'is not'], ['gt', 'more than'], ['gte', 'at least'], ['lt', 'less than'], ['lte', 'at most']]);
const LIST = fieldOps([['in', 'is any of'], ['not_in', 'is none of']]);
const EQUALITY_OPS = [...CMP_OPS.slice(0, 2), ...LIST];
const NUMBER_OPS = [...CMP_OPS, ...LIST];
const DATE_OPS = fieldOps([['during', 'is within'], ['eq', 'is'], ['ne', 'is not'], ['gt', 'after'], ['gte', 'on or after'], ['lt', 'before'], ['lte', 'on or before']]);
const NULL_OPS = fieldOps([['is_null', 'is empty'], ['not_null', 'is not empty']]);
const YES_NO: readonly FilterValue[] = [{ label: 'yes', arg: { lit: true } }, { label: 'no', arg: { lit: false } }];
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
	period: fieldOps([['contains', 'in force on'], ['overlaps', 'overlaps'], ['contained_by', 'is within'], ['starts_within', 'starts within'], ['ends_within', 'ends within']]),
	json: fieldOps([['contains', 'contains']]),
	point: [],
	file: [],
	vector: [],
	custom: [],
	ref: []
};
function options(
	f: Pick<FieldInfo, 'kind' | 'many' | 'period_of' | 'team' | 'email'>,
	s: Kind | undefined,
	optional: boolean,
	lit: ReturnType<typeof literals>,
	ws: readonly string[],
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
		// any list field: has one / any / all of the element kind, or is empty (a list is never null-tested)
		if (k === 'enum') for (const v of s?.kind === 'enum' ? s.values : []) add(v, { lit: v });
		else if (k === 'text') for (const x of [...lit.strings, ...ws]) add(x, echoed(x));
		else if (NUMERIC.has(k)) for (const x of lit.numbers) add(String(x), echoed(x));
		else if (k === 'date') for (const d of lit.dates) add(d, echoed(d));
		else if (k === 'bool') for (const v of YES_NO) add(v.label, v.arg);
		return {
			ops: [...fieldOps([['has', 'has'], ['has_any', 'has any of'], ['has_all', 'has all of'], ['is_empty', 'is empty'], ['not_empty', 'is not empty']])],
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
		for (const x of [...lit.strings, ...ws]) add(x, echoed(x));
		if (f.team) add('my team', { var: 'actor.teams' });
		if (f.email) add('my email', { var: 'actor.email' });
	} else if (NUMERIC.has(k)) {
		for (const x of lit.numbers) add(String(x), echoed(x));
	} else if (k === 'date' || k === 'instant' || k === 'time') {
		const when = k !== 'time';
		if (when) for (const v of spans(k, today, tz)) add(v.label, v.arg);
		if (k === 'date') for (const d of lit.dates) add(d, echoed(d));
		// a day on an instant is that day in the workspace zone: [00:00, next 00:00)
		if (k === 'instant')
			for (const d of lit.dates) add(d, { range: dayOf(d, tz), echoed: true });
	} else if (k === 'period' && f.period_of === 'date') {
		// a date period (an employment's effective_range): in force on a day, or overlapping / inside a span
		add('today', { lit: { var: 'today' } });
		for (const v of spans('date', today, tz)) add(v.label, v.arg);
		for (const d of lit.dates) add(d, echoed(d));
	} else if (k === 'json' || k === 'id' || k === 'currency') {
	} else if (k === 'point' || k === 'file' || k === 'vector' || k === 'custom' || k === 'ref') {
		ops = [];
	} else return undefined;
	if (optional) ops.push(...NULL_OPS);
	return ops.length === 0 && k !== 'point' ? undefined : { ops, values }; // a point is kept: a found record's location offers "within … of it"
}
/** The operator object an op and its argument make; `undefined` when the pair means nothing. */
const VALUELESS_OPERATORS: Readonly<Record<string, Json>> = {
	is_null: { is_null: true },
	not_null: { is_null: false }
};
const SCALAR_OPERATORS: Readonly<Record<string, (value: Json) => Json | undefined>> = {
	search: (value) => (typeof value === 'string' ? value : undefined),
	similar: (value) => (typeof value === 'string' ? value : undefined),
	like: (value) => (typeof value === 'string' ? { like: loose(value) } : undefined),
	contains: (value) => ({ contains: value }),
	during: (value) => ({ eq: value }),
	has: (value) => ({ has: value }),
	in: (value) => ({ in: [value] }),
	...Object.fromEntries(CMP_OPS.map(({ op }) => [op, (value: Json): Json => ({ [op]: value })]))
};
const nextDay = (d: string) =>
	new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
/** A day on an instant: that day in the workspace zone, [00:00, next 00:00). */
const dayOf = (d: string, tz: string): readonly [Json, Json] => [midnight(d, tz), midnight(nextDay(d), tz)];
/** The last day of a half-open span ending at `hi`: a date's day before, a time variable's `- days(1)`. */
const dayBefore = (hi: Json): Json =>
	typeof hi === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hi)
		? new Date(Date.parse(`${hi}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
		: Predicate.isObject(hi) && typeof hi['var'] === 'string'
			? { var: `${hi['var']} - days(1)` }
			: hi;
const ARGUMENT_OPERATORS = {
	lit: (op: string, value: Json): Json | undefined => SCALAR_OPERATORS[op]?.(value),
	list: (op: string, value: readonly Json[]): Json | undefined =>
		op === 'in' ? { in: value } : undefined,
	range: (op: string, [lo, hi]: readonly [Json, Json]): Json | undefined => {
		const operators: Readonly<Record<string, Json>> = {
			during: { gte: lo, lt: hi },
			eq: { gte: lo, lt: hi },
			between: { gte: lo, lte: hi },
			// a span is half-open; a date period's `to` is its last day
			overlaps: { overlaps: { from: lo, to: dayBefore(hi) } },
			contained_by: { contained_by: { from: lo, to: dayBefore(hi) } },
			starts_within: { starts_within: { from: lo, to: dayBefore(hi) } },
			ends_within: { ends_within: { from: lo, to: dayBefore(hi) } },
			lt: { lt: lo },
			lte: { lt: hi },
			gt: { gte: hi },
			gte: { gte: lo }
		};
		return operators[op];
	},
	var: (op: string, name: ActorVar): Json | undefined =>
		op === 'eq' || op === 'ne' || (op === 'in' && name === 'actor.teams')
			? { [op]: { var: name } }
			: undefined,
	match: (op: string, value: { field: string; phrase: string }): Json | undefined =>
		op === 'eq' ? { is: { [value.field]: { like: loose(value.phrase) } } } : undefined,
	near: (op: string, value: readonly [Point, number]): Json | undefined =>
		op === 'near' ? { near: value } : undefined
};
function operator(op: string, arg: FilterArg | undefined): Json | undefined {
	const plain = VALUELESS_OPERATORS[op];
	if (plain !== undefined) return plain;
	if (arg === undefined) return undefined;
	if ('lit' in arg) return ARGUMENT_OPERATORS.lit(op, arg.lit);
	if ('list' in arg) return ARGUMENT_OPERATORS.list(op, arg.list);
	if ('range' in arg) return ARGUMENT_OPERATORS.range(op, arg.range);
	if ('var' in arg) return ARGUMENT_OPERATORS.var(op, arg.var);
	if ('match' in arg) return ARGUMENT_OPERATORS.match(op, arg.match);
	return ARGUMENT_OPERATORS.near(op, arg.near);
}
/** The nested JSON a path and an operator object make: the declarative replacement for the old `put` closures. */
function instantiate(
	path: readonly FilterStep[],
	ops: Json,
	field: (name: string, value: Json) => Json = (name, value) => ({ [name]: value })
): Json | undefined {
	return path.reduceRight<Json | undefined>((inner, s) => {
		if (inner === undefined) return undefined;
		switch (s.k) {
			case 'field':
				return field(s.name, inner);
			case 'is':
				return { [s.rel]: { is: inner } };
			case 'arm':
				return { [s.rel]: { [s.arm]: inner } };
			case 'some':
			case 'every':
			case 'none':
				return { [s.rel]: { [s.k]: inner } };
			case 'count':
				return { [s.rel]: { count: inner } };
			case 'agg':
				if (inner === null || typeof inner !== 'object' || EffectArray.isArray(inner)) return undefined;
				return { [s.rel]: { [s.fn]: { of: s.of, ...inner } } };
		}
	}, ops);
}
/** One condition from a field path, a machine operator and an operand; `undefined` when the pair means nothing. */
function condition(
	path: readonly FilterStep[],
	op: string,
	arg: FilterArg | undefined
): Json | undefined {
	if (op === 'is_empty' || op === 'not_empty')
		return instantiate(path, {}, (name) => op === 'is_empty'
			? { or: [{ [name]: { is_null: true } }, { [name]: { eq: [] } }] }
			: { and: [{ [name]: { is_null: false } }, { [name]: { ne: [] } }] });
	if (op === 'not_in') {
		const membership = operator('in', arg);
		return membership === undefined ? undefined : instantiate(path, membership, (name, value) => ({ not: { [name]: value } }));
	}
	if (op === 'has_any' || op === 'has_all') {
		const values = arg === undefined ? undefined : 'list' in arg ? arg.list : 'lit' in arg ? [arg.lit] : undefined;
		if (values === undefined) return undefined;
		return instantiate(path, {}, (name) => ({
			[op === 'has_all' ? 'and' : 'or']: values.map((value) => ({ [name]: { has: value } }))
		}));
	}
	// "does not contain": the negated `like`
	if (op === 'unlike') {
		const like = operator('like', arg);
		const nested = like === undefined ? undefined : instantiate(path, like);
		return nested === undefined ? undefined : { not: nested };
	}
	// a relation's records NOT holding a phrase: the negated match ("jobs not at pine grove")
	if (arg !== undefined && 'match' in arg && op === 'ne') {
		const match = operator('eq', arg);
		const nested = match === undefined ? undefined : instantiate(path, match);
		return nested === undefined ? undefined : { not: nested };
	}
	const ops = operator(op, arg);
	return ops === undefined ? undefined : instantiate(path, ops);
}
type FilterDescribeConfig = {
	manifest: EngineManifest;
	read: ReadsShape['run'];
	decisions: DecisionsShape;
	ai: Ai['Service'];
};
/** Dates cross the wire as ISO strings. */
const day = (v: Json | undefined) => String(v);
const AGGS = [['total', 'sum'], ['average', 'avg'], ['lowest', 'min'], ['highest', 'max']] as const;
/** Kinds whose value is words: shown quoted in a condition ("Title contains “pump”"). */
const QUOTED = new Set(['text', 'search', 'semantic']);
const same = (a: readonly FilterStep[], b: readonly FilterStep[]) => equal_json(a, b);
/** The level a hop from `x` through `rel` into `target` reads: its declared layer, or the target's root where `x` declares every relation (a plain schema). */
const levelOf = (cat: Catalog, x: ExposureInfo, rel: string, target: string) => {
	const layer = cat.layers.get(`${x.path}.${rel}`);
	if (layer?.name === target) return layer;
	return x.relations === 'all' ? cat.exposures.get(target) : undefined;
};
function make_filter_describe(cfg: FilterDescribeConfig) {
	const m = cfg.manifest,
		cat = catalog_of(m);
	/** Whether the caller reads model `c` (any output it holds): the narrowing of every option. */
	const reads = (a: Authority, c: string) => readsAny(a, c);
	/** The output a caller's generic views read `c` as, and the catalog of it: its fields and layers are what it offers. */
	const viewOf = (a: Authority, c: string) => {
		const output = viewOutput(m, a, c) ?? DEFAULT_OUTPUT;
		return catalog_for(cat, c, output).pipe(
			Effect.map((view) => ({ output, cat: view })),
			Effect.mapError(from_store)
		);
	};
	/** A read of `c` as the caller's view output. */
	const readAs = Effect.fnUntraced(function* (a: Authority, c: string, q: Parameters<typeof ir.read>[2]) {
		const v = yield* viewOf(a, c);
		const read = yield* ir.read(v.cat, c, q);
		return v.output === DEFAULT_OUTPUT ? read : { ...read, output: v.output };
	});
	/** The root whose arms read level `x`: a layer is read under its root's policies, never its own model's. */
	const owner = (x: ExposureInfo) => x.path.split('.')[0] ?? x.path;
	const spec = (c: string, f: string) => m.models[c]?.fields[f];
	const nameOf = (c: string, f: string, fallback = f) => m.messages?.[`models.${c}.fields.${f}`] ?? human(fallback);
	const helpOf = (c: string, f: string) => m.messages?.[`models.${c}.help.${f}`];
	/** A model's searched text fields: where a phrase the person typed can be found. */
	const texts = (c: string) =>
		(cat.exposures.get(c)?.model.search ?? []).filter(
			(f) => cat.exposures.get(c)?.model.fields.get(f)?.kind === 'text'
		);
	const valuesOf = (text: string, today: string): DescriptionValues => ({
		lit: literals(text, m.workspace.locale, today),
		ws: words(text)
	});
	/** 1. Every field the caller may describe on `model`, with the description's literal values. Reads nothing. */
	const fieldsOf = Effect.fnUntraced(function* (
		model: string, text: string, a: Authority, b: Bindings, { lit, ws }: DescriptionValues
	): Effect.fn.Return<Field[], BoltError> {
		const view = (yield* viewOf(a, model)).cat,
			out: Field[] = [];
		const numbers = () => lit.numbers.map((x) => ({ label: String(x), arg: echoed(x) }));
		/** `target`'s fields under `steps`; `sortFrom` is the dot path they sort by (none past one hop); `hops` remain.
		 * `back` is the relation walked in by, never walked out again ("Assignee › Assigned jobs" is the jobs themselves). */
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
				// a relation is named for its record ("Site"), never its key column ("Site id": System 1 read it as a code)
				const label =
					prefix +
					(system
						? f.name === 'created_at'
							? 'Created'
							: 'Updated'
						: nameOf(target, f.name, rel === undefined ? f.name : f.name.replace(/_id$/, '')));
				if (rel === undefined) {
					const o = options(f, s, s?.optional === true, lit, ws, b.tz, b.today);
					if (o === undefined) continue;
					const sort =
						sortFrom === undefined || f.many || UNSORTABLE.has(f.kind)
							? undefined
							: sortFrom === ''
								? f.name
								: `${sortFrom}.${f.name}`;
					const hint = helpOf(target, f.name);
					out.push({
						label,
						...(system
							? {
									hint:
										f.name === 'created_at'
											? 'when this top-level record was entered in the workspace, not a related record or a business date'
											: 'when this top-level record was last edited in the workspace, not a related record or a business date'
								}
							: hint === undefined
								? {}
								: { hint }),
						path: [...steps, { k: 'field', name: f.name }],
						kind: f.kind,
						...o,
						...(sort === undefined ? {} : { sort })
					});
					continue;
				}
				// a filter hops only a declared read layer (the walk below checks it)
				if (hops === 0 || back === `${target}.${f.name}`) continue;
				// the record itself by its key, then its fields one hop on (one arm per target of an exclusive arc)
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
			// many-relations, at the root and one relation hop on ("Customer › Invoices (any) › Status"): has any / none (and, at
			// the root, all) of the related records, how many, and child totals. A related record's own relations are not walked:
			// the catalogue the builder receives grows with every hop (hrms: 0.4 MB → 3 MB a model at full depth).
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
						? ([['some', 'any'], ['every', 'all'], ['none', 'none']] as const)
						: ([['some', 'any'], ['none', 'none']] as const))
						walk(child, [...steps, { k: q, rel: r }], `${rl} (${word}) › `, undefined, 0);
					// how many: 0 and 1 always ("with no invoices", "with an unpaid one"), then the text's own numbers
					out.push({
						label: `${prefix}Number of ${human(r).toLowerCase()}`,
						path: [...steps, { k: 'count', rel: r }],
						kind: 'count',
						ops: CMP_OPS,
						values: lit.numbers.length > 0 ? numbers() : [{ label: '0', arg: { lit: 0 } }, { label: '1', arg: { lit: 1 } }]
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
										? options(f, s, false, lit, ws, b.tz, b.today)?.values ?? []
										: numbers()
								});
					}
				}
			// the search index and the embedding, to a caller who reads every field they cover
			const whole = (fs: readonly string[]) => fs.every((x) => exposed_field(tc, x));
			const about = () =>
				topics(text, [target, human(target), ...[...tc.model.fields.keys()].map(human), prefix], lit.strings).map(
					(x) => ({ label: x, arg: echoed(x) })
				);
			if (tc.model.search.length > 0 && whole(tc.model.search))
				out.push({
					label: `${prefix}Search`,
					path: [...steps, { k: 'field', name: '$search' }],
					kind: 'search',
					ops: [{ op: 'search', label: 'has all the words' }],
					values: about()
				});
			if (tc.model.semantic !== undefined && whole(tc.model.semantic.fields))
				out.push({
					label: `${prefix}Topic`,
					path: [...steps, { k: 'field', name: '$similar' }],
					kind: 'semantic',
					ops: [{ op: 'similar', label: 'is about' }],
					values: about()
				});
		};
		const root = view.exposures.get(model);
		if (root !== undefined) walk(root, [], '', '', FILTER_MAX_HOPS);
		return out;
	});
	/** Adds a value a read found; it replaces the description's own word of the same label (found beats echoed). */
	const found = (f: Field, label: string, arg: FilterArg) => {
		const at = f.values.findIndex((v) => v.label === label);
		if (at < 0) f.values.push({ label, arg });
		else if (f.values[at]?.arg.echoed === true) f.values[at] = { label, arg };
	};
	const lookup = Effect.fn('Agents.lookup')(function* (
		model: string,
		text: string,
		fields: readonly Field[],
		a: Authority,
		b: Bindings,
		quoted: readonly string[]
	) {
		const view = (yield* viewOf(a, model)).cat,
			c = view.exposures.get(model),
			ts = terms(text),
			orders: Order[] = [];
		if (c === undefined) return yield* Effect.fail(refuse(`'${model}' is not read by this caller`));
		const radius = metresOf(text),
			within = radius >= 1000 ? `${radius / 1000} km` : `${radius} m`;
		const reads_: { q: ir.ReadIR; then: (rows: readonly RowData[]) => void }[] = [];
		const at = (path: readonly FilterStep[]) => fields.find((f) => same(f.path, path));
		const points = fields.filter(
			(f) =>
				f.kind === 'point' &&
				(f.path.length === 1 || (f.path.length === 2 && f.path[0]?.k === 'is'))
		);
		// a) a relation's records the words name: through the search index where declared, else by label, word by word
		for (const f of fields) {
			const s = f.path[0];
			if (f.kind !== 'record' || f.path.length !== 1 || s?.k !== 'field') continue;
			const target = c.model.one.get(s.name)?.targets[0];
			if (target === undefined) continue;
			const x = (yield* viewOf(a, target)).cat.exposures.get(target),
				layer = levelOf(view, c, s.name, target);
			const tl = label_paths(m.models[target]?.record_label)[0] ?? 'name';
			// the phrase is matched through the layer: read the target, then filter across the layer's label
			if (
				layer === undefined ||
				x === undefined ||
				x.model.fields.get(tl)?.kind !== 'text' ||
				!exposed_field(x, tl) ||
				!reads(a, target)
			)
				continue;
			const own = points.filter((p) => {
				const first = p.path[0];
				return p.path.length === 1 || (first?.k === 'is' && first.rel === s.name);
			});
			const pointFields = own.flatMap((p) => {
				const second = p.path[1];
				return p.path.length === 2 && second?.k === 'field' ? [second.name] : [];
			});
			const select = Object.fromEntries(
				[tl, ...texts(target), ...pointFields].filter((n) => exposed_field(x, n)).map((n) => [n, true])
			);
			const then = (rows: readonly RowData[]) => {
				for (const row of rows) {
					const label = String(row[tl]);
					found(f, label, { lit: String(row['id']) });
					if (!(f.found ??= []).includes(label)) f.found.push(label);
					for (const t of texts(target)) {
						// the words the person typed that the record holds ("1f pine grove" in "1F Pine Grove #17-30"): every such record
						const phrase = held(text, String(row[t] ?? ''), 1);
						if (phrase === '') continue;
						found(f, `one whose ${nameOf(target, t)} contains “${phrase}”`, {
							match: { field: t, phrase }
						});
						const search = at([{ k: 'is', rel: s.name }, { k: 'field', name: '$search' }]);
						if (search !== undefined) found(search, phrase, { lit: phrase });
					}
					// "near <it>", "nearest to <it>": where the record is
					const pt = pointFields.map((name) => row[name]).find(isPoint);
					if (pt !== undefined)
						for (const p of own) {
							found(p, `${within} of ${label}`, { near: [pt, radius] });
							orders.push({
								label: `${p.label}, nearest to ${label}`,
								key: p.path.map((x) => ('name' in x ? x.name : x.rel)).join('.'),
								dir: { near: pt }
							});
						}
				}
			};
			// by the description's terms: a one- or two-letter word is a prefix of half the records ("a" found "Acme")
			if (x.model.search.length > 0 && ts.length > 0)
				reads_.push({
					q: yield* readAs(a, target, { search: ts.join(' '), select, limit: CANDIDATES }),
					then
				});
			else
				for (const w of ts)
					reads_.push({
						q: yield* readAs(a, target, {
							where: { [tl]: { like: `%${esc(w)}%` } },
							select,
							limit: CANDIDATES
						}),
						then
					});
		}
		// b) the phrases the model's own searched text holds, read whole through the index (typos included)
		const own = fields.flatMap((f) => {
			const first = f.path[0];
			return f.path.length === 1 && f.kind === 'text' && first?.k === 'field' && c.model.search.includes(first.name)
				? [{ field: f, name: first.name }]
				: [];
		});
		if (own.length > 0) {
			const runs = topics(text, [model, human(model), ...fields.map((f) => f.label)], quoted),
				search = at([{ k: 'field', name: '$search' }]);
			if (ts.length > 0)
				reads_.push({
					q: yield* readAs(a, model, {
						search: ts.join(' '),
						select: Object.fromEntries(own.map(({ name }) => [name, true])),
						limit: CANDIDATES
					}),
					then: (rows) => {
						for (const { field: f, name } of own) {
							const phrase = rows
								.map((r) => held(text, String(r[name] ?? ''), 1))
								.sort((l, r) => r.length - l.length)[0];
							if (!phrase) continue;
							found(f, phrase, { lit: phrase });
							const holders = rows
								.map((r) => String(r[name] ?? ''))
								.filter((x) => held(text, x, 1) !== '');
							const foundLabels = f.found ??= [];
							foundLabels.push(...holders.filter((x) => !foundLabels.includes(x)));
							// over the index, the whole typed run around it ("pmup room" around "room"), which a `contains` would miss
							const run =
								runs.find((x) => phrase.split(' ').every((w) => x.split(' ').includes(w))) ??
								phrase;
							if (search !== undefined) {
								found(search, run, { lit: run });
								const matchingRecords = search.found ??= [];
								matchingRecords.push(...holders.filter((x) => !matchingRecords.includes(x)));
							}
						}
					}
				});
		}
		// c) named days: a record the caller reads, with a date, whose name the description holds ("after National Day")
		const dated = fields.filter((f) => f.kind === 'date' || f.kind === 'instant');
		const days: { name: string; day: string }[] = [];
		if (dated.length > 0 && ts.length > 0 && DAY_WORDS.test(text)) {
			let n = 0;
			for (const name of cat.exposures.keys()) {
				if (n >= MAX_DATED || name.startsWith('sys_') || !reads(a, name)) continue;
				const x = (yield* viewOf(a, name)).cat.exposures.get(name);
				if (x === undefined) continue;
				const readable = (f: string, kind: string) => {
					const field = x.model.fields.get(f);
					return field !== undefined && field.kind === kind && !field.many && exposed_field(x, f);
				};
				const label = label_paths(m.models[name]?.record_label)[0] ?? 'name';
				const title = [label, ...x.model.search, 'name', 'title'].find((f) => readable(f, 'text'));
				const when = [label, ...x.model.fields.keys()].find((f) => readable(f, 'date'));
				if (title === undefined || when === undefined) continue;
				n++;
				reads_.push({
					q: yield* readAs(a, name, {
						where: { or: ts.map((w) => ({ [title]: { like: `%${esc(w)}%` } })) },
						select: { [title]: true, [when]: true },
						limit: 20
					}),
					then: (rows) => {
						for (const r of rows)
							if (held(text, String(r[title] ?? '')) !== '')
								days.push({ name: String(r[title]), day: day(r[when]) });
					}
				});
			}
		}
		if (reads_.length === 0) return orders;
		const all = yield* cfg
			.read(reads_.map((r) => r.q), { as: 'caller', authority: a }, b)
			.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })))
				),
				Effect.mapError((error) =>
					Schema.isSchemaError(error)
						? BoltError.make('bad_answer', 'deliver', error.message, error)
						: error
				)
			);
		for (const [i, read] of reads_.entries()) {
			const answer = all[i];
			if (answer === undefined)
				return yield* Effect.fail(
					BoltError.make('bad_answer', 'deliver', 'The filter lookup returned no page.')
				);
			read.then(answer.rows);
		}
		// one day per name, the occurrence nearest today ("National Day" in October is this August's)
		// ponytail: nearest occurrence; a "next" / "last" in the text could pick the side
		const near = new Map<string, { name: string; day: string }>();
		const gap = (d: string) => Math.abs(Date.parse(d) - Date.parse(b.today));
		for (const d of days) {
			const k = d.name.toLowerCase(),
				was = near.get(k);
			if (was === undefined || gap(d.day) < gap(was.day)) near.set(k, d);
		}
		for (const f of dated)
			for (const d of near.values())
				found(
					f,
					`${d.name} (${d.day})`,
					f.kind === 'date' ? { lit: d.day } : { range: dayOf(d.day, b.tz) }
				);
		return orders;
	});
	/**
	 * 3. A field's whole conditions: every (operator, value) its kind admits, each built and decoded as a read literal
	 * (`model`; `$local` has no catalogue, its kinds are its own three). A pair that does not decode is not offered.
	 */
	const condsOf = Effect.fnUntraced(function* (f: Field, model: string | undefined, text: string, b: Bindings) {
		const candidates: Cond[] = [];
		const lits = f.values.flatMap<LiteralValue>((v) =>
			'lit' in v.arg ? [{ label: v.label, arg: v.arg }] : []
		);
		// a list operator's candidates: what the description names (its words, a declared value it says) or a read found
		const said = text.toLowerCase();
		const named = lits.filter(
			(v) =>
				v.arg.echoed === true || f.found?.includes(v.label) || said.includes(v.label.toLowerCase())
		);
		const listy =
			f.kind === 'enum' ||
			f.kind === 'state' ||
			f.kind === 'record' ||
			f.ops.some((x) => x.op === 'has_any');
		const show = (v: FilterValue) =>
			QUOTED.has(f.kind) && 'lit' in v.arg && typeof v.arg.lit === 'string'
				? `“${v.label}”`
				: v.label;
		const add = (
			label: string,
			op: string,
			arg: FilterArg | undefined,
			extra: Partial<Cond> = {}
		) => {
			const where = condition(f.path, op, arg);
			if (where === undefined) return;
			candidates.push({
				label,
				op,
				...(arg === undefined ? {} : { arg }),
				evidence: arg !== undefined && arg.echoed !== true,
				where,
				...extra
			});
		};
		for (const x of f.ops) {
			const head = `${f.label} ${x.label}`;
			if (NO_VALUE.has(x.op)) {
				add(head, x.op, undefined);
				continue;
			}
			if (LIST_OPS.has(x.op)) {
				// a set the schema names ("a final state", "my teams"), or the values the description names, each a yes / no
				for (const v of f.values)
					if ('list' in v.arg || 'var' in v.arg)
						add(`${head} ${v.label}`, x.op, v.arg, { value: v.label });
				if (listy && named.length >= 2)
					add(`${head} the ones named`, x.op, { list: named.map((v) => v.arg.lit) }, {
						list: named,
						evidence: named.some((v) => v.arg.echoed !== true)
					});
				continue;
			}
			for (const v of f.values) {
				const relative: Readonly<Record<string, RegExp>> = {
					today: /today|今天|今日/i,
					yesterday: /yesterday|昨天|昨日/i,
					'last month': /last month|上个?月|上個月/i,
					'this month': /this month|本月|这个月|這個月/i,
					'last week': /last week|上周|上週|上星期/i,
					'this week': /this week|本周|本週|这周|這週/i
				};
				if (
					v.label !== 'today' &&
					'range' in v.arg &&
					v.arg.echoed !== true &&
					!f.found?.includes(v.label) &&
					!(relative[v.label]?.test(text) ?? text.toLowerCase().includes(v.label.toLowerCase()))
				)
					continue;
				// "is within" takes a span; a span's "is" is "is within"
				if (
					(x.op === 'during' && !('range' in v.arg)) ||
					(x.op === 'eq' && 'range' in v.arg && f.ops.some((y) => y.op === 'during'))
				)
					continue;
				add(`${head} ${show(v)}`, x.op, v.arg, { value: v.label });
				if (x.op === 'like')
					add(`${f.label} does not contain ${show(v)}`, 'unlike', v.arg, { value: v.label });
			}
		}
		// within a radius of a found record's location (describe only: the builder edits no point)
		for (const v of f.values)
			if ('near' in v.arg)
				add(`${f.label} is within ${v.label}`, 'near', v.arg, { value: v.label });
		// between two of the description's own numbers or days, both ends included
		if (f.ops.some((y) => y.op === 'gte')) {
			const ends = lits
				.filter((v) => v.arg.echoed === true)
				.flatMap((v) =>
					typeof v.arg.lit === 'string' || typeof v.arg.lit === 'number' ? [v.arg.lit] : []
				)
				.sort((p, q) => (p < q ? -1 : 1));
			for (const [i, lo] of ends.entries())
				for (const hi of ends.slice(i + 1))
					if (lo !== hi)
						add(
							`${f.label} between ${lo} and ${hi}`,
							'between',
							{ range: [lo, hi] },
							{ value: `${lo} and ${hi}` }
						);
		}
		// a pair whose literal does not decode is not offered; the first of a label wins
		const out: Cond[] = [];
		for (const cond of candidates) {
			if (out.some((x) => x.label === cond.label)) continue;
			if (model !== undefined && Result.isFailure(yield* Effect.result(decodeWhere(cat, model, materialize(cond.where, b)))))
				continue;
			out.push(cond);
		}
		return out;
	});
	/** A field's sort keys, in its own words. */
	const orderOf = (f: Field): Order[] => {
		if (f.sort === undefined) return [];
		const [up, down] =
			f.kind === 'date' || f.kind === 'instant' || f.kind === 'time'
				? ['earliest first', 'latest first']
				: NUMERIC.has(f.kind)
					? ['lowest first', 'highest first']
					: ['A to Z', 'Z to A'];
		return [
			{ label: `${f.label}, ${up}`, key: f.sort, dir: 'asc' },
			{ label: `${f.label}, ${down}`, key: f.sort, dir: 'desc' }
		];
	};
	/**
	 * How strongly the description names each field: a word of its label (in any inflection: `log` → `logs`), a record a
	 * read found for it, one of its declared values the text says (a state, a choice, `this week`). A word copied from the
	 * description is no evidence; a number names no field but makes every numeric one a candidate.
	 */
	function rank(fields: readonly Field[], text: string, model: string): Field[] {
		// the model's own name ("jobs") names every field equally, so none
		const said = text.toLowerCase(),
			ws = words(text).filter(
				(w) =>
					!tokens(human(model)).some((x) => w.startsWith(x.replace(/s$/, '')) || x.startsWith(w))
			);
		const akin = (w: string, x: string) =>
			w.startsWith(x) || x.startsWith(w) || [...w].findIndex((ch, i) => ch !== x[i]) >= 5;
		const score = new Map(
			fields.map((f) => {
				const label = f.label
					.toLowerCase()
					.split(/[^a-z0-9]+/)
					.filter((x) => x.length > 2);
				const declared = f.values.some(
					(v) =>
						v.arg.echoed !== true &&
						new RegExp(`\\b${v.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(
							said
						)
				);
				const candidate =
					f.kind !== 'search' &&
					f.kind !== 'semantic' &&
					f.values.some(
						(v) =>
							v.arg.echoed === true && !ws.includes(v.label) && said.includes(v.label.toLowerCase())
					);
				// the model's own search index and meaning stand just behind any named field: no label names them
				const index =
					f.path.length === 1 &&
					(f.kind === 'search' || f.kind === 'semantic') &&
					f.values.length > 0
						? 0.5
						: 0;
				// a word of its help names it half as strongly as one of its label
				const hint = (f.hint ?? '')
					.toLowerCase()
					.split(/[^a-z0-9]+/)
					.filter((x) => x.length > 3);
				return [
					f,
					ws.filter((w) => label.some((x) => akin(w, x))).length +
						ws.filter((w) => hint.some((x) => akin(w, x))).length / 2 +
						(f.found !== undefined ? 1 : 0) +
						(declared ? 1 : 0) +
						(candidate ? 0.25 : 0) +
						index
				];
			})
		);
		// one child relation the text names offers its count, totals and every field under any / all / none: past its first
		// four, the rest wait behind the other candidates, so a second condition ("done", a date) still fits
		const per = new Map<string, number>();
		const scoreOf = (f: Field) => score.get(f) ?? 0;
		const crowded = (f: Field) => {
			const s = f.path.find(
				(p) =>
					p.k === 'some' || p.k === 'every' || p.k === 'none' || p.k === 'count' || p.k === 'agg'
			);
			if (s === undefined || !('rel' in s) || scoreOf(f) === 0) return false;
			const count = (per.get(s.rel) ?? 0) + 1;
			per.set(s.rel, count);
			return count > 4;
		};
		// within a related list: its count, then its fields under "any", before totals and "none" / "all"
		const weight = (f: Field) =>
			f.path.some((p) => p.k === 'agg')
				? 2
				: f.path.some((p) => p.k === 'none')
					? 3
					: f.path.some((p) => p.k === 'every')
						? 4
						: 0;
		const ranked = fields
			.map((f, i) => ({ f, i }))
			.sort(
				(l, r) =>
					scoreOf(r.f) - scoreOf(l.f) ||
					weight(l.f) - weight(r.f) ||
					l.f.path.length - r.f.path.length ||
					l.i - r.i
			)
			.map((x) => x.f);
		const late = new Set(ranked.filter(crowded));
		return [
			...ranked.filter((f) => scoreOf(f) > 0 && !late.has(f)),
			...late,
			...ranked.filter((f) => scoreOf(f) === 0)
		];
	}
	/** The catalogue as plain data for the builder. Values ride the one row that reads them, "is within"'s spans: repeated
	 * on every operator they made a wide model's catalogue megabytes. */
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
	/** The local view's own fields (`$local`): text, number and bool only, and no relation. */
	const localFields = (
		fs: readonly LocalFilterField[], today: string, { lit, ws }: DescriptionValues
	): Field[] =>
		fs.flatMap<Field>((f) => {
			const offered = options(
				{ kind: f.kind }, undefined, f.optional === true, lit, ws, m.workspace.tz, today
			);
			return offered === undefined ? [] : [
				{
					label: f.label,
					path: [{ k: 'field', name: f.name }],
					kind: f.kind,
					...offered,
					sort: f.name
				}
			];
		});
	/** The model a caller may describe or see options on; a `$local` view carries its own fields. */
	const subject = (
		o: { model: string; authority: Authority; localFields?: readonly LocalFilterField[] },
		today: string,
		values: DescriptionValues
	): { fields?: Field[]; fail?: Failed } => {
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
		return { fields: localFields(fields, today, values) };
	};
	const call = (state: DecisionRequest['state'], questions: { [id: string]: DecisionQuestion }) =>
		cfg.decisions.decide('filter', { state, questions }).pipe(
			Effect.catch((error) =>
				Effect.succeed({
					ok: false as const,
					code: error instanceof Unavailable ? 'unavailable' : error.kind,
					message: 'Could not build a filter from that description.'
				})
			)
		);
	/** How the stated conditions combine: one top-level group. */
	const COMBINE = {
		'all of them hold': { join: 'and', not: false, because: 'every stated condition holds' },
		'any of them hold': { join: 'or', not: false, because: 'at least one stated condition holds' },
		'not all of them hold': { join: 'and', not: true, because: 'not every stated condition holds' },
		'none of them hold': { join: 'or', not: true, because: 'no stated condition holds' }
	} satisfies Readonly<Record<string, { join: 'and' | 'or'; not: boolean; because: string }>>;
	/** A yes-or-no question: its instructions, then what yes and no mean. */
	const noul = (instructions: DecisionEntry, yes: DecisionEntry, no: DecisionEntry): DecisionQuestion => ({
		type: 'noul',
		instructions,
		criteria: { true: yes, false: no }
	});
	/** A choice's criteria: each option names itself. */
	const own = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, k]));
	const describe = Effect.fn('Agents.describe')(function* (o: {
		model: string;
		text: string;
		authority: Authority;
		bindings: Bindings;
		localFields?: readonly LocalFilterField[];
	}): Effect.fn.Return<Described, EngineError> {
		const fail = (message: string): Described => ({ ok: false, code: 'invalid', message });
		if (o.text.trim() === '' || o.text.length > FILTER_MAX_TEXT)
			return fail(`A description is 1–${FILTER_MAX_TEXT} characters.`);
		const values = valuesOf(o.text, o.bindings.today);
		const subjectOf = subject(o, o.bindings.today, values);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const local = o.model === '$local';
		const fields = subjectOf.fields ?? (yield* fieldsOf(o.model, o.text, o.authority, o.bindings, values));
		const nears = local ? [] : yield* lookup(o.model, o.text, fields, o.authority, o.bindings, values.lit.strings);
		const max = cfg.ai.maxChoices ?? Infinity;
		// the fields the description most plausibly names that have a condition to offer, each with all of them
		const asked: { f: Field; conds: Cond[] }[] = [];
		// Quantification belongs to a relation group, not to each of its fields independently.
		for (const f of rank(fields, o.text, o.model)) {
			const conds = yield* condsOf(f, local ? undefined : o.model, o.text, o.bindings);
			if (conds.length > max - 1 || (conds.length > 0 && asked.length >= FILTER_MAX_FIELDS))
				return fail(
					'This description needs too many alternatives. Use the condition editor to express it exactly.'
				);
			if (conds.length > 0) asked.push({ f, conds });
		}
		const orders = [...nears, ...fields.filter((f) => f.sort !== undefined).flatMap(orderOf)].slice(
			0,
			max - 1
		);
		if (asked.length === 0 && orders.length === 0)
			return fail('Nothing here can be filtered by a description.');
		// 4. the one call
		const questions: { [id: string]: DecisionQuestion } = {};
		questions['textSearch'] = noul(
			'Does the description request matching words or a topic in record CONTENT? A structured condition on count, date, status, activity, or an aggregate is NOT a text-search request. Do not search for incidental words such as zero, all, active or order.',
			'A text-content or topic match is requested.',
			'Only structured predicates are requested.'
		);
		questions['ownership'] = noul(
			'Does the description explicitly restrict records by caller identity: owned by me, assigned to me, my team, 我的 records? "Show me", "give me", 给我 and 给我啦 are requests to display results, NOT ownership restrictions.',
			'Caller ownership or affiliation is an explicit filter.',
			'The caller only asks to see results, or identity is not mentioned.'
		);
		const relations = [
			...new Set(
				asked.flatMap(({ f }) =>
					f.path[0] !== undefined &&
					'rel' in f.path[0] &&
					['some', 'count', 'agg'].includes(f.path[0].k)
						? [f.path[0].rel]
						: []
				)
			)
		];
		const modes = {
			ignore:
				'Only a count or aggregate (total, average, earliest/latest date) is constrained, or this relation is not mentioned. No additional individual-record predicate. A latest-record date boundary belongs here, NOT some.',
			some: 'At least one related record satisfies ALL stated child conditions, on the SAME record.',
			every:
				'The description explicitly says ALL/EVERY related record must satisfy the child conditions; empty lists also qualify. SAME record only joins predicates and does not mean ALL records.',
			nonempty_every:
				'The description explicitly requires BOTH a nonempty list AND ALL/EVERY related record to satisfy the conditions. Merely having one matching record is some, even when it must be the SAME record.',
			none: 'NO related record satisfies the child conditions. Empty lists qualify. This does NOT mean the entire list is empty.',
			empty_or_some:
				'Either the related list is empty OR at least one related record satisfies the child conditions.'
		};
		for (const rel of relations) {
			questions[`applicable.${rel}`] = noul(
				{
					question: `Does the description explicitly constrain ${human(rel)} records, their count, or an aggregate? Do not substitute this relation for another relation that shares a status word. A shared status word alone does not name this relation.`,
					relation: human(rel),
					otherRelations: relations.filter((name) => name !== rel).map(human)
				},
				`This exact relation ${human(rel)} is requested.`,
				'Only another relation is mentioned, or no relation constraint is requested.'
			);
			questions[`relation.${rel}`] = {
				type: 'choice',
				instructions: {
					question:
						'Select the quantifier on this named relation only. Examples: no records before D => none; all records done and at least one => nonempty_every; zero records OR an open record => empty_or_some; zero records OR all done => every (empty lists satisfy every). SAME record means some with joined predicates, not every. Only select every/nonempty_every when the description explicitly requires all related records. Ignore counts and aggregates.',
					relation: rel
				},
				criteria: Object.fromEntries(
					Object.entries(modes).map(([key, description]) => [
						key,
						{
							relation: rel,
							meaning: description,
							...(key === 'ignore'
								? {
										rule: `Choose this if the description does not explicitly constrain individual ${rel} records. Do not substitute this relation for a different named relation.`
									}
								: {})
						}
					])
				)
			};
			questions[`count.${rel}`] = noul(
				{
					question:
						'Does the description explicitly constrain the NUMBER of related records, including zero records, that EVERY returned root must satisfy? An empty-list alternative inside OR is NOT a separate count constraint. Do not count "at least one matching record", "none before a date", or "all fulfilled" as a separate total-count constraint.',
					relation: rel
				},
				`An explicit TOTAL number of ${rel} is requested, such as >2, 1 to 3, exactly one, or zero.`,
				`No TOTAL count of ${rel} is requested. "Got one matching record", "same one", "at least one open record", and "none before a date" describe child existence, NOT a total count.`
			);
			questions[`exclude.${rel}`] = noul(
				`Does the description reject roots having a ${rel} record matching its stated child status/date predicate? Examples: "no bounced emails", "email bounced dont wan", "none before a date", "不能有退信". Only answer true for this named relation. Do not apply negation about a different field or relation.`,
				`Matching ${rel} records must NOT exist.`,
				`Matching ${rel} records are allowed, required, or not discussed.`
			);
			questions[`emptyAlternative.${rel}`] = noul(
				`Does the description allow EITHER zero ${rel} OR a condition on ${rel}, as alternatives? Include nested alternatives such as "active AND (no orders OR all fulfilled)". Do not answer true for "no records before a date" or "at least one record and all fulfilled".`,
				`An empty ${rel} list is an ALTERNATIVE to a child condition.`,
				'There is no empty-list OR alternative on this relation.'
			);
			questions[`individual.${rel}`] = noul(
				`Does the description constrain INDIVIDUAL ${rel} records in addition to any count/aggregate? A date/status predicate on individual records is true. An average amount, including "each repayment avg", only constrains AVG, NOT every individual amount. A total or latest date alone is false.`,
				'A separate child-record predicate is requested.',
				'Only counts or aggregates of the whole relation are requested.'
			);
			const aggs = asked.filter(({ f }) => f.path[0]?.k === 'agg' && f.path[0].rel === rel);
			if (aggs.length > 0)
				questions[`aggregate.${rel}`] = {
					type: 'choice',
					instructions: {
						question: `Which measure of ${rel} does the description request? "Latest record", "last record", "most recent record", 最近一笔 and 最后一笔 mean MAX(date); "last month" is a date interval, NEVER a max aggregate; "earliest" means MIN(date). "Total", 累计, 累加 mean SUM; 平均 means AVG. Select none for a date boundary on individual records, including no records before a date.`,
						relation: rel
					},
					criteria: {
						none: `No explicit aggregate of ${rel} is requested, or the description only tests individual records or their count`,
						...Object.fromEntries(
							aggs.map(({ f }, n) => [
								`a${n}`,
								{
									label: f.label,
									path: f.path,
									requires: `The description explicitly names this measure of ${rel}`
								}
							])
						)
					}
				};
		}
		asked.forEach(({ f, conds }, n) => {
			if (f.path.length === 1 && f.ops.some((op) => NO_VALUE.has(op.op)))
				questions[`presence.f${n + 1}`] = noul(
					`Does the description explicitly ask whether the root property ${f.label} is filled, empty, missing, present or absent? A predicate on RELATED records does not require this root property to be filled.`,
					`Presence or absence of ${f.label} itself is requested.`,
					'This property is not presence-tested; a different property or related record is constrained.'
				);
			const scoped = f.path[0] !== undefined && ['count', 'agg'].includes(f.path[0].k);
			const descriptionOf = (c: Cond) =>
				c.label
					.replace(/^(.*?) \(none\) › /, 'No $1 have ')
					.replace(/^(.*?) \(all\) › /, 'Every $1 has ')
					.replace(/^(.*?) \(any\) › /, 'At least one $1 has ');
			questions[`f${n + 1}`] = {
				type: 'choice',
				instructions: {
					question: scoped
						? 'If this exact count or aggregate property is requested, select its exact comparison and value, preserving BOTH range boundaries. If it is not requested, choose no condition. Do not substitute an individual-record predicate or another measure.'
						: f.path.length === 1 && DAY_KINDS.has(f.kind)
							? 'Does the description explicitly constrain this TOP-LEVEL date property? A date on a related record (such as when an order was placed) is NOT a constraint on the root record creation or update time: choose no condition for this property. Only select a comparison when this exact root date is requested; preserve both range boundaries.'
							: ['enum', 'state'].includes(f.kind)
								? 'First check whether the description explicitly constrains this STATUS. Excluding empty lists (no orders do not show) is existence, NOT status: choose no condition when no status is requested. When status IS requested, unfinished/pending work (未完成) means work still open/in progress and excludes cancellation. Prefer that positive business state over negating completion, which also admits cancelled records. Explicit logical negation including cancelled records still selects the negated state.'
								: 'Which option states a condition requested by the description? Match the complete meaning, including the relation quantifier. Preserve BOTH range boundaries. Choose no condition when none of these conditions is requested.',
					field: {
						label: f.label,
						kind: f.kind,
						path: f.path,
						...(f.hint === undefined ? {} : { hint: f.hint }),
						...(f.found === undefined ? {} : { matchingRecords: f.found })
					}
				},
				criteria: {
					[NO]: {
						description: `No explicit constraint on this exact property ${f.label}; do not add redundant or incidental matches`,
						where: null
					},
					...Object.fromEntries(
						conds.map((c) => [c.label, { description: descriptionOf(c), where: c.where }])
					)
				}
			};
			conds
				.find((c) => c.list !== undefined)
				?.list?.forEach((v, k) => {
					questions[`f${n + 1}.${k}`] = noul(
						`Is ${v.label} one of the ${f.label} values the description names?`,
						`it names ${v.label}`,
						`it does not name ${v.label}`
					);
				});
		});
		questions['combine'] = {
			type: 'choice',
			instructions:
				'How do ROOT conditions combine, treating each relation condition as one complete group? For "active AND (no orders OR all fulfilled)" choose all of them hold: the OR is INSIDE the relation, not between active and the relation. For "no orders OR open orders" the entire OR is likewise inside the relation group. Negation of individual predicates is already handled by their operators and relation quantifiers; do not negate them again.',
			criteria: Object.fromEntries(Object.entries(COMBINE).map(([k, v]) => [k, v.because]))
		};
		if (orders.length > 0)
			questions['sort'] = {
				type: 'choice',
				instructions: 'Which order does the description ask for?',
				criteria: { [NO_ORDER]: 'it asks for no order', ...own(orders.map((x) => x.label)) }
			};
		// admission is semantic, not a keyword guard: an exposed current flag or a related aggregate can express a selection
		// that otherwise needs comparisons across root records
		questions['selection.unsupported'] = noul(
			'Does satisfying the requested selection require comparing top-level records with other top-level records, selecting a ranked subset or a maximum/minimum per group, or limiting the record count, rather than testing the offered field and relation conditions? A descending sort changes order only; it does not select latest-only or one record per group. Answer false when an exposed current/latest flag or an offered related aggregate directly represents the requested selection.',
			'the requested selection requires unsupported cross-record comparisons or ranking',
			'the requested selection is represented by the offered conditions and ordering'
		);
		questions['selection.filteredAggregate'] = noul(
			'Does an explicitly requested count greater than one, sum or average apply ONLY to a filtered subset of related records? Examples: "count only open orders, require at least 2" or "sum only September repayments". A TOTAL count plus an independent status/date condition is false. A grand total between two bounds has NO filtered subset. "Not each payment", "bukan setiap bayaran", or "不是每笔" rejects a per-item interpretation; it does not restrict which payments contribute to the total. Only answer true when a stated child property (such as status or date) excludes some children from the aggregate. Some/every/none, one matching child, zero matching children, and same-child date/status predicates are supported and false here.',
			'A numeric aggregate of a filtered child subset is explicitly required.',
			'No filtered-subset aggregate: ordinary whole-list aggregates or child quantifiers suffice.'
		);
		const state = {
			description: o.text,
			literals: values.lit,
			model: human(o.model),
			fields: asked.map(({ f }) => ({ label: f.label, kind: f.kind })),
			today: o.bindings.today,
			timezone: o.bindings.tz,
			weekStartsOn: 'Monday'
		};
		const r = yield* call(state, questions);
		if ('ok' in r) return r;
		// A literal "last/first <relation> before D" has a fixed aggregate meaning; calendar spans are not records.
		const statedExtremum = (rel: string) => {
			const parts = tokens(o.text),
				nouns = tokens(human(rel)).map((x) => x.replace(/s$/, ''));
			for (const [i, part] of parts.entries())
				if (
					['last', 'latest', 'first', 'earliest'].includes(part) &&
					![...'day days week weeks month months quarter quarters year years'.split(' '), ...MONTHS].includes(parts[i + 1] ?? '') &&
					parts.slice(i + 1, i + 4).some((word) => nouns.some((noun) => alike(word, noun) >= MATCH))
				)
					return part === 'last' || part === 'latest' ? 'max' : 'min';
			return undefined;
		};
		const sourceDates = values.lit.dates;
		const sourceDate = sourceDates.length === 1 ? sourceDates[0] : undefined;
		const dateAt = sourceDate === undefined ? -1 : o.text.indexOf(sourceDate);
		const prefix = dateAt < 0 ? '' : o.text.slice(0, dateAt);
		const suffix = dateAt < 0 || sourceDate === undefined ? '' : o.text.slice(dateAt + sourceDate.length);
		const dateComparison = /(?:<=|on or before|不晚于|不晚於)\s*$/i.test(prefix)
			? 'lte'
			: /(?:>=|on or after|not before|不早于|不早於)\s*$/i.test(prefix)
				? 'gte'
				: /(?:\bbefore|\bb4|anterior (?:a|al)|avant (?:le)?|sebelum|早于|早於|<)\s*$/i.test(prefix)
					? 'lt'
					: /(?:\bafter|之后|之後|>)\s*$/i.test(prefix)
						? 'gt'
						: /^\s*(?:之前|以前)/u.test(suffix)
							? 'lt'
							: /^\s*(?:之后|之後|以后|以後)/u.test(suffix)
								? 'gt'
								: undefined;
		// a chosen sort fully explains an ordering request ("sort last created"): ranking refuses only when the text limits
		// or selects records
		const ordered = orders.some((x) => x.label === choiceOf(r, 'sort'));
		const selects =
			/(?<![\p{L}\p{N}])(?:(?:only|just|top|limit(?:ed)?|single|per|each|one|sahaja|saja|teratas|setiap|solo|sólo|únicamente|cada|seulement|uniquement|chaque)(?![\p{L}\p{N}])|(?:first|last|latest|newest|oldest|earliest)\s+\d)|[只仅僅每]|前\s*\d/iu.test(
				o.text
			);
		if (
			(noulOf(r, 'selection.unsupported') > 0.5 && (!ordered || selects)) ||
			noulOf(r, 'selection.filteredAggregate') > 0.5
		)
			return {
				ok: false,
				code: 'invalid',
				message:
					'This description requires cross-record ranking or an aggregate of a filtered subset that the natural-language planner does not offer. Use an explicit supported condition instead.'
			};
		// 5. the chosen conditions: past even odds a condition holds; from HEDGED when its likeliest is evidence at CLOSE
		const picks: { f: Field; c: Cond; p: number; where: Json }[] = [];
		asked.forEach(({ f, conds }, n) => {
			if ((f.kind === 'search' || f.kind === 'semantic') && noulOf(r, 'textSearch') <= 0.5) return;
			const a = r.answers[`f${n + 1}`];
			if (a?.type !== 'choice') return;
			const yes = 1 - (a.probabilities[NO] ?? 0);
			const ranked = conds
				.map((c) => ({ c, p: a.probabilities[c.label] ?? 0 }))
				.sort((l, r2) => r2.p - l.p);
			const explicit =
				f.path[0] !== undefined &&
				['some', 'every', 'none'].includes(f.path[0].k) &&
				(f.kind === 'enum' || f.kind === 'state') &&
				f.values.some(
					(v) =>
						'lit' in v.arg &&
						typeof v.arg.lit === 'string' &&
						o.text.toLowerCase().includes(v.arg.lit.toLowerCase())
				);
			const first = f.path[0];
			const childDate =
				first !== undefined &&
				['some', 'none', 'every'].includes(first.k) &&
				'rel' in first &&
				DAY_KINDS.has(f.kind) &&
				fields.filter(
					(field) =>
						field.path[0]?.k === 'some' &&
						field.path[0].rel === first.rel &&
						DAY_KINDS.has(field.kind)
				).length === 1;
			const literal =
				sourceDates.length === 1 &&
				((first?.k === 'agg' && DAY_KINDS.has(f.kind) && statedExtremum(first.rel) === first.fn) || childDate)
					? conds.find(
							(c) => c.op === dateComparison && c.arg !== undefined && 'lit' in c.arg && c.arg.lit === sourceDates[0]
						)
					: undefined;
			const pick =
				literal === undefined
					? (yes > 0.5 && a.choice !== NO) || explicit
						? ranked[0]
						: undefined
					: { c: literal, p: a.probabilities[literal.label] ?? 0 };
			if (pick === undefined) return;
			if (f.path.length === 1 && NO_VALUE.has(pick.c.op) && noulOf(r, `presence.f${n + 1}`) <= 0.5)
				return;
			if (pick.c.arg !== undefined && 'var' in pick.c.arg && noulOf(r, 'ownership') <= 0.5) return;
			const named = pick.c.list?.filter((_, k) => noulOf(r, `f${n + 1}.${k}`) > 0.5);
			if (named !== undefined && named.length === 0) return;
			const where =
				named === undefined
					? pick.c.where
					: condition(f.path, pick.c.op, { list: named.map((v) => v.arg.lit) });
			if (where === undefined) return;
			picks.push({ f, c: pick.c, p: pick.p, where });
		});
		const kept: Json[] = [];
		const strong = picks.filter((p) => p.c.evidence);
		const rootRelation = (f: Field) => {
			const first = f.path[0];
			return first !== undefined &&
				'rel' in first &&
				['some', 'every', 'none', 'count', 'agg'].includes(first.k)
				? first.rel
				: undefined;
		};
		for (const pick of picks)
			if (
				rootRelation(pick.f) === undefined &&
				(pick.c.evidence ||
					pick.c.value === undefined ||
					!strong.some(
						(p) =>
							p !== pick &&
							tokens(p.c.value ?? '').some((word) => tokens(pick.c.value ?? '').includes(word))
					))
			)
				kept.push(pick.where);
		for (const rel of relations) {
			const selected = picks.filter((p) => rootRelation(p.f) === rel);
			if (noulOf(r, `applicable.${rel}`) <= 0.5) continue;
			const relAggs = asked.filter(({ f }) => f.path[0]?.k === 'agg' && f.path[0].rel === rel);
			const literalAggs = relAggs.filter(
				({ f }) =>
					f.path[0]?.k === 'agg' && f.path[0].fn === statedExtremum(rel) && DAY_KINDS.has(f.kind)
			);
			const aggregateChoice =
				literalAggs.length === 1 && sourceDates.length === 1 && dateComparison !== undefined
					? `a${relAggs.findIndex((field) => field === literalAggs[0])}`
					: choiceOf(r, `aggregate.${rel}`);
			const explicitCount = noulOf(r, `count.${rel}`) > 0.5;
			const modeAnswer = r.answers[`relation.${rel}`];
			const support = (quantifier: string) =>
				Math.max(0, ...selected.filter((p) => p.f.path[0]?.k === quantifier).map((p) => p.p));
			const rankedModes =
				modeAnswer?.type === 'choice'
					? Object.entries(modeAnswer.probabilities)
							.map(([mode, probability]) => ({
								mode,
								score:
									probability *
									(mode === 'ignore'
										? explicitCount || (aggregateChoice !== undefined && aggregateChoice !== 'none')
											? 1
											: 1 - support('some')
										: support(
												mode === 'none'
													? 'none'
													: mode === 'every' || mode === 'nonempty_every'
														? 'every'
														: 'some'
											))
							}))
							.sort((a, b) => b.score - a.score)
					: [];
			const mode =
				aggregateChoice !== undefined &&
				aggregateChoice !== 'none' &&
				(noulOf(r, `individual.${rel}`) <= 0.5 ||
					(statedExtremum(rel) !== undefined &&
						!selected.some((p) => ['enum', 'state'].includes(p.f.kind))))
					? 'ignore'
					: noulOf(r, `exclude.${rel}`) > 0.5
						? 'none'
						: rankedModes[0]?.mode;
			const emptyAlternative =
				(mode !== 'nonempty_every' || DISJUNCTION.test(o.text)) &&
				noulOf(r, `emptyAlternative.${rel}`) > 0.5;
			if (explicitCount && !emptyAlternative && mode !== 'empty_or_some') {
				const count = selected.find((p) => p.f.path[0]?.k === 'count');
				if (count === undefined) return fail(`Could not resolve the requested count of ${rel}.`);
				kept.push(count.where);
			}
			if (aggregateChoice !== undefined && aggregateChoice !== 'none') {
				const field = relAggs[Number(aggregateChoice.slice(1))]?.f;
				const aggregate = selected.find((p) => p.f === field);
				if (aggregate === undefined)
					return fail(`Could not resolve the requested aggregate of ${rel}.`);
				kept.push(aggregate.where);
			}
			if (mode === undefined || mode === 'ignore') continue;
			const quantifier =
				mode === 'none'
					? 'none'
					: mode === 'every' || mode === 'nonempty_every'
						? 'every'
						: 'some';
			const children = selected
				.filter((p) => p.f.path[0]?.k === quantifier)
				.map((p) => condition(p.f.path.slice(1), p.c.op, p.c.arg));
			if (children.length === 0 || children.some((p) => p === undefined))
				return fail(`Could not resolve the requested conditions on ${rel}.`);
			const predicates = children.filter((p): p is Json => p !== undefined);
			const child: Json = predicates.length === 1 ? predicates[0] ?? { and: predicates } : { and: predicates };
			const group: Json = { [rel]: { [quantifier]: child } };
			kept.push(
				mode === 'nonempty_every' && !emptyAlternative
					? { and: [{ [rel]: { count: { gt: 0 } } }, group] }
					: emptyAlternative || mode === 'empty_or_some'
						? { or: [{ [rel]: { count: { eq: 0 } } }, group] }
						: group
			);
		}
		if (kept.length > FILTER_MAX_CONDITIONS) return fail('Too many conditions in one description.');
		const chosen = Object.entries(COMBINE).find(([name]) => name === choiceOf(r, 'combine'))?.[1]
			?? COMBINE['all of them hold'];
		const join = chosen.join === 'or' && !DISJUNCTION.test(o.text) ? 'and' : chosen.join;
		const group = kept.length <= 1 ? kept[0] : { [join]: kept };
		const where: Json | undefined =
			group !== undefined && kept.length > 1 && chosen.not && NEGATION.test(o.text)
				? { not: group }
				: group;
		const sort = orders.find((x) => x.label === choiceOf(r, 'sort'));
		const order_by: Json | undefined =
			sort === undefined
				? undefined
				: sort.key.split('.').reduceRight<Json>((v, k) => ({ [k]: v }), sort.dir);
		if (where === undefined && order_by === undefined)
			return fail('No field here matches that description. Try naming a field and a value.');
		if (!local) {
			// the same strict decode as any read literal, held to the caller's exposure
			const checked = yield* viewOf(o.authority, o.model).pipe(
				Effect.flatMap((view) =>
					decodeDescribed(
						view.cat,
						o.authority,
						o.model,
						{
							...(where === undefined ? {} : { where }),
							...(order_by === undefined ? {} : { order_by })
						},
						o.bindings
					)
				),
				Effect.result
			);
			if (Result.isFailure(checked)) return fail(checked.failure.message);
		}
		return {
			ok: true,
			...(where === undefined ? {} : { where }),
			...(order_by === undefined ? {} : { order_by })
		};
	});
	const opts = Effect.fn('Agents.opts')(function* (o: {
		model: string;
		authority: Authority;
		bindings: Bindings;
		localFields?: readonly LocalFilterField[];
	}): Effect.fn.Return<FilterOptions, BoltError> {
		const values = valuesOf('', o.bindings.today);
		const subjectOf = subject(o, o.bindings.today, values);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		return {
			ok: true,
			fields: catalogue(subjectOf.fields ?? (yield* fieldsOf(o.model, '', o.authority, o.bindings, values)))
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
							message: 'Could not build a filter from that description.'
						})
				})
			),
		options: opts
	};
}
export const filter_describe = Effect.gen(function* () {
	const manifest = yield* Manifest,
		reads = yield* Reads,
		decisions = yield* Decisions,
		ai = yield* Ai;
	return make_filter_describe({ manifest, read: reads.run, decisions, ai });
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
	/** What its time variables (`{ var: 'today' | 'now' }`) are: the read's own day and instant. */
	at: { readonly today: string; readonly now: string }
): Effect.fn.Return<void, BoltError> {
	const root = cat.exposures.get(model);
	if (root === undefined || !readsAny(a, model))
		return yield* refuse(`'${model}' is not read by this caller`);
	const field = (x: ExposureInfo, f: string) => {
		const base = f.split('.')[0] ?? f;
		if (!exposed_field(x, base)) throw refuse(`'${x.path}.${f}' is not a field this caller reads`);
	};
	/** The declared layer a hop through `r` reads; any other hop is refused. */
	const rel = (x: ExposureInfo, r: string, target: string) => {
		const t = levelOf(cat, x, r, target);
		if (t === undefined) throw refuse(`'${x.path}.${r}' is not a relation this caller reads`);
		return t;
	};
	const walk = (p: Pred, x: ExposureInfo): void => {
		switch (p.t) {
			case 'const':
			// the search document and the embedding cover the model's searched fields, not one field the caller reads
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
	const where = q.where === undefined
		? undefined
		: yield* decodeWhere(cat, model, materialize(q.where, at)).pipe(Effect.mapError(from_store));
	const keys = q.order_by === undefined ? [] : yield* order(q.order_by, cat, model).pipe(Effect.mapError(from_store));
	yield* Effect.try({
		try: () => {
			if (where !== undefined) walk(where, root);
			// a related key (`assignee.name`): each hop a declared layer, then its field
			for (const k of keys) {
				const steps = k.field.split('.');
				let x = root;
				for (const s of steps.slice(0, -1)) x = rel(x, s, x.model.one.get(s)?.targets[0] ?? '');
				field(x, steps.at(-1) ?? k.field);
			}
		},
		catch: (error) => (error instanceof BoltError ? error : refuse(String(error)))
	});
});
