// AI filtering (rule 16a, P33, P34): the view popover's "Describe what to show…" text becomes a typed `Where` and at most
// one `OrderBy` key through System 1 alone (P37 shapes). System 1 only chooses among criteria, so the engine builds ONE
// catalogue of condition options per request from the collection's exposure narrowed to what the caller reads unmasked:
// fields of every filterable kind (many-valued fields included: has, has any, has all, is empty), operators per kind in
// the machine vocabulary the UI builder authors, values (enum and state names, the final-state set, relative date spans,
// me / my team / my party, relation candidates from a label search ≤ 5 per word), one and two relation hops, many-relation
// quantifiers with count and numeric child aggregates, and null tests where the field is optional. The catalogue is plain
// data (`FilterStep` paths + machine ops), shared with the browser: `filter.options` returns it so the builder renders the
// same list, and `instantiate` folds a path with the chosen operator the one way. A description asks a question per
// offered field — does it restrict by this field, with which of ITS operators and which of ITS values — plus one
// composition question (all / any / not all / none of the stated conditions) and the sort questions, so every answer is
// independent and ONE `sys_1` call suffices. (Asking per condition slot instead needs a second call: the operator and
// value questions must offer every field's options, so an answer can name one field's operator and another's value, which
// then has to be re-asked.) A collection wider than `FILTER_MAX_FIELDS` is asked about for the fields the description most
// plausibly names. Bounded: at most `FILTER_MAX_CONDITIONS` conditions, `FILTER_MAX_HOPS` relation hops, one top-level
// group. Bolt caps no option set: a request too large is the provider's refusal (`tooLarge`). The chosen options map 1:1
// onto the result, which is decoded like any read literal and AND-composed under the author's `where` and the caller's
// grants by the reader (so it only narrows). A System 1 failure or an answer that maps to no condition is a typed failure:
// nothing applies. No fallback (owner). Sorting is by an own sortable field or, one hop through an exposed one-relation, a
// target field the caller reads unmasked (`{ assignee: { name: 'asc' } }`, offered as "Assignee › Name");
// `decodeDescribed` holds a related key and every condition to the same exposure.
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
/** Fields asked about in the one request; past this the most plausible are asked and the rest are not offered at all. */
export const FILTER_MAX_FIELDS = 16;
export const FILTER_MAX_TEXT = 500;
/** A description answers within this: its candidate reads and its one `sys_1` call together. */
export const FILTER_DEADLINE_MS = 1_000;
/** Relation hops a condition path may take: the builder's own two-hop limit. */
export const FILTER_MAX_HOPS = 2;
/** A named child relation's options asked about before every other candidate has had a place. */
const PER_RELATION = 4;

const CANDIDATES = 5, WORDS = 8, NONE = '(no value)';
/** The collection's own search index as a condition path. */
const SEARCH: readonly FilterStep[] = [{ k: 'field', name: '$search' }];
/** The likeness at which a typed token matches a label's token. */
const MATCH = 0.5;
/** Phrases asked about, and the answer that reads a phrase as no condition. */
const MAX_SPANS = 4, NOTHING = 'nothing: it is not a condition';
/** How likely an offered value must be to stand in for "(no value)" on a field the description restricts. */
const CLOSE = 0.2;
/** The hedged yes at which a field whose likeliest value is evidence counts as restricted. */
const HEDGED = 0.3;
/** Words that negate a composition; without one, "none of them" / "not all of them" is System 1 misreading the text. */
const DISJUNCTION = /\b(or|nor|either|neither|any of|whichever)\b/i;
const NEGATION = /\b(not|no|without|except|excluding|neither|nor|none|never|isn['’]?t|aren['’]?t|other than|outside)\b/i;

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
/** A value offered for an operator: a literal, a list, a relative span (`during` → gte/lt) or an actor reference. */
export type FilterArg = { lit: Json } | { list: readonly Json[] } | { range: readonly [Json, Json] } | { actor: 'id' | 'party' | 'teams' }
	/** A one-relation's records whose text field holds a phrase (the description's words a found record holds). */
	| { match: { field: string; phrase: string } }
	/** Within `metres` of a point (a found record's own location). */
	| { near: readonly [{ lat: number; lng: number }, number] };
export type FilterValue = { label: string; arg: FilterArg };
/** One offered (field, operator) pair: a row the builder renders and an option System 1 may choose. Plain data. */
export type FilterOffer = {
	/** The question's own name for the field ("Assignee › Name", "Lines (any) › Qty", "Lines › count"). */
	label: string;
	/** How the condition nests from the root. */
	path: readonly FilterStep[];
	/** The machine operator. */
	op: string;
	/** The operator's words for this field ("is", "is within", "before", "has any of"). */
	opLabel: string;
	/** The literal's kind for the editor (`state` as `enum`, a list's element kind). */
	kind: string;
	values?: readonly FilterValue[];
	/** The field's `OrderBy` key where it may order the records. */
	sort?: string;
};
export type FilterCatalogue = readonly FilterOffer[];
/** A phrase of the description that data holds, and the conditions it can be read as: one choice question each. */
type Span = { phrase: string; options: { label: string; path: readonly FilterStep[]; cond: Json; from?: readonly FilterStep[]; near?: true }[] };
/** A nearest-first order from where a found record is: offered as a sort. */
type Near = { label: string; sort: string; near: { lat: number; lng: number } };
export type Described = { ok: true; where?: Json; orderBy?: Json } | { ok: false; code: string; message: string };
export type LocalFilterField = { name: string; label: string; kind: 'text' | 'number' | 'bool'; optional?: boolean };

