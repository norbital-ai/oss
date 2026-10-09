// AI filtering (rule 16a, P33, P34, P37): the view popover's "Describe what to show…" becomes a typed `Where` and an
// `OrderBy` key through ONE `sys_1` call. System 1 never writes a filter: it chooses among conditions the engine built.
//
//   1. Fields: the collection's exposure narrowed to what the caller reads unmasked — own fields, one-relations and
//      many-relations (any / all / none, count, child totals) up to `FILTER_MAX_HOPS`, the search index (`$search`) and
//      the embedding (`$similar`). Plain data (`FilterStep` paths): `filter.options` hands the same catalogue to the builder.
//   2. Values: the description's own literals (dates, numbers, quoted strings, words, topic phrases), relative spans,
//      enum and state names, me / my team / my party, and ONE batched read as the caller: the records a relation's words
//      name (through the search index where declared), the phrases the collection's own records hold, and named days —
//      a record the caller reads whose name the description holds and which has a date ("after National Day").
//   3. Conditions: per field, every (operator, value) its kind admits, each built and decoded as any read literal is
//      (`ir.where`). A condition that does not decode — a text operator on a number, a number against text, one day for
//      "is within" — is never offered, so it can never be chosen.
//   4. One call: per field one choice, "no condition" or one of its conditions (a list operator's values are a yes / no
//      each, as several can hold); one sort choice of (key, direction) or none; how the conditions combine; and whether
//      the ask needs a selection the grammar cannot express.
//   5. The chosen conditions compose under one top-level group and decode once more, held to the caller's exposure.
//
// No fallback (owner): a System 1 failure, or nothing chosen, applies nothing. The whole answers within
// `FILTER_DEADLINE_MS`. Sorting is by an own sortable field or, one hop through an exposed one-relation, a target field.
import { randomUUID } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import { BoltError, type AiPort, type Authority, type Bindings, type EngineManifest, type MeteringPort, type Pred, type ReadEngine, type TenantDb } from '../contracts.ts';
import { ask, choiceOf, decisionEvent, failed, meter, noulOf, type DecisionQuestion, type DecisionRequest, type DecisionResult } from '../decisions/index.ts';
import { catalogOf } from '../access/pred.ts';
import { midnight } from '../query/eval.ts';
import { exposedField, exposedRelation, type Catalog, type FieldInfo } from '../../protocol/catalog.ts';
import * as ir from '../../protocol/ir.ts';

/** The stated conditions a description may produce. */
export const FILTER_MAX_CONDITIONS = 4;
/** Fields asked about in the one request: the ones the description most plausibly names. */
export const FILTER_MAX_FIELDS = 16;
export const FILTER_MAX_TEXT = 500;
/** A description answers within this: its one read and its one `sys_1` call together. */
export const FILTER_DEADLINE_MS = 1_000;
/** Relation hops a condition path may take (a many-relation's quantifier is a hop). */
export const FILTER_MAX_HOPS = 2;

const CANDIDATES = 5, WORDS = 8, MAX_TOPICS = 4;
/** Collections searched for a named day, at most. ponytail: the first that hold a date; rank them if a workspace has more. */
const MAX_DATED = 8;
const NO = 'no condition', NO_ORDER = 'no particular order';
/** The likeness at which a typed token matches a label's token. */
const MATCH = 0.5;
/** A hedged answer (no condition under 0.7) still counts when its likeliest condition is evidence at this or more. */
const CLOSE = 0.2, HEDGED = 0.3;
/** A disjunction or a negation the text never states is System 1 misreading the composition. */
const DISJUNCTION = /\b(or|nor|either|neither|any of|whichever)\b/i;
const NEGATION = /\b(not|no|without|except|excluding|neither|nor|none|never|isn['’]?t|aren['’]?t|other than|outside)\b/i;
/** Words that put a day on a condition: only then are named days looked for. */
const DAY_WORDS = /\b(after|before|since|until|till|from|on|by|between|during|around|following|prior)\b/i;
const LIST_OPS = new Set(['in', 'nin', 'hasAny', 'hasAll']);
const NO_VALUE = new Set(['isNull', 'notNull', 'isEmpty', 'notEmpty']);
const DAY_KINDS = new Set(['date', 'instant']);

/** The child aggregates a many-relation offers. */
export type FilterAgg = 'sum' | 'avg' | 'min' | 'max';
/**
 * One step of a condition's nesting from the collection root. `instantiate` folds the steps over the operator object
 * from the innermost out: a field, a one-relation's record (`is`), an exclusive arc's arm, a many-relation's quantifier,
 * its count, or a child aggregate.
 */
export type FilterStep =
	| { k: 'field'; name: string }
	| { k: 'is'; rel: string }
	| { k: 'arm'; rel: string; arm: string }
	| { k: 'some' | 'every' | 'none'; rel: string }
	| { k: 'count'; rel: string }
	| { k: 'agg'; rel: string; fn: FilterAgg; of: string };
/** A value offered for an operator: a literal, a list, a span (`[lo, hi)`) or an actor reference. */
export type FilterArg = { lit: Json } | { list: readonly Json[] } | { range: readonly [Json, Json] } | { actor: 'id' | 'party' | 'teams' }
	/** A one-relation's records whose text field holds a phrase (the description's words a found record holds). */
	| { match: { field: string; phrase: string } }
	/** Within `metres` of a point (a found record's own location). */
	| { near: readonly [{ lat: number; lng: number }, number] };
export type FilterValue = { label: string; arg: FilterArg };
/** One offered (field, operator) pair: a row the builder renders. Plain data. */
export type FilterOffer = {
	/** The field's name ("Assignee › Name", "Lines (any) › Qty", "Lines › count"). */
	label: string;
	/** How the condition nests from the root. */
	path: readonly FilterStep[];
	/** The machine operator. */
	op: string;
	/** The operator's words ("is", "is within", "before", "has any of"). */
	opLabel: string;
	/** The literal's kind for the editor. */
	kind: string;
	values?: readonly FilterValue[];
	/** The field's `OrderBy` key where it may order the records. */
	sort?: string;
};
export type FilterCatalogue = readonly FilterOffer[];
export type Described = { ok: true; where?: Json; orderBy?: Json } | { ok: false; code: string; message: string };
export type LocalFilterField = { name: string; label: string; kind: 'text' | 'number' | 'bool'; optional?: boolean };

type Op = { op: string; label: string };
/** One field: its operators and values. */
type Field = { label: string; path: readonly FilterStep[]; kind: string; ops: readonly Op[]; values: FilterValue[]; sort?: string;
	/** The records the description's words found, named in its question. */ found?: string[];
	/** How strongly the description names the field: label words, a found record, one of its declared values. */ named?: number };
/** One whole condition System 1 may choose. `list`: a list operator's candidate values, each its own yes / no. */
type Cond = { label: string; op: string; arg?: FilterArg; list?: readonly FilterValue[]; value?: string; evidence: boolean; where: Json };
/** A sort System 1 may choose: a key and its direction, or nearest first from a found record. */
type Order = { label: string; key: string; dir: 'asc' | 'desc' | { near: { lat: number; lng: number } } };

const NUMERIC = new Set(['int', 'decimal', 'money', 'number', 'count', 'sum', 'duration']);
/** Kinds `OrderBy` refuses: no sort key is offered on them (the builder's own `UNSORTABLE`). */
const UNSORTABLE = new Set(['json', 'file', 'custom', 'vector', 'point', 'period', 'ref']);
const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'from', 'are', 'aren', 'not', 'isn', 'all', 'any', 'show', 'only',
	'first', 'last', 'next', 'newest', 'oldest', 'week', 'month', 'year', 'quarter', 'today', 'yesterday', 'days', 'done', 'open', 'what', 'which', 'who', 'whose',
	// the sort's own words are never a value (staging: "landed sites, sorted by name descending" filtered name = "descending")
	'sort', 'sorted', 'order', 'ordered', 'ascending', 'descending', 'alphabetical', 'alphabetically', 'reverse', 'highest', 'lowest', 'latest', 'earliest']);