type Op = { op: string; label: string };
/** One offered field: its operators and values. `path` is the serialisable replacement for the old `put` closure. */
type Field = { label: string; path: readonly FilterStep[]; kind: string; ops: readonly Op[]; values: FilterValue[]; sort?: string; hit?: boolean;
	/** The records a search on the description's words found, as evidence the description names this relation. */ found?: string[];
	/** Where the description's own words appear in those records ("“sunset vale” is in its Name"): the strongest evidence. */ holds?: string[];
	/** How strongly the description names the field: its words in the label, a row a search found, one of its own values. */ named?: number };

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
/** Whether a proximity word stands within three words before the phrase ("near", "close to", "around", "within 2 km of"). */
const proximate = (text: string, phrase: string) => {
	const t = tokens(text), first = phrase.split(' ')[0]!;
	const at = t.findIndex((x) => alike(x, first) >= MATCH);
	return at > 0 && t.slice(Math.max(0, at - 5), at).some((x) => /^(near|nearby|close|around|within|vicinity|beside|next|km|m)$/.test(x));
};
/** Words that ask for an order by distance rather than a radius. */
const SORTING = /\b(nearest|closest|furthest|farthest|by distance|distance from|sort|sorted|order|ordered)\b/i;
/** Whether a negating word stands within three words before the phrase's first word. */
const negated = (text: string, phrase: string) => {
	const t = tokens(text), first = phrase.split(' ')[0]!;
	const at = t.findIndex((x) => alike(x, first) >= MATCH);
	return at > 0 && t.slice(Math.max(0, at - 3), at).some((x) => NEGATION.test(x));
};
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
/** How closely a label holds the terms: the summed likeness of each term a token of it matches (other terms name other
 * fields, so they neither add nor dilute). */
const closeness = (ts: readonly string[], label: string) => {
	const ls = tokens(label);
	return ts.reduce((sum, t) => { const best = Math.max(0, ...ls.map((l) => alike(t, l))); return best >= MATCH ? sum + best : sum; }, 0);
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
	return [...new Set([...literals(text, 'en').strings, ...runs])].slice(0, MAX_SPANS);
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
	return ops.length === 0 ? undefined : { ops, values };
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
	// a relation's records NOT holding a phrase: the negated match ("jobs not at pine grove")
	if (arg !== undefined && 'match' in arg && op === 'ne') return { not: instantiate(path, operator('eq', arg)!) };
	const ops = operator(op, arg);
	return ops === undefined ? undefined : instantiate(path, ops);
}

export type FilterDescribeConfig = { manifest: EngineManifest; db: TenantDb; read: ReadEngine['run']; clock: () => string; ai?: AiPort; metering?: MeteringPort };

export function filterDescribe(cfg: FilterDescribeConfig) {
	const m = cfg.manifest, cat = catalogOf(m);
	/** Whether the caller reads collection `c` and its field `f` unmasked (rule 14): the narrowing of every option. */
	const reads = (a: Authority, c: string) => a.admin || (a.collections[c]?.read.length ?? 0) > 0;
	const unmasked = (a: Authority, c: string, f: string) => a.admin || a.collections[c]?.masks[f] === undefined;

	/** A collection's point fields the caller reads unmasked, with their labels. */
	const points = (a: Authority, c: string) => {
		const x = cat.collections.get(c);
		if (x === undefined || !reads(a, c)) return [];
		return [...x.model.fields.values()].filter((f) => f.kind === 'point' && !f.many && exposedField(x, f.name) && unmasked(a, c, f.name)
			&& (m.models[c]?.fields[f.name] as Spec | undefined)?.hidden !== true)
			.map((f) => ({ name: f.name, label: (m.models[c]?.fields[f.name] as Spec | undefined)?.label ?? human(f.name) }));
	};
	/** A collection's searched text fields: where a phrase the person typed can be found. */
	const texts = (c: string) => (cat.collections.get(c)?.model.search ?? []).filter((f) => cat.collections.get(c)?.model.fields.get(f)?.kind === 'text');
	/** The catalogue: the caller's exposed, readable, unmasked fields of a filterable kind as (field, operator) offers. */
	async function offer(collection: string, text: string, a: Authority, b: Bindings): Promise<{ fields: Field[]; spans: Span[]; nears: Near[] }> {
		const c = cat.collections.get(collection)!;
		const lit = literals(text, m.workspace.locale, b.today);
		const ws = words(text);
		const out: Field[] = [];
		const searches: { field: Field; target: string; label: string }[] = [];
		/** One model's own fields nested under `steps`. `prefix` labels them; `sortFrom` is the dot path they sort by
		 * (`undefined` past the builder's one relation hop); `hops` counts relation steps still offered. */
		const leaves = (target: string, steps: readonly FilterStep[], prefix: string, sortFrom: string | undefined, hops: number) => {
			const tc = cat.collections.get(target), tspec = m.models[target]?.fields ?? {};
			if (tc === undefined) return;
			for (const f of tc.model.fields.values()) {
				const s = tspec[f.name] as Spec | undefined;
				const system = target === collection && (f.name === 'created_at' || f.name === 'updated_at');
				if (f.name.includes('.') || (!system && s === undefined && !tc.model.one.has(f.name)) || s?.hidden || !exposedField(tc, f.name)) continue;
				if (!unmasked(a, target, f.name)) continue;
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
				// a relation is offered as a record condition only while a hop remains: past `FILTER_MAX_HOPS` it is not reached
				if (hops === 0 || !exposedRelation(tc, f.name)) continue;
				// the relation's record as a condition by its key, and (one arm per target of an exclusive arc)
				for (const arm of rel.targets.length > 1 ? rel.targets : [undefined]) {
					const at = arm ?? rel.targets[0]!;
					const optional = (m.relationships[`${target}.${f.name}`] as { optional?: true } | undefined)?.optional === true;
					const field: Field = { label: arm === undefined ? label : `${label} (${human(arm)})`, kind: 'record',
						path: [...steps, arm === undefined ? { k: 'field', name: f.name } : { k: 'arm', rel: f.name, arm }], ops: [], values: [] };
					const nul: Op[] = optional ? [{ op: 'isNull', label: 'is empty' }, { op: 'notNull', label: 'is not empty' }] : [];
					field.ops = [{ op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }, { op: 'in', label: 'is any of' }, { op: 'nin', label: 'is none of' }, ...nul];
					if (at === 'sys_user') field.values.push({ label: 'me', arg: { actor: 'id' } });
					if (at === 'sys_team') field.values.push({ label: 'my team', arg: { actor: 'teams' } });
					if (a.actor.kind === 'member' && a.actor.party?.collection === at) field.values.push({ label: 'my party', arg: { actor: 'party' } });
					const tl = [m.models[at]?.label ?? 'name'].flat()[0]!;
					if (arm === undefined && steps.length === 0 && cat.collections.get(at)?.model.fields.get(tl)?.kind === 'text' && reads(a, at) && unmasked(a, at, tl))
						searches.push({ field, target: at, label: tl });
					out.push(field);
					if (reads(a, at)) leaves(at, [...steps, arm === undefined ? { k: 'is', rel: f.name } : { k: 'arm', rel: f.name, arm }],
						`${field.label} › `, arm === undefined && steps.length === 0 ? f.name : undefined, hops - 1);
				}
			}
			// the target's search index and embedding: every word of a phrase (`$search`), or the nearest in meaning
			// (`$similar`), offered only to a caller who reads every field they cover unmasked (rule 14)
			const whole = (fs: readonly string[]) => fs.every((x) => exposedField(tc, x) && unmasked(a, target, x));
			const about = (label: string) => topics(text, [target, human(target), ...[...tc.model.fields.keys()].map(human), label]).map((x) => ({ label: x, arg: echoed(x) }));
			if (tc.model.search.length > 0 && whole(tc.model.search))
				out.push({ label: `${prefix}Search`, path: [...steps, { k: 'field', name: '$search' }], kind: 'search', ops: [{ op: 'search', label: 'has all the words' }], values: about(prefix) });
			if (tc.model.semantic !== undefined && whole(tc.model.semantic.fields))
				out.push({ label: `${prefix}Topic`, path: [...steps, { k: 'field', name: '$similar' }], kind: 'semantic', ops: [{ op: 'similar', label: 'is about' }], values: about(prefix) });
		};
		leaves(collection, [], '', '', FILTER_MAX_HOPS);
		for (const [r, rel] of c.model.many) {
			if (!exposedRelation(c, r) || !reads(a, rel.child) || rel.column.includes('__')) continue;
			const tc = cat.collections.get(rel.child), rl = human(r);
			if (tc === undefined) continue;
			for (const [q, word] of [['some', 'any'], ['every', 'all'], ['none', 'none']] as const)
				leaves(rel.child, [{ k: q, rel: r }], `${rl} (${word}) › `, undefined, 0);
			// its count, and numeric child aggregates: compared with the numbers in the text
			const values: FilterValue[] = lit.numbers.map((x) => ({ label: String(x), arg: echoed(x) }));
			const cmp: Op[] = [{ op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }, { op: 'gt', label: 'more than' }, { op: 'gte', label: 'at least' },
				{ op: 'lt', label: 'less than' }, { op: 'lte', label: 'at most' }];
			out.push({ label: `${rl} › count`, path: [{ k: 'count', rel: r }], kind: 'count', ops: cmp, values: [...values] });
			for (const f of tc.model.fields.values()) {
				const s = m.models[rel.child]?.fields[f.name] as Spec | undefined;
				if (s === undefined || s.hidden || f.many || !exposedField(tc, f.name) || !unmasked(a, rel.child, f.name)) continue;
				const words4 = [['total', 'sum'], ['average', 'avg'], ['lowest', 'min'], ['highest', 'max']] as const;
				for (const [word, fn] of words4) {
					const ok = fn === 'min' || fn === 'max'
						? ['int', 'decimal', 'money', 'sum', 'count', 'number', 'duration', 'date', 'instant'].includes(f.kind)
						: ['int', 'decimal', 'money', 'sum', 'count', 'number', 'duration'].includes(f.kind);
					if (!ok) continue;
					out.push({ label: `${rl} › ${word} ${(s.label ?? human(f.name)).toLowerCase()}`, path: [{ k: 'agg', rel: r, fn, of: f.name }], kind: f.kind,
						ops: [...cmp], values: [...values] });
				}
			}
		}
		// relation candidates, fuzzily: one pipelined batch of searches as the caller. A target that declares `search.text`
		// is read through its indexed search document (prefixes, romanised forms, consonant skeletons: typos and partial words
		// match, ranked); any other is searched by its label, term by term. The best ≤ 5 per relation are offered.
		const ts = terms(text);
		const lookups = searches.flatMap((s) => (cat.collections.get(s.target)?.model.search.length ?? 0) > 0
			? [{ s, q: ir.read(cat, s.target, { search: text, select: Object.fromEntries([s.label, ...texts(s.target), ...points(a, s.target).map((p) => p.name)].map((f) => [f, true])), limit: CANDIDATES }) }]
			: ts.map((w) => ({ s, q: ir.read(cat, s.target, { where: { [s.label]: { like: `%${esc(w)}%` } }, select: { [s.label]: true }, limit: CANDIDATES }) })));
		const searched = new Set<Field>();
		// the collection's own text fields, when it declares a search: which of them hold the description's words
		const own = out.filter((f) => f.path.length === 1 && f.kind === 'text');
		const self = text !== '' && c.model.search.length > 0 && own.length > 0
			? ir.read(cat, collection, { search: text, select: Object.fromEntries(own.map((f) => [(f.path[0] as { name: string }).name, true])), limit: CANDIDATES }) : undefined;
		const found: { phrase: string; option: Span['options'][number] }[] = [];
		const offered = (path: readonly FilterStep[]) => out.some((f) => JSON.stringify(f.path) === JSON.stringify(path));
		const nears: Near[] = [];
		// where a found record is, to read "near <it>": the collection's own points and, one hop, the relation's points
		const radius = metresOf(text);
		const within = radius >= 1000 ? `${radius / 1000} km` : `${radius} m`;
		const ownPoints = points(a, collection).map((p) => ({ label: p.label, path: [{ k: 'field', name: p.name }] as FilterStep[], sort: p.name }));
		if (lookups.length > 0 || self !== undefined) {
			const all = await cfg.read([...lookups.map((r) => r.q), ...(self === undefined ? [] : [self])], { as: 'caller', authority: a }, b);
			const answers = all.slice(0, lookups.length);
			if (self !== undefined) {
				const runs = topics(text, [collection, human(collection), ...out.map((f) => f.label)]);
				const rows = (all.at(-1) as { rows: readonly { readonly [k: string]: Json }[] }).rows;
				for (const f of own) {
					const name = (f.path[0] as { name: string }).name;
					const phrase = rows.map((r) => held(text, String(r[name] ?? ''), 1)).sort((l, r) => r.length - l.length)[0];
					if (phrase) found.push({ phrase, option: { label: `${f.label} contains “${phrase}”`, path: f.path, cond: condition(f.path, 'like', { lit: phrase })! } });
					// the same phrase over every searched field, typos and partial words included: the whole typed run around it
					// ("pmup room" around "room", which the index meets and a `contains` would not)
					if (phrase && offered(SEARCH) && c.model.search.includes(name)) {
						const run = runs.find((x) => phrase.split(' ').every((w) => x.split(' ').includes(w))) ?? phrase;
						found.push({ phrase: run, option: { label: `Search has all the words “${run}”`, path: SEARCH, cond: condition(SEARCH, 'search', { lit: run })! } });
					}
				}
			}
			const rows = new Map<(typeof searches)[number], Map<string, { readonly [k: string]: Json }>>();
			lookups.forEach(({ s }, i) => {
				const got = rows.get(s) ?? new Map<string, { readonly [k: string]: Json }>();
				for (const row of (answers[i] as { rows: readonly { readonly [k: string]: Json }[] }).rows) got.set(String(row['id']), row);
				rows.set(s, got);
			});
			for (const [s, got] of rows) {
				// the search's own rank first; a label search's rows by how closely they hold the terms
				const ranked = [...got].map(([id, row], i) => ({ id, row, label: String(row[s.label]), score: closeness(ts, String(row[s.label])), i }))
					.sort((l, r) => (cat.collections.get(s.target)!.model.search.length > 0 ? l.i - r.i : r.score - l.score)).slice(0, CANDIDATES);
				for (const { id, label } of ranked) {
					if (!s.field.values.some((v) => 'lit' in v.arg && v.arg.lit === id)) {
						let l = label, n = 2; while (s.field.values.some((v) => v.label === l)) l = `${label} (${n++})`;
						s.field.values.push({ label: l, arg: { lit: id } });
					}
					// the words that found this row came from the description, so the field is one it plausibly means
					searched.add(s.field);
					if (!(s.field.found ??= []).includes(label)) s.field.found.push(label);
				}
				// the words the person typed that a found record holds ("1f pine grove" in "1F Pine Grove #17-30", "bca
				// accessibility programme" in a client name), in the record's own spelling, as a value of the relation itself:
				// "Site · whose Name contains “1f pine grove”" reaches every site that matches, not only one record, and the one
				// question about the site carries all its evidence (asked as three fields, Site, Site › Name and Site › Address
				// split it and none reached the bar: staging, "installation work at hillview crescent")
				const rel = (s.field.path[0] as { name: string }).name;
				const relPoints = points(a, s.target).map((p) => ({ label: `${s.field.label} › ${p.label}`, path: [{ k: 'is', rel }, { k: 'field', name: p.name }] as FilterStep[], sort: `${rel}.${p.name}`, name: p.name }));
				/** Where a record is: its first point with a value. */
				const whereIs = (row: { readonly [k: string]: Json }) => relPoints.map((p) => row[p.name]).find((v): v is { lat: number; lng: number } =>
					typeof v === 'object' && v !== null && typeof (v as { lat?: unknown }).lat === 'number');
				for (const r of ranked.slice(0, 2)) {
					const pt = whereIs(r.row);
					if (pt === undefined) continue;
					for (const p of [...ownPoints, ...relPoints]) if (!nears.some((x) => x.label === `${p.label}, nearest to ${r.label}`))
						nears.push({ label: `${p.label}, nearest to ${r.label}`, sort: p.sort, near: pt });
				}
				for (const f of texts(s.target)) {
					// every reading a span can take: a single long word ("springside") too
					const flabel = (m.models[s.target]?.fields[f] as Spec | undefined)?.label ?? human(f);
					const spanned = ranked.map((r) => held(text, String(r.row[f] ?? ''), 1)).sort((l, r) => r.length - l.length)[0];
					if (spanned) {
						found.push({ phrase: spanned, option: { label: `${s.field.label} · whose ${flabel} contains “${spanned}”`, path: s.field.path, cond: condition(s.field.path, 'eq', { match: { field: f, phrase: spanned } })! } });
						const indexed: FilterStep[] = [{ k: 'is', rel }, ...SEARCH];
						if (offered(indexed)) found.push({ phrase: spanned, option: { label: `${s.field.label} · Search has all the words “${spanned}”`, path: indexed,
							cond: condition(indexed, 'search', { lit: spanned })!, from: s.field.path } });
						// the records whose own field holds the whole phrase, as themselves
						for (const r of ranked.filter((r) => held(spanned, String(r.row[f] ?? ''), 1).split(' ').length === spanned.split(' ').length).slice(0, 2)) {
							found.push({ phrase: spanned, option: { label: `${s.field.label} is ${r.label}`, path: s.field.path, cond: condition(s.field.path, 'eq', { lit: r.id })! } });
							// "near <it>": within the text's radius (1 km unless it says) of where the record is
							const pt = whereIs(r.row);
							if (pt !== undefined) for (const p of [...ownPoints, ...relPoints])
								found.push({ phrase: spanned, option: { label: `${p.label} within ${within} of ${r.label}`, path: p.path, cond: condition(p.path, 'near', { near: [pt, radius] })!, from: s.field.path, near: true } });
						}
					}
					const phrase = ranked.map((r) => held(text, String(r.row[f] ?? ''))).sort((l, r) => r.length - l.length)[0];
					if (phrase === undefined || phrase === '') continue;
					const label = `whose ${(m.models[s.target]?.fields[f] as Spec | undefined)?.label ?? human(f)} contains “${phrase}”`;
					if (s.field.values.some((v) => v.label === label)) continue;
					s.field.values.push({ label, arg: { match: { field: f, phrase } } });
					(s.field.holds ??= []).push(`“${phrase}” is in its ${(m.models[s.target]?.fields[f] as Spec | undefined)?.label ?? human(f)}`);
				}
			}
		}
		// A field the description names, by its label, by a row a search on its words found, or by one of its OWN values
		// appearing in the text. A value the words contributed is not evidence — a text field is handed the description's
		// words as its options, so matching one would call every text field a hit and rank the collection by its schema.
		// A word names a label token in another inflection too: `log` → `logs`, `suspicion` → `suspicious` (a shared stem of
		// five letters, or one word the other's prefix). A number in the text is a value of every numeric field, so it marks
		// them all as candidates but names none of them: `named` counts only the label's words, a search hit and a value
		// that is not a number, and ranks the fields a wide collection is asked about.
		const said = text.toLowerCase();
		const akin = (w: string, x: string) => w.startsWith(x) || x.startsWith(w) || [...w].findIndex((ch, i) => ch !== x[i]) >= 5;
		for (const f of out) {
			const tokens = f.label.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2);
			// a search or a meaning is offered the description's own phrases: holding one names nothing
			const valued = f.kind === 'search' || f.kind === 'semantic' ? [] : f.values.filter((v) => !ws.includes(v.label) && said.includes(v.label.toLowerCase()));
			// a value copied from the description is an echo, never evidence; one the engine or the schema declares (a state,
			// a choice, `this week`) that the text says names the field
			const declared = f.values.some((v) => !ECHOES.has(v.arg) && new RegExp(`\\b${v.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(said));
			f.named = ws.filter((w) => tokens.some((x) => akin(w, x))).length + (searched.has(f) ? 1 : 0) + (declared ? 1 : 0);
			f.hit = f.named > 0 || valued.length > 0;
		}
		// spans: a phrase and every reading of it; a phrase inside a longer one folds into it ("pine grove" into "1f pine grove")
		const spans: Span[] = [];
		for (const { phrase, option } of found.sort((l, r) => r.phrase.split(' ').length - l.phrase.split(' ').length)) {
			const words = phrase.split(' ');
			const into = spans.find((x) => words.every((w) => x.phrase.split(' ').includes(w)));
			const span = into ?? (spans.length < MAX_SPANS ? (spans.push({ phrase, options: [] }), spans.at(-1)!) : undefined);
			if (span !== undefined && !span.options.some((x) => x.label === option.label) && span.options.length < 12) span.options.push(option);
		}
		return { fields: out, spans, nears };
	}
	/** The catalogue as plain data for the browser, without the description's text-derived values. */
	const catalogue = (fields: readonly Field[]): FilterCatalogue => fields.flatMap((f) => f.ops.map((o) => ({ label: f.label, path: f.path, op: o.op, opLabel: o.label, kind: f.kind,
		...(f.values.length === 0 ? {} : { values: f.values }), ...(f.sort === undefined ? {} : { sort: f.sort }) })));
	/** The local view's own fields (`$local`): text, number and bool only, and no relation. */
	const localFields = (fs: readonly LocalFilterField[], text: string): Field[] => fs.map((f) => ({ label: f.label, path: [{ k: 'field' as const, name: f.name }], kind: f.kind,
		...options({ kind: f.kind }, f.optional ? { optional: true } : undefined, literals(text, m.workspace.locale), words(text), m.workspace.tz)!, sort: f.name }));
	/** The collection a caller may describe or see options on; a `$local` view carries its own fields. */
	const subject = (o: { collection: string; authority: Authority; localFields?: readonly LocalFilterField[] }, text: string): { fields?: Field[]; fail?: { ok: false; code: string; message: string } } => {
		const local = o.collection === '$local';
		if (!local && (!cat.collections.has(o.collection) || (!o.authority.admin && (o.authority.collections[o.collection]?.read.length ?? 0) === 0)))
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
	/** The value chosen for a field System 1 said the description restricts: "(no value)" contradicts that yes, so the likeliest
	 * offered value wins when it is close (staging: Site 0.80 yes, value 0.51 none against 0.49 "3 Ridgewood Close"). */
	const valueOf = (r: DecisionResult, id: string) => {
		const a = r.answers[id];
		if (a?.type !== 'choice' || a.choice !== NONE) return choiceOf(r, id);
		const [best, p] = Object.entries(a.probabilities).filter(([k]) => k !== NONE).sort((l, r) => r[1] - l[1])[0] ?? [];
		return best !== undefined && p! >= CLOSE ? best : NONE;
	};
	/** The likeliest offered value that is evidence rather than an echo of the description's words, when it reaches CLOSE. */
	const bestValue = (r: DecisionResult, id: string, q: { vals: Map<string, FilterArg> }) => {
		const a = r.answers[id];
		if (a?.type !== 'choice') return undefined;
		const [best, p] = Object.entries(a.probabilities).filter(([k]) => k !== NONE && q.vals.has(k) && !ECHOES.has(q.vals.get(k)!)).sort((l, r) => r[1] - l[1])[0] ?? [];
		return best !== undefined && p! >= CLOSE ? best : undefined;
	};
	/** How the stated conditions combine: the one composition question, bounded to one top-level group. */
	const COMBINE: { readonly [c: string]: { join: 'and' | 'or'; not: boolean; because: string } } = {
		'all of them hold': { join: 'and', not: false, because: 'every stated condition holds' },
		'any of them hold': { join: 'or', not: false, because: 'at least one stated condition holds' },
		'not all of them hold': { join: 'and', not: true, because: 'not every stated condition holds' },
		'none of them hold': { join: 'or', not: true, because: 'no stated condition holds' },
	};
	const ALL = COMBINE['all of them hold']!;

	/** `filter.describe` as the caller: `{ collection, text }` → a decoded `Where` and optional `OrderBy`, or a typed failure. */
	async function describe(o: { collection: string; text: string; authority: Authority; bindings: Bindings; localFields?: readonly LocalFilterField[] }): Promise<Described> {
		const fail = (message: string): Described => ({ ok: false, code: 'invalid', message });
		if (o.text.trim() === '' || o.text.length > FILTER_MAX_TEXT) return fail(`A description is 1–${FILTER_MAX_TEXT} characters.`);
		if (cfg.ai === undefined) return { ok: false, code: 'notFound', message: 'Describing a filter is not available here.' };
		const started = performance.now();
		const subjectOf = subject(o, o.text);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const local = o.collection === '$local';
		const { fields, spans, nears } = subjectOf.fields !== undefined ? { fields: subjectOf.fields, spans: [] as Span[], nears: [] as Near[] } : await offer(o.collection, o.text, o.authority, o.bindings);
		if (fields.length === 0) return fail('Nothing here can be filtered by a description.');
		const qual = (f: Field, x: string) => `${f.label} · ${x}`;
		/** A choice's criteria: each option names itself (the provider reads option → description). */
		const own = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, k]));
		// one field's own operators and values, so an answer can only ever name that field: the request asks what to do
		// with a field, never which field, and so carries no answer the next question depends on
		const forField = (f: Field) => ({ ops: new Map(f.ops.map((x) => [qual(f, x.label), x])), vals: new Map(f.values.map((v) => [qual(f, v.label), v.arg])) });
		// the provider's cap per choice question (the Decisions API: 255)
		const max = cfg.ai?.sys_1.maxChoices ?? Infinity;
		// nearest-first orders from found records first: "nearest to 1f pine grove" names one of them
		const sortable: { label: string; sort?: string; near?: Near['near'] }[] = [...nears, ...fields.filter((f) => f.sort !== undefined)];
		const DIRS = { asc: 'ascending (oldest, lowest, A→Z first)', desc: 'descending (newest, highest, Z→A first)' };
		// the fields the description most plausibly means, asked about in that order: a wide collection keeps the ones a
		// person actually wrote of rather than the first twelve the schema happens to declare
		const ranked = fields
			.map((f, i) => ({ f, i }))
			.sort((l, r) => (r.f.named ?? 0) - (l.f.named ?? 0) || Number(r.f.hit ?? false) - Number(l.f.hit ?? false)
				// among fields named equally, the shallower path: a count before every child field under any / all / none
				|| l.f.path.length - r.f.path.length || l.i - r.i);
		// one child relation named by the description offers its count, aggregates and every field under any / all / none:
		// past its first few, the rest wait behind the other candidates, so a second condition ("done", a date) still fits
		const seen = new Map<string, number>();
		const crowded = new Set(ranked.filter(({ f }) => {
			const step = f.path.find((p) => p.k === 'some' || p.k === 'every' || p.k === 'none' || p.k === 'count' || p.k === 'agg');
			const rel = step !== undefined && 'rel' in step ? step.rel : undefined;
			if (rel === undefined || !f.hit) return false;
			seen.set(rel, (seen.get(rel) ?? 0) + 1);
			return seen.get(rel)! > PER_RELATION;
		}));
		// the collection's own search index and meaning are always asked: no field label names them
		const index = ranked.filter((x) => x.f.path.length === 1 && (x.f.kind === 'search' || x.f.kind === 'semantic') && x.f.values.length > 0);
		const rest = ranked.filter((x) => !index.includes(x));
		const asked = [...rest.filter((x) => x.f.hit && !crowded.has(x)), ...index, ...rest.filter((x) => crowded.has(x)), ...rest.filter((x) => !x.f.hit)]
			.slice(0, FILTER_MAX_FIELDS);
		const state = { description: o.text, collection: human(o.collection), fields: asked.map(({ f }) => ({ label: f.label, kind: f.kind })),
			today: o.bindings.today, timezone: o.bindings.tz, weekStartsOn: 'Monday' };
		const first: { [id: string]: DecisionQuestion } = {};
		const choices2 = new Map<Field, ReturnType<typeof forField>>();
		for (const [n, { f }] of asked.entries()) {
			const q = forField(f);
			choices2.set(f, q);
			Object.assign(first, {
				[`f${n + 1}`]: f.ops.every((x) => x.op === 'isNull' || x.op === 'notNull')
					// a field only ever tested for presence (a point, a file): naming it is not asking whether it is set
					? { type: 'noul', instructions: `Does the description ask whether ${f.label} is recorded at all (empty or not empty)?`,
						criteria: { true: `it asks for records with or without a ${f.label}`, false: `it does not ask whether ${f.label} is recorded` } }
					: { type: 'noul', instructions: `Does the description restrict the records by ${f.label}?${f.holds !== undefined ? ` The description's words name ${f.label} records: ${f.holds.join('; ')}.`
						: f.found === undefined ? '' : ` Its words match these ${f.label} records: ${f.found.join('; ')}.`}`,
						criteria: { true: `it states a condition on ${f.label}`, false: `it states no condition on ${f.label}` } },
				[`f${n + 1}.op`]: { type: 'choice', instructions: `Which comparison does the condition on ${f.label} use?`, criteria: own([...q.ops.keys()]) },
				[`f${n + 1}.value`]: { type: 'choice', instructions: `Which value does the condition on ${f.label} compare with?`, criteria: own([NONE, ...q.vals.keys()]) } });
			// a question with one answer is not asked: the request is smaller, and the call faster
			if (q.ops.size === 1) delete first[`f${n + 1}.op`];
			if (q.vals.size === 0) delete first[`f${n + 1}.value`];
		}
		// each phrase the data holds: which reading it is — a choice among concrete conditions, which System 1 answers far more
		// surely than whether a field is restricted at all (staging: "sunset vale" scored Site 0.28 as a field)
		// A phrase of two or more words that a record holds is a condition: offered "nothing", System 1 took it for a bare place
		// name ("sunset vale" 0.77 nothing, "bca accessibility programme" 0.91) though the data holds it. A single word may be
		// incidental ("work"), so it keeps the choice of none.
		// "nearest to <place>", "by distance from <place>": the place is the order's anchor, not a condition — its span and its
		// relation's own question stand down, and the sort question offers "nearest to <it>"
		const anchors = SORTING.test(o.text) ? spans.filter((sp) => sp.options.some((x) => x.near)) : [];
		const standing = new Set(anchors.flatMap((sp) => sp.options.map((x) => JSON.stringify(x.from ?? x.path))));
		spans.splice(0, spans.length, ...spans.filter((sp) => !anchors.includes(sp)));
		// "near <place>", "within 2 km of <place>": a proximity word before the phrase leaves only its distance readings
		for (const sp of spans) if (proximate(o.text, sp.phrase) && sp.options.some((x) => x.near)) sp.options = sp.options.filter((x) => x.near);
		spans.forEach((sp, i) => Object.assign(first, { [`span${i + 1}`]: sp.options.length === 1 ? undefined : { type: 'choice', instructions: `What does “${sp.phrase}” in the description filter by?`,
			criteria: { ...own(sp.options.map((x) => x.label)), ...(sp.phrase.includes(' ') ? {} : { [NOTHING]: `“${sp.phrase}” names nothing to filter by` }) } } }));
		for (const k of Object.keys(first)) if (first[k] === undefined) delete first[k];
		// the composition of every stated condition: bounded to one top-level AND, OR or their negations
		Object.assign(first, { combine: { type: 'choice', instructions: 'How do the stated conditions combine?',
			criteria: Object.fromEntries(Object.entries(COMBINE).map(([k, v]) => [k, v.because])) } });
		if (sortable.length > 0) Object.assign(first, {
			'sort.yes': { type: 'noul', instructions: 'Does the description ask for an order?', criteria: { true: 'it asks for an order', false: 'it asks for no order' } },
			'sort.field': { type: 'choice', instructions: 'Which field orders the records?', criteria: own(sortable.slice(0, max).map((f) => f.label)) },
			'sort.dir': { type: 'choice', instructions: 'Which direction?', criteria: { [DIRS.asc]: 'smallest or earliest first', [DIRS.desc]: 'largest or latest first' } } });
		// Admission is semantic, not a keyword guard: an explicit current flag or a related aggregate
		// can express a selection that otherwise needs unsupported comparisons across root records.
		first['selection.unsupported'] = {
			type: 'noul',
			instructions: 'Does satisfying the requested selection require comparing top-level records with other top-level records, selecting a ranked subset or a maximum/minimum per group, or limiting the record count, rather than testing the offered field and relation conditions? A descending sort changes order only; it does not select latest-only or one record per group. Answer false when an exposed current/latest flag or an offered related aggregate directly represents the requested selection.',
			criteria: {
				true: 'the requested selection requires unsupported cross-record comparisons or ranking',
				false: 'the requested selection is represented by the offered conditions and ordering'
			}
		};
		// what is left of the deadline after the candidate reads
		const r1 = await call(state, first, Math.max(1, Math.round(FILTER_DEADLINE_MS - (performance.now() - started))));
		if ('ok' in r1) return r1;
		if (noulOf(r1, 'selection.unsupported') > 0.5)
			return { ok: false, code: 'invalid', message: 'This selection requires comparing or ranking records across groups, which the available filters cannot express. Choose a field condition or sort instead.' };
		const conds: Json[] = [];
		const unbuilt: Field[] = [];
		// the spans' readings first; a field one already decided, or an echoed word one already used, is not asked again
		const decided = new Set<string>(standing), used = new Set<string>();
		spans.forEach((sp, i) => {
			// a single word System 1 leaves at "nothing" while a reading of it reaches CLOSE takes that reading, as a field does
			const a = r1.answers[`span${i + 1}`];
			const best = a?.type === 'choice' ? Object.entries(a.probabilities).filter(([k]) => k !== NOTHING).sort((l, r) => r[1] - l[1])[0] : undefined;
			// (five letters or more: "work" in "installation work" is incidental)
			const label = a?.type === 'choice' && a.choice === NOTHING && best !== undefined && best[1] >= CLOSE && sp.phrase.length >= 5 ? best[0] : choiceOf(r1, `span${i + 1}`);
			// a lone reading (a proximity word left one) needs no question
			const pick = sp.options.length === 1 && sp.phrase.includes(' ') ? sp.options[0] : sp.options.find((x) => x.label === label);
			// a single word that names a field ("site" in "site location contains …") is that field, not a value of another
			if (pick === undefined || (!sp.phrase.includes(' ') && asked.some(({ f: g }) => tokens(g.label).includes(sp.phrase)))) return;
			// "jobs not at pine grove": a negating word just before the phrase negates its reading
			conds.push(negated(o.text, sp.phrase) ? { not: pick.cond } : pick.cond);
			decided.add(JSON.stringify(pick.path));
			// the relation whose records the phrase came from is read: its own question stands down ("within 3 km of 1f pine
			// grove" also became Site is 1F Pine Grove)
			for (const x of sp.options) decided.add(JSON.stringify(x.from ?? x.path));
			for (const w of sp.phrase.split(' ')) used.add(w);
		});
		const built: { path: readonly FilterStep[]; echo: boolean; c: Json }[] = [];
		for (const [n, { f }] of asked.entries()) {
			if (decided.has(JSON.stringify(f.path))) continue;
			// System 1 hedges a field it is unsure the text restricts (0.3–0.5 on "sunset vale" → Site) while still naming the
			// right value: past 0.5 the field is restricted; from HEDGED it is when its likeliest value is evidence (a found
			// record, a phrase a record holds, a declared value) at CLOSE or more — never a word merely echoed from the text
			const yes = noulOf(r1, `f${n + 1}`);
			const best = bestValue(r1, `f${n + 1}.value`, choices2.get(f)!);
			if (yes <= 0.5 && !(yes >= HEDGED && best !== undefined)) continue;
			// the engine has already refused an answer outside the offered criteria, so these are present; the fallbacks only
			// satisfy the type, and an unbuildable pair fails the filter below rather than being dropped
			const q = choices2.get(f)!;
			const op = q.ops.size === 1 ? [...q.ops.values()][0] : q.ops.get(choiceOf(r1, `f${n + 1}.op`) ?? ''), arg = q.vals.get(valueOf(r1, `f${n + 1}.value`) ?? '');
			// an echoed word a phrase already used ("pine" beside "1f pine grove"), or one that names a field ("site"), is no value
			if (arg !== undefined && ECHOES.has(arg) && 'lit' in arg && ([...used].some((w) => alike(w, String(arg.lit).toLowerCase()) >= MATCH)
				|| (/^\p{L}{3,}$/u.test(String(arg.lit)) && asked.some(({ f: g }) => tokens(g.label).includes(String(arg.lit).toLowerCase()))))) continue;
			// a phrase a span already read is not read again as another field ("site location contains 1f pine grove" became
			// both Location address and Site › Name contains it)
			if (arg !== undefined && 'match' in arg && arg.match.phrase.split(' ').every((w) => used.has(w))) continue;
			if (arg !== undefined && 'match' in arg) for (const w of arg.match.phrase.split(' ')) used.add(w);
			const c = condition(f.path, op?.op ?? '', arg);
			// a field System 1 flagged but gave no value for is noise beside the conditions it did build (staging: "some place
			// with 1f pine grove" picked the site and a valueless Description, and the Description failed the whole filter)
			if (c === undefined) { unbuilt.push(f); continue; }
			built.push({ path: f.path, echo: arg !== undefined && ECHOES.has(arg), c });
			if (conds.length + built.length >= FILTER_MAX_CONDITIONS) break;
		}
		// a relation already pinned to a record or a phrase its records hold takes no echoed word under it ("bbo tan" found
		// Bob Tan; "Assignee › Name is tan" beside it emptied the result)
		const pinned = new Set([...[...decided].map((x) => JSON.parse(x) as FilterStep[]), ...built.filter((x) => !x.echo).map((x) => x.path)]
			.flatMap((p) => p.length === 1 && p[0]!.k === 'field' ? [p[0]!.name] : []));
		for (const x of built) if (!(x.echo && x.path[0]?.k === 'is' && pinned.has(x.path[0].rel))) conds.push(x.c);
		// "nearest to <place>" states its order: the chosen nearest sort, else the first from that place's records
		const chosenSort = sortable.find((f) => f.label === choiceOf(r1, 'sort.field'));
		const anchored = anchors.length === 0 ? undefined : chosenSort?.near !== undefined ? chosenSort
			: nears.find((n) => anchors.some((sp) => n.label.toLowerCase().includes(sp.phrase.split(' ')[0]!)));
		const sortField = anchored ?? (sortable.length > 0 && noulOf(r1, 'sort.yes') > 0.5 ? chosenSort : undefined);
		// only unbuildable conditions: a relation whose words match several records says which, so the person can pick one
		const vague = unbuilt.find((f) => (f.found?.length ?? 0) > 1);
		if (conds.length === 0 && sortField === undefined)
			return fail(unbuilt.length > 0
				? (vague === undefined ? `Could not build a condition on ${unbuilt[0]!.label}.` : `Several ${vague.label} records match: ${vague.found!.slice(0, CANDIDATES).join('; ')}. Name one.`)
				: 'No field here matches that description. Try naming a field and a value.');
		const chosen = COMBINE[choiceOf(r1, 'combine') ?? ''] ?? ALL;
		// a negation the text never states is a misreading (staging: "1f pine grove" → none of them hold)
		// likewise an OR the text never states ("installation work at hillview crescent" → any of them)
		const joined = chosen.join === 'or' && !DISJUNCTION.test(o.text) ? 'and' : chosen.join;
		const combine = { ...chosen, join: joined, not: chosen.not && NEGATION.test(o.text) };
		// an empty conjunction is not a filter: a sort-only description has no `where` (an empty `and` fails decode)
		const group = conds.length === 0 ? undefined : conds.length === 1 ? conds[0]! : { [combine.join]: conds };
		// one condition negates through its own operator ("is not"): a negated composition of one is System 1 misreading
		// "jobs at 1F Pine Grove" as "none of them hold"
		const where: Json | undefined = group === undefined ? undefined : combine.not && conds.length > 1 ? { not: group } : group;
		const dir: Json = choiceOf(r1, 'sort.dir') === DIRS.asc ? 'asc' : 'desc';
		const orderBy: Json | undefined = sortField === undefined ? undefined
			: sortField.sort!.split('.').reduceRight<Json>((v, k) => ({ [k]: v }), sortField.near === undefined ? dir : { near: sortField.near });
		try { // rule 11a: the same strict decode as any read literal, held to the caller's exposure
			if (!local) decodeDescribed(cat, o.authority, o.collection, { ...(where === undefined ? {} : { where }), ...(orderBy === undefined ? {} : { orderBy }) });
		} catch (e) {
			return fail(e instanceof BoltError ? e.message : 'Could not build a filter from that description.');
		}
		return { ok: true, ...(where === undefined ? {} : { where }), ...(orderBy === undefined ? {} : { orderBy }) };
	}
	/** `filter.options` as the caller: the same catalogue the description is asked about, as plain data for the builder. */
	async function opts(o: { collection: string; authority: Authority; bindings: Bindings; localFields?: readonly LocalFilterField[] }): Promise<{ ok: true; fields: FilterCatalogue } | { ok: false; code: string; message: string }> {
		const subjectOf = subject(o, '');
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const fields = subjectOf.fields ?? (await offer(o.collection, '', o.authority, o.bindings)).fields;
		return { ok: true, fields: catalogue(fields) };
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