const human = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

/** Rule 16a's relative spans: day bounds on `date` fields, calendar bounds (Monday weeks, workspace timezone) on both. */
function spans(kind: 'date' | 'instant'): FilterValue[] {
	const range = (lo: Json, hi: Json): FilterArg => ({ range: [lo, hi] });
	const at = (unit: string, shift: number): Json => shift === 0 ? { startOf: unit } : { startOf: unit, shift };
	const out: FilterValue[] = [];
	if (kind === 'date') {
		const off = (n: number): Json => n === 0 ? '' : `${n > 0 ? '+' : '-'}${Math.abs(n)}d`;
		for (const [label, [a, b]] of [['today', [0, 1]], ['yesterday', [-1, 0]], ['last 7 days', [-7, 1]], ['next 7 days', [0, 8]], ['last 30 days', [-30, 1]]] as const)
			out.push({ label, arg: range({ today: off(a) }, { today: off(b) }) });
	}
	for (const unit of ['week', 'month', 'quarter', 'year']) {
		out.push({ label: `this ${unit}`, arg: range(at(unit, 0), at(unit, 1)) });
		out.push({ label: `last ${unit}`, arg: range(at(unit, -1), at(unit, 0)) });
		if (unit === 'week') out.push({ label: `next ${unit}`, arg: range(at(unit, 1), at(unit, 2)) });
	}
	return out;
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = String.raw`(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`, DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
/** "3rd October", "3 oct 2026", "the 3rd of October"; "October 3", "Oct 3rd, 2026". */
const DAY_MONTH = new RegExp(String.raw`\b${DAY}\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4}))?\b`, 'gi');
const MONTH_DAY = new RegExp(String.raw`\b${MONTH}\s+${DAY}(?:,?\s+(\d{4}))?\b`, 'gi');
/**
 * Quoted strings, numbers and dates (ISO, day-first `d/m/yyyy` — month-first in `en-US` — or a named month, its year
 * `today`'s when unstated) from the text.
 */
export function literals(text: string, locale: string, today = new Date().toISOString().slice(0, 10)): { strings: string[]; numbers: number[]; dates: string[] } {
	const dates: string[] = [];
	const push = (y: string, m: string, d: string) => {
		const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
		// a day the month does not have (31 June) is no date
		if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso)) dates.push(iso);
		return ' ';
	};
	const month = (name: string) => String(MONTHS.findIndex((x) => x.startsWith(name.toLowerCase().slice(0, 3))) + 1);
	const rest = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (d) => (dates.push(d), ' ')).replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, a: string, b: string, y: string) =>
		locale === 'en-US' ? push(y, a, b) : push(y, b, a))
		.replace(DAY_MONTH, (_, d: string, m: string, y?: string) => push(y ?? today.slice(0, 4), month(m), d))
		.replace(MONTH_DAY, (_, m: string, d: string, y?: string) => push(y ?? today.slice(0, 4), month(m), d));
	return { dates, strings: [...rest.matchAll(/(?:^|\s)["“']([^"”']+)["”']/g)].map((x) => x[1]!.trim()),
		numbers: [...rest.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((x) => Number(x[0])) };
}
/** The radius the text states ("within 2 km", "500m"), else a kilometre. */
function metresOf(text: string): number {
	const x = /(\d+(?:\.\d+)?)\s*(km|kilomet(?:re|er)s?|m|met(?:re|er)s?)\b/i.exec(text);
	if (x === null) return 1000;
	const n = Number(x[1]);
	return Math.round(/^k/i.test(x[2]!) ? n * 1000 : n);
}
/** Search terms: letters or digits, three or more ("595001", "grove"), no stop words. */
const terms = (text: string) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, WORDS);
const tokens = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const grams = (w: string) => [...new Set(Array.from({ length: w.length - 2 }, (_, i) => w.slice(i, i + 3)))];
/** How alike two tokens are: one the other's prefix is 1, else their shared trigrams (a typo keeps most of them). */
const alike = (a: string, b: string) => {
	if (a === b || (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b))) return 1;
	if (a.length < 3 || b.length < 3) return 0;
	const x = new Set(grams(a)), y = grams(b);
	return y.filter((g) => x.has(g)).length / (x.size + y.length - y.filter((g) => x.has(g)).length);
};
/** The longest run of the text's tokens a label holds in order, spelled as the label spells it ("" when under two tokens). */
function held(text: string, label: string, least = 2): string {
	const t = tokens(text), l = tokens(label);
	let best: string[] = [];
	for (let i = 0; i < t.length; i++) for (let j = 0; j < l.length; j++) {
		const run: string[] = [];
		while (i + run.length < t.length && j + run.length < l.length && alike(t[i + run.length]!, l[j + run.length]!) >= MATCH) run.push(l[j + run.length]!);
		if (run.length > best.length) best = run;
	}
	return best.length >= least && (best.length > 1 || (best[0]!.length >= 4 && !STOP.has(best[0]!))) ? best.join(' ') : '';
}
/** Words that frame a topic rather than name it ("about", "after", "with"), and the calendar's own words. */
const FRAME = new Set([...STOP, 'about', 'regarding', 'related', 'relating', 'similar', 'like', 'mention', 'mentions', 'mentioning', 'involving', 'concerning',
	'to', 'of', 'in', 'on', 'at', 'by', 'a', 'an', 'is', 'was', 'be', 'has', 'have', 'had', 'without', 'after', 'before', 'since', 'until', 'between', 'than',
	'more', 'less', 'over', 'under', 'me', 'my', 'our', 'their', 'his', 'her', 'its', 'records', 'record', 'ones', 'items', 'entries', 'or', 'nor', 'not', 'no',
	'st', 'nd', 'rd', 'th', ...MONTHS, 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
/** The runs of the description's own words a search or a meaning could be about ("water leaks" in "jobs about water leaks
 * after 3rd October"): framing words, numbers and the collection's and fields' names split them; quoted strings as given. */
function topics(text: string, names: readonly string[]): string[] {
	const named = new Set(names.flatMap((n) => tokens(n)).flatMap((t) => [t, t.replace(/s$/, ''), `${t}s`]));
	const runs: string[] = [];
	let run: string[] = [];
	const end = () => { if (run.length > 0) runs.push(run.join(' ')); run = []; };
	for (const t of text.toLowerCase().replace(/(?<=\p{L})['’]s\b/gu, '').match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu) ?? []) {
		if (/^[\p{L}]{2,}$/u.test(t) && !FRAME.has(t) && !named.has(t)) run.push(t); else end();
	}
	end();
	return [...new Set([...literals(text, 'en').strings, ...runs])].slice(0, MAX_TOPICS);
}
const words = (text: string) => [...new Set((text.toLowerCase().replace(/'s\b/g, '').match(/\p{L}{3,}/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, WORDS);
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** A `contains` pattern: the words in order, anything between them. */
const loose = (s: string) => `%${s.trim().split(/\s+/).map(esc).join('%')}%`;

/** The operators and values a field is offered with, or `undefined` when no option can express it. */
/** The values copied from the description (its words, quoted strings, numbers, dates): offered, but never evidence. */
const ECHOES = new WeakSet<FilterArg>();
const echoed = (x: Json): FilterArg => { const a = { lit: x }; ECHOES.add(a); return a; };

function options(f: Pick<FieldInfo, 'kind' | 'many' | 'periodOf'>, s: Spec | undefined, lit: ReturnType<typeof literals>, ws: readonly string[], tz: string): { ops: Op[]; values: FilterValue[] } | undefined {
	const values: FilterValue[] = [];
	const add = (label: string, arg: FilterArg) => { let l = label, n = 2; while (values.some((v) => v.label === l)) l = `${label} (${n++})`; values.push({ label: l, arg }); };
	const op = (name: string, label: string): Op => ({ op: name, label });
	const k = f.kind;
	let ops: Op[];
	if (f.many) {
		// any list field: has one / any / all of the element kind, or is empty (a list is never null-tested)
		if (k === 'enum') for (const v of s?.values ?? []) add(v, { lit: v });
		else if (k === 'text') for (const x of [...lit.strings, ...ws]) add(x, echoed(x));
		else if (NUMERIC.has(k)) for (const x of lit.numbers) add(String(x), echoed(x));
		else if (k === 'date') for (const d of lit.dates) add(d, echoed(d));
		else if (k === 'bool') { add('yes', { lit: true }); add('no', { lit: false }); }
		return { ops: [op('has', 'has'), op('hasAny', 'has any of'), op('hasAll', 'has all of'), op('isEmpty', 'is empty'), op('notEmpty', 'is not empty')], values };
	}
	if (k === 'enum' || k === 'state') {
		ops = [op('eq', 'is'), op('ne', 'is not'), op('in', 'is any of'), op('nin', 'is none of')];
		const states = s?.states ?? {};
		for (const v of k === 'enum' ? s?.values ?? [] : Object.keys(states)) add(v, { lit: v });
		if (k === 'state') add('a final state', { list: Object.keys(states).filter((x) => (states[x]!.to ?? []).length === 0) });
	} else if (k === 'bool') {
		ops = [op('eq', 'is')]; add('yes', { lit: true }); add('no', { lit: false });
	} else if (k === 'text') {
		ops = [op('like', 'contains'), op('eq', 'is'), op('ne', 'is not'), op('in', 'is any of'), op('nin', 'is none of')];
		for (const x of [...lit.strings, ...ws]) add(x, echoed(x));
	} else if (NUMERIC.has(k)) {
		ops = [op('eq', 'is'), op('ne', 'is not'), op('gt', 'more than'), op('gte', 'at least'), op('lt', 'less than'), op('lte', 'at most'),
			op('in', 'is any of'), op('nin', 'is none of')];
		for (const x of lit.numbers) add(String(x), echoed(x));
	} else if (k === 'date' || k === 'instant' || k === 'time') {
		const when = k !== 'time';
		ops = [...(when ? [op('during', 'is within')] : []), op('eq', 'is'), op('ne', 'is not'), op('gt', when ? 'after' : 'more than'), op('gte', when ? 'on or after' : 'at least'),
			op('lt', when ? 'before' : 'less than'), op('lte', when ? 'on or before' : 'at most')];
		if (when) for (const v of spans(k)) add(v.label, v.arg);
		if (k === 'date') for (const d of lit.dates) add(d, echoed(d));
		// a day on an instant is that day in the workspace zone: [00:00, next 00:00)
		if (k === 'instant') for (const d of lit.dates) {
			const arg: FilterArg = { range: [midnight(d, tz), midnight(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), tz)] };
			ECHOES.add(arg);
			add(d, arg);
		}
	} else if (k === 'period' && f.periodOf === 'date') {
		// a date period (an employment's effective_range): in force on a day, or overlapping / inside a span
		ops = [op('contains', 'in force on'), op('overlaps', 'overlaps'), op('within', 'is within')];
		add('today', { lit: { today: '' } });
		for (const v of spans('date')) add(v.label, v.arg);
		for (const d of lit.dates) add(d, echoed(d));
	} else if (k === 'json') {
		ops = [op('contains', 'contains')];
	} else if (k === 'id' || k === 'currency') {
		ops = [op('eq', 'is'), op('ne', 'is not'), op('in', 'is any of'), op('nin', 'is none of')];
	} else if (k === 'point' || k === 'file' || k === 'vector' || k === 'custom' || k === 'ref') {
		ops = [];
	} else return undefined;
	if (s?.optional === true) ops.push(op('isNull', 'is empty'), op('notNull', 'is not empty'));
	return ops.length === 0 && k !== 'point' ? undefined : { ops, values }; // a point is kept: a found record's location offers "within … of it"
}

/** The operator object an op and its argument make; `undefined` when the pair means nothing. */
function operator(op: string, arg: FilterArg | undefined): Json | undefined {
	if (op === 'search' || op === 'similar') return arg !== undefined && 'lit' in arg && typeof arg.lit === 'string' ? arg.lit : undefined;
	if (op === 'isNull') return { isNull: true };
	if (op === 'notNull') return { isNull: false };
	if (op === 'isEmpty') return { isEmpty: true };
	if (op === 'notEmpty') return { isEmpty: false };
	if (arg === undefined) return undefined;
	if ('match' in arg) return op === 'eq' ? { is: { [arg.match.field]: { like: loose(arg.match.phrase) } } } : undefined;
	if ('near' in arg) return op === 'near' ? { near: arg.near as Json } : undefined;
	if ('actor' in arg) {
		if (op === 'eq' || op === 'ne') return { [op]: { actor: arg.actor } };
		// a list operand from an actor is `my teams` alone (ir's list `{ actor }`)
		if ((op === 'in' || op === 'nin') && arg.actor === 'teams') return { [op]: { actor: arg.actor } };
		return undefined;
	}
	if ('range' in arg) {
		const [lo, hi] = arg.range;
		if (op === 'during' || op === 'eq') return { gte: lo, lt: hi };
		if (op === 'between') return { gte: lo, lte: hi };
		if (op === 'overlaps' || op === 'within') return { [op]: { from: lo, to: hi } };
		// a span is [lo, hi): before it is under lo, after it is from hi ("after last week" is from this Monday)
		if (op === 'lt') return { lt: lo };
		if (op === 'lte') return { lt: hi };
		if (op === 'gt') return { gte: hi };
		if (op === 'gte') return { gte: lo };
		return undefined;
	}
	if ('list' in arg) {
		if (op === 'in' || op === 'nin' || op === 'hasAny' || op === 'hasAll') return { [op]: arg.list };
		return undefined;
	}
	// contains, loosely: the words in order with anything between them ("1f pine grove" matches "1F Pine Grove #17-30")
	if (op === 'like') return typeof arg.lit === 'string' ? { like: loose(arg.lit) } : undefined;
	if (op === 'contains') return { contains: arg.lit };
	if (op === 'during') return { eq: arg.lit };
	if (op === 'in' || op === 'nin' || op === 'hasAny' || op === 'hasAll') return { [op]: [arg.lit] };
	if (op === 'has') return { has: arg.lit };
	if (op === 'eq' || op === 'ne' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') return { [op]: arg.lit };
	return undefined;
}
/** The nested JSON a path and an operator object make: the declarative replacement for the old `put` closures. */
export function instantiate(path: readonly FilterStep[], ops: Json): Json {
	return path.reduceRight<Json>((inner, s) => {
		switch (s.k) {
			case 'field': return { [s.name]: inner };
			case 'is': return { [s.rel]: { is: inner } };
			case 'arm': return { [s.rel]: { [s.arm]: inner } };
			case 'some': case 'every': case 'none': return { [s.rel]: { [s.k]: inner } };
			case 'count': return { [s.rel]: { count: inner } };
			case 'agg': return { [s.rel]: { [s.fn]: { of: s.of, ...(inner as { readonly [k: string]: Json }) } } };
		}
	}, ops);
}
/** One condition from a field path, a machine operator and an operand; `undefined` when the pair means nothing. */
function condition(path: readonly FilterStep[], op: string, arg: FilterArg | undefined): Json | undefined {
	// "does not contain": the negated `like`
	if (op === 'unlike') { const like = operator('like', arg); return like === undefined ? undefined : { not: instantiate(path, like) }; }
	// a relation's records NOT holding a phrase: the negated match ("jobs not at pine grove")
	if (arg !== undefined && 'match' in arg && op === 'ne') return { not: instantiate(path, operator('eq', arg)!) };
	const ops = operator(op, arg);
	return ops === undefined ? undefined : instantiate(path, ops);
}

export type FilterDescribeConfig = { manifest: EngineManifest; db: TenantDb; read: ReadEngine['run']; clock: () => string; ai?: AiPort; metering?: MeteringPort };

type Row = { readonly [k: string]: Json };
/** A wire date (`{ $d }`) or plain. */
const day = (v: Json | undefined) => String(typeof v === 'object' && v !== null && !Array.isArray(v) && '$d' in v ? v['$d'] : v);
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const AGGS = [['total', 'sum'], ['average', 'avg'], ['lowest', 'min'], ['highest', 'max']] as const;
const SUMMABLE = ['int', 'decimal', 'money', 'sum', 'count', 'number', 'duration'];
/** Kinds whose value is words: shown quoted in a condition ("Title contains “pump”"). */
const QUOTED = new Set(['text', 'search', 'semantic']);
const same = (a: readonly FilterStep[], b: readonly FilterStep[]) => JSON.stringify(a) === JSON.stringify(b);

export function filterDescribe(cfg: FilterDescribeConfig) {
	const m = cfg.manifest, cat = catalogOf(m);
	/** Whether the caller reads collection `c` and its field `f` unmasked (rule 14): the narrowing of every option. */
	const reads = (a: Authority, c: string) => a.admin || (a.collections[c]?.read.length ?? 0) > 0;
	const unmasked = (a: Authority, c: string, f: string) => a.admin || a.collections[c]?.masks[f] === undefined;
	const spec = (c: string, f: string) => m.models[c]?.fields[f] as Spec | undefined;
	const nameOf = (c: string, f: string) => spec(c, f)?.label ?? human(f);
	/** A collection's searched text fields: where a phrase the person typed can be found. */
	const texts = (c: string) => (cat.collections.get(c)?.model.search ?? []).filter((f) => cat.collections.get(c)?.model.fields.get(f)?.kind === 'text');

	/** 1. Every field the caller may describe on `collection`, with the description's literal values. Reads nothing. */
	function fieldsOf(collection: string, text: string, a: Authority, b: Bindings): Field[] {
		const lit = literals(text, m.workspace.locale, b.today), ws = words(text), out: Field[] = [];
		const cmp: Op[] = [{ op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }, { op: 'gt', label: 'more than' }, { op: 'gte', label: 'at least' },
			{ op: 'lt', label: 'less than' }, { op: 'lte', label: 'at most' }];
		const numbers = () => lit.numbers.map((x) => ({ label: String(x), arg: echoed(x) }));
		/** `target`'s fields under `steps`; `sortFrom` is the dot path they sort by (none past one hop); `hops` remain.
		 * `back` is the relation walked in by, never walked out again ("Assignee › Assigned jobs" is the jobs themselves). */
		const walk = (target: string, steps: readonly FilterStep[], prefix: string, sortFrom: string | undefined, hops: number, back?: string) => {
			const tc = cat.collections.get(target);
			if (tc === undefined || !reads(a, target)) return;
			for (const f of tc.model.fields.values()) {
				const s = spec(target, f.name);
				const system = steps.length === 0 && (f.name === 'created_at' || f.name === 'updated_at');
				if (f.name.includes('.') || (!system && s === undefined && !tc.model.one.has(f.name)) || s?.hidden || !exposedField(tc, f.name) || !unmasked(a, target, f.name)) continue;
				const rel = tc.model.one.get(f.name);
				// a relation is named for its record ("Site"), never its key column ("Site id": System 1 read it as a code)
				const label = prefix + (system ? (f.name === 'created_at' ? 'Created' : 'Updated') : s?.label ?? human(rel === undefined ? f.name : f.name.replace(/_id$/, '')));
				if (rel === undefined) {
					const o = options(f, s, lit, ws, b.tz);
					if (o === undefined) continue;
					const sort = sortFrom === undefined || f.many || UNSORTABLE.has(f.kind) ? undefined : sortFrom === '' ? f.name : `${sortFrom}.${f.name}`;
					out.push({ label, path: [...steps, { k: 'field', name: f.name }], kind: f.kind, ...o, ...(sort === undefined ? {} : { sort }) });
					continue;
				}
				if (hops === 0 || !exposedRelation(tc, f.name) || back === `${target}.${f.name}`) continue;
				// the record itself by its key, then its fields one hop on (one arm per target of an exclusive arc)
				for (const arm of rel.targets.length > 1 ? rel.targets : [undefined]) {
					const at = arm ?? rel.targets[0]!;
					const optional = (m.relationships[`${target}.${f.name}`] as { optional?: true } | undefined)?.optional === true;
					const field: Field = { label: arm === undefined ? label : `${label} (${human(arm)})`, kind: 'record',
						path: [...steps, arm === undefined ? { k: 'field', name: f.name } : { k: 'arm', rel: f.name, arm }],
						ops: [{ op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }, { op: 'in', label: 'is any of' }, { op: 'nin', label: 'is none of' },
							...(optional ? [{ op: 'isNull', label: 'is empty' }, { op: 'notNull', label: 'is not empty' }] : [])],
						values: [...(at === 'sys_user' ? [{ label: 'me', arg: { actor: 'id' } }] : []), ...(at === 'sys_team' ? [{ label: 'my team', arg: { actor: 'teams' } }] : []),
							...(a.actor.kind === 'member' && a.actor.party?.collection === at ? [{ label: 'my party', arg: { actor: 'party' } }] : [])] as FilterValue[] };
					out.push(field);
					walk(at, [...steps, arm === undefined ? { k: 'is', rel: f.name } : { k: 'arm', rel: f.name, arm }], `${field.label} › `,
						arm === undefined && steps.length === 0 ? f.name : undefined, hops - 1, `${target}.${f.name}`);
				}
			}
			// many-relations, at the root and one relation hop on ("Customer › Invoices (any) › Status"): has any / none (and, at
			// the root, all) of the related records, how many, and child totals. A related record's own relations are not walked:
			// the catalogue the builder receives grows with every hop (hr-payroll: 0.4 MB → 3 MB a collection at full depth).
			if (hops > 0 && steps.every((x) => x.k === 'is')) for (const [r, rel] of tc.model.many) {
				const child = cat.collections.get(rel.child);
				if (child === undefined || !exposedRelation(tc, r) || !reads(a, rel.child) || rel.column.includes('__') || back === `${rel.child}.${rel.column}`) continue;
				const rl = prefix + human(r);
				for (const [q, word] of steps.length === 0 ? [['some', 'any'], ['every', 'all'], ['none', 'none']] as const : [['some', 'any'], ['none', 'none']] as const)
					walk(rel.child, [...steps, { k: q, rel: r }], `${rl} (${word}) › `, undefined, 0);
				// how many: 0 and 1 always ("with no invoices", "with an unpaid one"), then the text's own numbers
				out.push({ label: `${prefix}Number of ${human(r).toLowerCase()}`, path: [...steps, { k: 'count', rel: r }], kind: 'count', ops: cmp,
					values: [{ label: '0', arg: { lit: 0 } }, { label: '1', arg: { lit: 1 } }, ...numbers().filter((v) => v.label !== '0' && v.label !== '1')] });
				for (const f of child.model.fields.values()) {
					const s = spec(rel.child, f.name);
					if (s === undefined || s.hidden || f.many || !exposedField(child, f.name) || !unmasked(a, rel.child, f.name)) continue;
					for (const [word, fn] of AGGS) if (SUMMABLE.includes(f.kind) || ((fn === 'min' || fn === 'max') && (f.kind === 'date' || f.kind === 'instant')))
						out.push({ label: `${rl} › ${word} ${(s.label ?? human(f.name)).toLowerCase()}`, path: [...steps, { k: 'agg', rel: r, fn, of: f.name }], kind: f.kind, ops: cmp, values: numbers() });
				}
			}
			// the search index and the embedding, to a caller who reads every field they cover unmasked (rule 14)
			const whole = (fs: readonly string[]) => fs.every((x) => exposedField(tc, x) && unmasked(a, target, x));
			const about = () => topics(text, [target, human(target), ...[...tc.model.fields.keys()].map(human), prefix]).map((x) => ({ label: x, arg: echoed(x) }));
			if (tc.model.search.length > 0 && whole(tc.model.search))
				out.push({ label: `${prefix}Search`, path: [...steps, { k: 'field', name: '$search' }], kind: 'search', ops: [{ op: 'search', label: 'has all the words' }], values: about() });
			if (tc.model.semantic !== undefined && whole(tc.model.semantic.fields))
				out.push({ label: `${prefix}Topic`, path: [...steps, { k: 'field', name: '$similar' }], kind: 'semantic', ops: [{ op: 'similar', label: 'is about' }], values: about() });
		};
		walk(collection, [], '', '', FILTER_MAX_HOPS);
		return out;
	}

	/** Adds a value a read found; it replaces the description's own word of the same label (found beats echoed). */
	const found = (f: Field, label: string, arg: FilterArg) => {
		const at = f.values.findIndex((v) => v.label === label);
		if (at < 0) f.values.push({ label, arg });
		else if (ECHOES.has(f.values[at]!.arg)) f.values[at] = { label, arg };
	};

	/**
	 * 2. The one read, as the caller: the records a relation's words name, the phrases the collection's own records hold
	 * and named days. Their values join the fields; a found record with a location offers "nearest to it" orders.
	 */
	async function lookup(collection: string, text: string, fields: readonly Field[], a: Authority, b: Bindings): Promise<Order[]> {
		const c = cat.collections.get(collection)!, ts = terms(text), orders: Order[] = [];
		const radius = metresOf(text), within = radius >= 1000 ? `${radius / 1000} km` : `${radius} m`;
		const reads_: { q: ReturnType<typeof ir.read>; then: (rows: readonly Row[]) => void }[] = [];
		const at = (path: readonly FilterStep[]) => fields.find((f) => same(f.path, path));
		const points = fields.filter((f) => f.kind === 'point' && (f.path.length === 1 || (f.path.length === 2 && f.path[0]!.k === 'is')));
		// a) a relation's records the words name: through the search index where declared, else by label, word by word
		for (const f of fields) {
			const s = f.path[0];
			if (f.kind !== 'record' || f.path.length !== 1 || s?.k !== 'field') continue;
			const target = c.model.one.get(s.name)!.targets[0]!, x = cat.collections.get(target)!;
			const tl = [m.models[target]?.label ?? 'name'].flat()[0]!;
			if (x.model.fields.get(tl)?.kind !== 'text' || !reads(a, target) || !unmasked(a, target, tl)) continue;
			const own = points.filter((p) => p.path.length === 1 || (p.path[0] as { rel: string }).rel === s.name);
			const select = Object.fromEntries([tl, ...texts(target), ...own.filter((p) => p.path.length === 2).map((p) => (p.path[1] as { name: string }).name)]
				.filter((n) => unmasked(a, target, n)).map((n) => [n, true]));
			const then = (rows: readonly Row[]) => {
				for (const row of rows) {
					const label = String(row[tl]);
					found(f, label, { lit: String(row['id']) });
					if (!(f.found ??= []).includes(label)) f.found.push(label);
					for (const t of texts(target)) {
						// the words the person typed that the record holds ("1f pine grove" in "1F Pine Grove #17-30"): every such record
						const phrase = held(text, String(row[t] ?? ''), 1);
						if (phrase === '') continue;
						found(f, `one whose ${nameOf(target, t)} contains “${phrase}”`, { match: { field: t, phrase } });
						const search = at([{ k: 'is', rel: s.name }, { k: 'field', name: '$search' }]);
						if (search !== undefined) found(search, phrase, { lit: phrase });
					}
					// "near <it>", "nearest to <it>": where the record is
					const pt = own.filter((p) => p.path.length === 2).map((p) => row[(p.path[1] as { name: string }).name])
						.find((v): v is { lat: number; lng: number } => typeof v === 'object' && v !== null && typeof (v as { lat?: unknown }).lat === 'number');
					if (pt !== undefined) for (const p of own) {
						found(p, `${within} of ${label}`, { near: [pt, radius] });
						orders.push({ label: `${p.label}, nearest to ${label}`, key: p.path.map((x) => 'name' in x ? x.name : x.rel).join('.'), dir: { near: pt } });
					}
				}
			};
			// by the description's terms: a one- or two-letter word is a prefix of half the records ("a" found "Acme")
			if (x.model.search.length > 0 && ts.length > 0) reads_.push({ q: ir.read(cat, target, { search: ts.join(' '), select, limit: CANDIDATES }), then });
			else for (const w of ts) reads_.push({ q: ir.read(cat, target, { where: { [tl]: { like: `%${esc(w)}%` } }, select, limit: CANDIDATES }), then });
		}
		// b) the phrases the collection's own searched text holds, read whole through the index (typos included)
		const own = fields.filter((f) => f.path.length === 1 && f.kind === 'text' && c.model.search.includes((f.path[0] as { name: string }).name));
		if (own.length > 0) {
			const runs = topics(text, [collection, human(collection), ...fields.map((f) => f.label)]), search = at([{ k: 'field', name: '$search' }]);
			if (ts.length > 0) reads_.push({ q: ir.read(cat, collection, { search: ts.join(' '), select: Object.fromEntries(own.map((f) => [(f.path[0] as { name: string }).name, true])), limit: CANDIDATES }),
				then: (rows) => {
					for (const f of own) {
						const phrase = rows.map((r) => held(text, String(r[(f.path[0] as { name: string }).name] ?? ''), 1)).sort((l, r) => r.length - l.length)[0];
						if (!phrase) continue;
						found(f, phrase, { lit: phrase });
						const holders = rows.map((r) => String(r[(f.path[0] as { name: string }).name] ?? '')).filter((x) => held(text, x, 1) !== '');
						(f.found ??= []).push(...holders.filter((x) => !f.found!.includes(x)));
						// over the index, the whole typed run around it ("pmup room" around "room"), which a `contains` would miss
						const run = runs.find((x) => phrase.split(' ').every((w) => x.split(' ').includes(w))) ?? phrase;
						if (search !== undefined) { found(search, run, { lit: run }); (search.found ??= []).push(...holders.filter((x) => !search.found!.includes(x))); }
					}
				} });
		}
		// c) named days: a record the caller reads, with a date, whose name the description holds ("after National Day")
		const dated = fields.filter((f) => f.kind === 'date' || f.kind === 'instant');
		const days: { name: string; day: string }[] = [];
		if (dated.length > 0 && ts.length > 0 && DAY_WORDS.test(text)) {
			let n = 0;
			for (const [name, x] of cat.collections) {
				if (n >= MAX_DATED || name.startsWith('sys_') || !reads(a, name)) continue;
				const readable = (f: string, kind: string) => x.model.fields.get(f)?.kind === kind && !x.model.fields.get(f)!.many && exposedField(x, f) && unmasked(a, name, f);
				const label = [m.models[name]?.label ?? 'name'].flat()[0]!;
				const title = [label, ...x.model.search, 'name', 'title'].find((f) => readable(f, 'text'));
				const when = [label, ...x.model.fields.keys()].find((f) => readable(f, 'date'));
				if (title === undefined || when === undefined) continue;
				n++;
				reads_.push({ q: ir.read(cat, name, { where: { or: ts.map((w) => ({ [title]: { like: `%${esc(w)}%` } })) }, select: { [title]: true, [when]: true }, limit: 20 }),
					then: (rows) => { for (const r of rows) if (held(text, String(r[title] ?? '')) !== '') days.push({ name: String(r[title]), day: day(r[when]) }); } });
			}
		}
		if (reads_.length === 0) return orders;
		const all = await cfg.read(reads_.map((r) => r.q), { as: 'caller', authority: a }, b);
		reads_.forEach((r, i) => r.then((all[i] as { rows: readonly Row[] }).rows));
		// one day per name, the occurrence nearest today ("National Day" in October is this August's)
		// ponytail: nearest occurrence; a "next" / "last" in the text could pick the side
		const near = new Map<string, { name: string; day: string }>();
		const gap = (d: string) => Math.abs(Date.parse(d) - Date.parse(b.today));
		for (const d of days) { const k = d.name.toLowerCase(), was = near.get(k); if (was === undefined || gap(d.day) < gap(was.day)) near.set(k, d); }
		for (const f of dated) for (const d of near.values())
			found(f, `${d.name} (${d.day})`, f.kind === 'date' ? { lit: d.day } : { range: [midnight(d.day, b.tz), midnight(nextDay(d.day), b.tz)] });
		return orders;
	}

	/**
	 * 3. A field's whole conditions: every (operator, value) its kind admits, each built and decoded as a read literal
	 * (`collection`; `$local` has no catalogue, its kinds are its own three). A pair that does not decode is not offered.
	 */
	function condsOf(f: Field, collection: string | undefined, text: string): Cond[] {
		const out: Cond[] = [];
		const lits = f.values.filter((v) => 'lit' in v.arg);
		// a list operator's candidates: what the description names (its words, a declared value it says) or a read found
		const said = text.toLowerCase();
		const named = lits.filter((v) => ECHOES.has(v.arg) || f.found?.includes(v.label) || said.includes(v.label.toLowerCase()));
		const listy = f.kind === 'enum' || f.kind === 'state' || f.kind === 'record' || f.ops.some((x) => x.op === 'hasAny');
		const show = (v: FilterValue) => QUOTED.has(f.kind) && 'lit' in v.arg && typeof v.arg.lit === 'string' ? `“${v.label}”` : v.label;
		const add = (label: string, op: string, arg: FilterArg | undefined, extra: Partial<Cond> = {}) => {
			const where = condition(f.path, op, arg);
			if (where === undefined || out.some((x) => x.label === label)) return;
			if (collection !== undefined) try { ir.where(cat, collection, where); } catch { return; }
			out.push({ label, op, ...(arg === undefined ? {} : { arg }), evidence: arg !== undefined && !ECHOES.has(arg), where, ...extra });
		};
		for (const x of f.ops) {
			const head = `${f.label} ${x.label}`;
			if (NO_VALUE.has(x.op)) { add(head, x.op, undefined); continue; }
			if (LIST_OPS.has(x.op)) {
				// a set the schema names ("a final state", "my teams"), or the values the description names, each a yes / no
				for (const v of f.values) if ('list' in v.arg || 'actor' in v.arg) add(`${head} ${v.label}`, x.op, v.arg, { value: v.label });
				if (listy && named.length >= 2) add(`${head} the ones named`, x.op, { list: named.map((v) => (v.arg as { lit: Json }).lit) },
					{ list: named, evidence: named.some((v) => !ECHOES.has(v.arg)) });
				continue;
			}
			for (const v of f.values) {
				// "is within" takes a span; a span's "is" is "is within"
				if ((x.op === 'during' && !('range' in v.arg)) || (x.op === 'eq' && 'range' in v.arg && f.ops.some((y) => y.op === 'during'))) continue;
				add(`${head} ${show(v)}`, x.op, v.arg, { value: v.label });
				if (x.op === 'like') add(`${f.label} does not contain ${show(v)}`, 'unlike', v.arg, { value: v.label });
			}
		}
		// within a radius of a found record's location (describe only: the builder edits no point)
		for (const v of f.values) if ('near' in v.arg) add(`${f.label} is within ${v.label}`, 'near', v.arg, { value: v.label });
		// between two of the description's own numbers or days, both ends included
		if (f.ops.some((y) => y.op === 'gte')) {
			const ends = lits.filter((v) => ECHOES.has(v.arg)).map((v) => (v.arg as { lit: Json }).lit as string | number).sort((p, q) => p < q ? -1 : 1);
			for (const [i, lo] of ends.entries()) for (const hi of ends.slice(i + 1)) if (lo !== hi) add(`${f.label} between ${lo} and ${hi}`, 'between', { range: [lo, hi] }, { value: `${lo} and ${hi}` });
		}
		return out;
	}

	/** A field's sort keys, in its own words. */
	const orderOf = (f: Field): Order[] => {
		const [up, down] = f.kind === 'date' || f.kind === 'instant' || f.kind === 'time' ? ['earliest first', 'latest first']
			: NUMERIC.has(f.kind) ? ['lowest first', 'highest first'] : ['A to Z', 'Z to A'];
		return [{ label: `${f.label}, ${up}`, key: f.sort!, dir: 'asc' }, { label: `${f.label}, ${down}`, key: f.sort!, dir: 'desc' }];
	};
	/**
	 * How strongly the description names each field: a word of its label (in any inflection: `log` → `logs`), a record a
	 * read found for it, one of its declared values the text says (a state, a choice, `this week`). A word copied from the
	 * description is no evidence; a number names no field but makes every numeric one a candidate.
	 */
	function rank(fields: readonly Field[], text: string, collection: string): Field[] {
		// the collection's own name ("jobs") names every field equally, so none
		const said = text.toLowerCase(), ws = words(text).filter((w) => !tokens(human(collection)).some((x) => w.startsWith(x.replace(/s$/, '')) || x.startsWith(w)));
		const akin = (w: string, x: string) => w.startsWith(x) || x.startsWith(w) || [...w].findIndex((ch, i) => ch !== x[i]) >= 5;
		const score = new Map(fields.map((f) => {
			const label = f.label.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2);
			const declared = f.values.some((v) => !ECHOES.has(v.arg) && new RegExp(`\\b${v.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(said));
			const candidate = f.kind !== 'search' && f.kind !== 'semantic' && f.values.some((v) => ECHOES.has(v.arg) && !ws.includes(v.label) && said.includes(v.label.toLowerCase()));
			// the collection's own search index and meaning stand just behind any named field: no label names them
			const index = f.path.length === 1 && (f.kind === 'search' || f.kind === 'semantic') && f.values.length > 0 ? 0.5 : 0;
			return [f, ws.filter((w) => label.some((x) => akin(w, x))).length + (f.found !== undefined ? 1 : 0) + (declared ? 1 : 0) + (candidate ? 0.25 : 0) + index];
		}));
		// one child relation the text names offers its count, totals and every field under any / all / none: past its first
		// four, the rest wait behind the other candidates, so a second condition ("done", a date) still fits
		const per = new Map<string, number>();
		const crowded = (f: Field) => {
			const s = f.path.find((p) => p.k === 'some' || p.k === 'every' || p.k === 'none' || p.k === 'count' || p.k === 'agg');
			if (s === undefined || !('rel' in s) || score.get(f)! === 0) return false;
			per.set(s.rel, (per.get(s.rel) ?? 0) + 1);
			return per.get(s.rel)! > 4;
		};
		// within a related list: its count, then its fields under "any", before totals and "none" / "all"
		const weight = (f: Field) => f.path.some((p) => p.k === 'agg') ? 2 : f.path.some((p) => p.k === 'none') ? 3 : f.path.some((p) => p.k === 'every') ? 4 : 0;
		const ranked = fields.map((f, i) => ({ f, i })).sort((l, r) => score.get(r.f)! - score.get(l.f)! || weight(l.f) - weight(r.f) || l.f.path.length - r.f.path.length || l.i - r.i).map((x) => x.f);
		const late = new Set(ranked.filter(crowded));
		return [...ranked.filter((f) => score.get(f)! > 0 && !late.has(f)), ...late, ...ranked.filter((f) => score.get(f)! === 0)];
	}

	/** The catalogue as plain data for the builder. Values ride the one row that reads them, "is within"'s spans: repeated
	 * on every operator they made a wide collection's catalogue megabytes. */
	const catalogue = (fields: readonly Field[]): FilterCatalogue => fields.flatMap((f) => f.ops.map((o) => ({ label: f.label, path: f.path, op: o.op, opLabel: o.label, kind: f.kind,
		...(o.op === 'during' && f.values.length > 0 ? { values: f.values } : {}), ...(f.sort === undefined ? {} : { sort: f.sort }) })));
	/** The local view's own fields (`$local`): text, number and bool only, and no relation. */
	const localFields = (fs: readonly LocalFilterField[], text: string): Field[] => fs.map((f) => ({ label: f.label, path: [{ k: 'field' as const, name: f.name }], kind: f.kind,
		...options({ kind: f.kind }, f.optional ? { optional: true } : undefined, literals(text, m.workspace.locale), words(text), m.workspace.tz)!, sort: f.name }));
	/** The collection a caller may describe or see options on; a `$local` view carries its own fields. */
	const subject = (o: { collection: string; authority: Authority; localFields?: readonly LocalFilterField[] }, text: string): { fields?: Field[]; fail?: { ok: false; code: string; message: string } } => {
		const local = o.collection === '$local';
		if (!local && (!cat.collections.has(o.collection) || !reads(o.authority, o.collection)))
			return { fail: { ok: false, code: 'notFound', message: 'Not found or no access.' } };
		if (local && (o.localFields === undefined || o.localFields.length === 0 || o.localFields.length > 50 ||
			o.localFields.some((f) => !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(f.name) || f.label.length > 100 || !['text', 'number', 'bool'].includes(f.kind))))
			return { fail: { ok: false, code: 'invalid', message: 'Invalid local filter fields.' } };
		return local ? { fields: localFields(o.localFields!, text) } : {};
	};

	async function call(state: DecisionRequest['state'], questions: { [id: string]: DecisionQuestion }, ms: number): Promise<DecisionResult | { ok: false; code: string; message: string }> {
		const req = { state, questions };
		const d = await ask(cfg.ai, req, ms);
		const id = randomUUID();
		// the decision's record and its meter are independent: one round trip, not two
		await Promise.all([cfg.db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ($1::timestamptz, $2, 'decision.made', $3, $4::jsonb)`,
			params: [cfg.clock(), failed(d) ? 'warn' : 'info', id, JSON.stringify(decisionEvent('filter', req, d))] }), meter(cfg.metering, d, id)]);
		return failed(d) ? { ok: false, code: d.kind, message: 'Could not build a filter from that description.' } : d;
	}
	/** How the stated conditions combine: one top-level group. */
	const COMBINE: { readonly [c: string]: { join: 'and' | 'or'; not: boolean; because: string } } = {
		'all of them hold': { join: 'and', not: false, because: 'every stated condition holds' },
		'any of them hold': { join: 'or', not: false, because: 'at least one stated condition holds' },
		'not all of them hold': { join: 'and', not: true, because: 'not every stated condition holds' },
		'none of them hold': { join: 'or', not: true, because: 'no stated condition holds' },
	};
	/** A choice's criteria: each option names itself. */
	const own = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, k]));

	/** `filter.describe` as the caller: `{ collection, text }` → a decoded `Where` and optional `OrderBy`, or a typed failure. */
	async function describe(o: { collection: string; text: string; authority: Authority; bindings: Bindings; localFields?: readonly LocalFilterField[] }): Promise<Described> {
		const fail = (message: string): Described => ({ ok: false, code: 'invalid', message });
		if (o.text.trim() === '' || o.text.length > FILTER_MAX_TEXT) return fail(`A description is 1–${FILTER_MAX_TEXT} characters.`);
		if (cfg.ai === undefined) return { ok: false, code: 'notFound', message: 'Describing a filter is not available here.' };
		const started = performance.now();
		const subjectOf = subject(o, o.text);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const local = o.collection === '$local';
		const fields = subjectOf.fields ?? fieldsOf(o.collection, o.text, o.authority, o.bindings);
		const nears = local ? [] : await lookup(o.collection, o.text, fields, o.authority, o.bindings);
		const max = cfg.ai.sys_1.maxChoices ?? Infinity;
		// the fields the description most plausibly names that have a condition to offer, each with all of them
		const asked: { f: Field; conds: Cond[] }[] = [];
		for (const f of rank(fields, o.text, o.collection)) {
			if (asked.length >= FILTER_MAX_FIELDS) break;
			const conds = condsOf(f, local ? undefined : o.collection, o.text).slice(0, max - 1);
			if (conds.length > 0) asked.push({ f, conds });
		}
		const orders = [...nears, ...fields.filter((f) => f.sort !== undefined).flatMap(orderOf)].slice(0, max - 1);
		if (asked.length === 0 && orders.length === 0) return fail('Nothing here can be filtered by a description.');

		// 4. the one call
		const questions: { [id: string]: DecisionQuestion } = {};
		asked.forEach(({ f, conds }, n) => {
			questions[`f${n + 1}`] = { type: 'choice', instructions: `Which condition does the description state on ${f.label}?${f.found === undefined ? '' : f.kind === 'record' ? ` Its words match these ${f.label} records: ${f.found.join('; ')}.` : ` Records hold its words: ${f.found.join('; ')}.`}`,
				criteria: { [NO]: `it states no condition on ${f.label}`, ...own(conds.map((c) => c.label)) } };
			conds.find((c) => c.list !== undefined)?.list!.forEach((v, k) => {
				questions[`f${n + 1}.${k}`] = { type: 'noul', instructions: `Is ${v.label} one of the ${f.label} values the description names?`,
					criteria: { true: `it names ${v.label}`, false: `it does not name ${v.label}` } };
			});
		});
		questions['combine'] = { type: 'choice', instructions: 'How do the stated conditions combine?', criteria: Object.fromEntries(Object.entries(COMBINE).map(([k, v]) => [k, v.because])) };
		if (orders.length > 0) questions['sort'] = { type: 'choice', instructions: 'Which order does the description ask for?',
			criteria: { [NO_ORDER]: 'it asks for no order', ...own(orders.map((x) => x.label)) } };
		// admission is semantic, not a keyword guard: an exposed current flag or a related aggregate can express a selection
		// that otherwise needs comparisons across root records
		questions['selection.unsupported'] = { type: 'noul',
			instructions: 'Does satisfying the requested selection require comparing top-level records with other top-level records, selecting a ranked subset or a maximum/minimum per group, or limiting the record count, rather than testing the offered field and relation conditions? A descending sort changes order only; it does not select latest-only or one record per group. Answer false when an exposed current/latest flag or an offered related aggregate directly represents the requested selection.',
			criteria: { true: 'the requested selection requires unsupported cross-record comparisons or ranking', false: 'the requested selection is represented by the offered conditions and ordering' } };
		const state = { description: o.text, collection: human(o.collection), fields: asked.map(({ f }) => ({ label: f.label, kind: f.kind })),
			today: o.bindings.today, timezone: o.bindings.tz, weekStartsOn: 'Monday' };
		const r = await call(state, questions, Math.max(1, Math.round(FILTER_DEADLINE_MS - (performance.now() - started))));
		if ('ok' in r) return r;
		if (noulOf(r, 'selection.unsupported') > 0.5)
			return { ok: false, code: 'invalid', message: 'This selection requires comparing or ranking records across groups, which the available filters cannot express. Choose a field condition or sort instead.' };

		// 5. the chosen conditions: past even odds a condition holds; from HEDGED when its likeliest is evidence at CLOSE
		const picks: { f: Field; c: Cond; p: number; where: Json }[] = [];
		asked.forEach(({ f, conds }, n) => {
			const a = r.answers[`f${n + 1}`];
			if (a?.type !== 'choice') return;
			const yes = 1 - (a.probabilities[NO] ?? 0);
			const ranked = conds.map((c) => ({ c, p: a.probabilities[c.label] ?? 0 })).sort((l, r2) => r2.p - l.p);
			const evidence = ranked.find((x) => x.c.evidence && x.p >= CLOSE);
			const pick = yes > 0.5 ? ranked[0] : yes >= HEDGED ? evidence : undefined;
			if (pick === undefined) return;
			const named = pick.c.list?.filter((_, k) => noulOf(r, `f${n + 1}.${k}`) > 0.5);
			if (named !== undefined && named.length === 0) return;
			const where = named === undefined ? pick.c.where : condition(f.path, pick.c.op, { list: named.map((v) => (v.arg as { lit: Json }).lit) })!;
			picks.push({ f, c: pick.c, p: pick.p, where });
		});
		// a word the description merely contains yields to what a read found: under a relation a found record pins, inside a
		// phrase a found condition already reads ("pine" beside "1f pine grove"), or as a field's own name ("site")
		const strong = picks.filter((x) => x.c.evidence);
		const rootRel = (p: readonly FilterStep[]) => p.length > 1 && 'rel' in p[0]! ? p[0].rel : p[0]?.k === 'count' || p[0]?.k === 'agg' ? p[0].rel : undefined;
		const under = (x: readonly FilterStep[], y: readonly FilterStep[]) => x[0]?.k === 'is' && (y[0]?.k === 'is' || y[0]?.k === 'field') && ('rel' in y[0] ? y[0].rel : y[0].name) === x[0].rel;
		// a word is read when a found condition holds it, as its value or in its field's name ("unpaid invoice" beside
		// "Customer › Invoices (any) › Status is unpaid"); a lone word that names a field is that field, not a value
		const read = (w: string) => strong.some((s) => tokens(s.c.value ?? '').includes(w) || tokens(s.f.label).some((t) => t === w || t.startsWith(w) || w.startsWith(t.replace(/s$/, ''))));
		const kept = picks.filter((x) => x.c.evidence || !(strong.some((s) => under(x.f.path, s.f.path))
			|| (x.c.value !== undefined && tokens(x.c.value).every(read))
			|| (x.c.value !== undefined && /^\p{L}{3,}$/u.test(x.c.value) && asked.some(({ f }) => tokens(f.label).includes(x.c.value!.toLowerCase())))))
			.sort((l, r2) => r2.p - l.p || r2.f.path.length - l.f.path.length)
			// one of the text's own numbers or words reads once per related list: "any line quantity over 5" is not also "more
			// than 5 lines" (the likelier, then the more specific, reading keeps it)
			.filter((x, i, all) => x.c.evidence || x.c.value === undefined || !all.slice(0, i).some((y) => !y.c.evidence && y.c.value === x.c.value && rootRel(y.f.path) === rootRel(x.f.path)))
			// a day reads once: "scheduled after National Day" is not also "created after" it
			.filter((x, i, all) => !DAY_KINDS.has(x.f.kind) || x.c.value === undefined || !all.slice(0, i).some((y) => DAY_KINDS.has(y.f.kind) && y.c.value === x.c.value))
			// "at least one" beside "any of them …" on the same related list is implied by it
			.filter((x, _, all) => !(x.f.kind === 'count' && (x.c.label.endsWith(' at least 1') || x.c.label.endsWith(' more than 0'))
				&& all.some((y) => y.f.path.some((p) => p.k === 'some' && p.rel === rootRel(x.f.path)))))
			.slice(0, FILTER_MAX_CONDITIONS).map((x) => x.where);
		const chosen = COMBINE[choiceOf(r, 'combine') ?? ''] ?? COMBINE['all of them hold']!;
		// an OR or a negation the text never states is a misreading; one condition negates through its own operator
		const join = chosen.join === 'or' && !DISJUNCTION.test(o.text) ? 'and' : chosen.join;
		const group = kept.length === 0 ? undefined : kept.length === 1 ? kept[0]! : { [join]: kept };
		const where: Json | undefined = group !== undefined && chosen.not && kept.length > 1 && NEGATION.test(o.text) ? { not: group } : group;
		const sort = orders.find((x) => x.label === choiceOf(r, 'sort'));
		const orderBy: Json | undefined = sort === undefined ? undefined : sort.key.split('.').reduceRight<Json>((v, k) => ({ [k]: v }), sort.dir as Json);
		if (where === undefined && orderBy === undefined) return fail('No field here matches that description. Try naming a field and a value.');
		try { // rule 11a: the same strict decode as any read literal, held to the caller's exposure
			if (!local) decodeDescribed(cat, o.authority, o.collection, { ...(where === undefined ? {} : { where }), ...(orderBy === undefined ? {} : { orderBy }) });
		} catch (e) {
			return fail(e instanceof BoltError ? e.message : 'Could not build a filter from that description.');
		}
		return { ok: true, ...(where === undefined ? {} : { where }), ...(orderBy === undefined ? {} : { orderBy }) };
	}
	/** `filter.options` as the caller: the catalogue the builder renders. */
	async function opts(o: { collection: string; authority: Authority; bindings: Bindings; localFields?: readonly LocalFilterField[] }): Promise<{ ok: true; fields: FilterCatalogue } | { ok: false; code: string; message: string }> {
		const subjectOf = subject(o, '');
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		return { ok: true, fields: catalogue(subjectOf.fields ?? fieldsOf(o.collection, '', o.authority, o.bindings)) };
	}
	return { describe, options: opts };
}
export type FilterDescribe = ReturnType<typeof filterDescribe>;

type Spec = { label?: string; hidden?: true; optional?: true; values?: readonly string[]; states?: { readonly [s: string]: { to?: readonly string[] } } };
const refuse = (message: string) => new BoltError('invalid', 'decode', message);

/**
 * The strict decode of a described filter and sort (rule 11a, rule 16a): `ir.where`/`ir.order`'s grammar, and every
 * field, relation and sort key within what the caller reads unmasked — the collections it reads, their exposed fields
 * and relations, one-relation keys it reads unmasked. Anything else is `invalid`; nothing is dropped silently.
 */
export function decodeDescribed(cat: Catalog, a: Authority, collection: string, q: { where?: Json; orderBy?: Json }): void {
	const info = (c: string) => {
		const x = cat.collections.get(c);
		if (x === undefined || (!a.admin && (a.collections[c]?.read.length ?? 0) === 0)) throw refuse(`'${c}' is not read by this caller`);
		return x;
	};
	const field = (c: string, f: string) => {
		const base = f.split('.')[0]!;
		if (!exposedField(info(c), base) || (!a.admin && a.collections[c]?.masks[base] !== undefined)) throw refuse(`'${c}.${f}' is not a field this caller reads`);
	};
	const rel = (c: string, r: string) => {
		const x = info(c);
		if (!exposedRelation(x, r) || (x.model.one.has(r) && !a.admin && a.collections[c]?.masks[r] !== undefined)) throw refuse(`'${c}.${r}' is not a relation this caller reads`);
	};
	const walk = (p: Pred, c: string): void => {
		switch (p.t) {
			case 'const': return;
			// the search document and the embedding cover the collection's searched fields, not one field the caller reads
			case 'search': case 'similar': info(c); return;
			case 'and': case 'or': return p.of.forEach((x) => walk(x, c));
			case 'not': return walk(p.of, c);
			case 'one': case 'many': rel(c, p.rel); return walk(p.pred, p.target);
			case 'count': return rel(c, p.rel);
			case 'agg': rel(c, p.rel); return field(p.target, p.of);
			case 'cmp': field(c, p.field); if (typeof p.arg === 'object' && p.arg !== null && 'field' in p.arg) field(c, p.arg.field); return;
			default: return field(c, p.field);
		}
	};
	info(collection);
	if (q.where !== undefined) walk(ir.where(cat, collection, q.where), collection);
	// a related key (`assignee.name`): each hop a relation the caller reads, then the target's field
	if (q.orderBy !== undefined) for (const k of ir.order(q.orderBy, cat, collection)) {
		const steps = k.field.split('.');
		let c = collection;
		for (const s of steps.slice(0, -1)) { rel(c, s); c = cat.collections.get(c)!.model.one.get(s)!.targets[0]!; }
		field(c, steps.at(-1)!);
	}
}
