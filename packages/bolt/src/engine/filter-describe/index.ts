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
import { exposedField, exposedRelation, type Catalog, type FieldInfo } from '../../protocol/catalog.ts';
import * as ir from '../../protocol/ir.ts';

/** The stated conditions a description may produce. */
export const FILTER_MAX_CONDITIONS = 4;
/** Fields asked about in the one request; past this the most plausible are asked and the rest are not offered at all. */
export const FILTER_MAX_FIELDS = 16;
export const FILTER_MAX_TEXT = 500;
/** Relation hops a condition path may take: the builder's own two-hop limit. */
export const FILTER_MAX_HOPS = 2;

const CANDIDATES = 5, WORDS = 8, NONE = '(no value)';

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
export type FilterArg = { lit: Json } | { list: readonly Json[] } | { range: readonly [Json, Json] } | { actor: 'id' | 'party' | 'teams' };
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
export type Described = { ok: true; where: Json; orderBy?: Json } | { ok: false; code: string; message: string };
export type LocalFilterField = { name: string; label: string; kind: 'text' | 'number' | 'bool'; optional?: boolean };

type Op = { op: string; label: string };
/** One offered field: its operators and values. `path` is the serialisable replacement for the old `put` closure. */
type Field = { label: string; path: readonly FilterStep[]; kind: string; ops: readonly Op[]; values: FilterValue[]; sort?: string; hit?: boolean };

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
/** Quoted strings, numbers and dates (ISO, or day-first `d/m/yyyy`; month-first in `en-US`) from the text. */
export function literals(text: string, locale: string): { strings: string[]; numbers: number[]; dates: string[] } {
	const dates: string[] = [];
	const rest = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (d) => (dates.push(d), ' ')).replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, a: string, b: string, y: string) => {
		const [m, d] = locale === 'en-US' ? [a, b] : [b, a];
		dates.push(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
		return ' ';
	});
	return { dates, strings: [...rest.matchAll(/(?:^|\s)["“']([^"”']+)["”']/g)].map((x) => x[1]!.trim()),
		numbers: [...rest.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((x) => Number(x[0])) };
}
const words = (text: string) => [...new Set((text.toLowerCase().replace(/'s\b/g, '').match(/\p{L}{3,}/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, WORDS);
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The operators and values a field is offered with, or `undefined` when no option can express it. */
function options(f: Pick<FieldInfo, 'kind' | 'many' | 'periodOf'>, s: Spec | undefined, lit: ReturnType<typeof literals>, ws: readonly string[]): { ops: Op[]; values: FilterValue[] } | undefined {
	const values: FilterValue[] = [];
	const add = (label: string, arg: FilterArg) => { let l = label, n = 2; while (values.some((v) => v.label === l)) l = `${label} (${n++})`; values.push({ label: l, arg }); };
	const op = (name: string, label: string): Op => ({ op: name, label });
	const k = f.kind;
	let ops: Op[];
	if (f.many) {
		// any list field: has one / any / all of the element kind, or is empty (a list is never null-tested)
		if (k === 'enum') for (const v of s?.values ?? []) add(v, { lit: v });
		else if (k === 'text') for (const x of [...lit.strings, ...ws]) add(x, { lit: x });
		else if (NUMERIC.has(k)) for (const x of lit.numbers) add(String(x), { lit: x });
		else if (k === 'date') for (const d of lit.dates) add(d, { lit: d });
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
		for (const x of [...lit.strings, ...ws]) add(x, { lit: x });
	} else if (NUMERIC.has(k)) {
		ops = [op('eq', 'is'), op('ne', 'is not'), op('gt', 'more than'), op('gte', 'at least'), op('lt', 'less than'), op('lte', 'at most'),
			op('in', 'is any of'), op('nin', 'is none of')];
		for (const x of lit.numbers) add(String(x), { lit: x });
	} else if (k === 'date' || k === 'instant' || k === 'time') {
		const when = k !== 'time';
		ops = [...(when ? [op('during', 'is within')] : []), op('eq', 'is'), op('ne', 'is not'), op('gt', when ? 'after' : 'more than'), op('gte', when ? 'on or after' : 'at least'),
			op('lt', when ? 'before' : 'less than'), op('lte', when ? 'on or before' : 'at most')];
		if (when) for (const v of spans(k)) add(v.label, v.arg);
		if (k === 'date') for (const d of lit.dates) add(d, { lit: d });
	} else if (k === 'period' && f.periodOf === 'date') {
		// a date period (an employment's effective_range): in force on a day, or overlapping / inside a span
		ops = [op('contains', 'in force on'), op('overlaps', 'overlaps'), op('within', 'is within')];
		add('today', { lit: { today: '' } });
		for (const v of spans('date')) add(v.label, v.arg);
		for (const d of lit.dates) add(d, { lit: d });
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
	if (op === 'isNull') return { isNull: true };
	if (op === 'notNull') return { isNull: false };
	if (op === 'isEmpty') return { isEmpty: true };
	if (op === 'notEmpty') return { isEmpty: false };
	if (arg === undefined) return undefined;
	if ('actor' in arg) {
		if (op === 'eq' || op === 'ne') return { [op]: { actor: arg.actor } };
		// a list operand from an actor is `my teams` alone (ir's list `{ actor }`)
		if ((op === 'in' || op === 'nin') && arg.actor === 'teams') return { [op]: { actor: arg.actor } };
		return undefined;
	}
	if ('range' in arg) {
		const [lo, hi] = arg.range;
		if (op === 'during') return { gte: lo, lt: hi };
		if (op === 'overlaps' || op === 'within') return { [op]: { from: lo, to: hi } };
		if (op === 'lt') return { lt: lo };
		if (op === 'lte') return { lte: hi };
		if (op === 'gt') return { gt: lo };
		if (op === 'gte') return { gte: lo };
		return undefined;
	}
	if ('list' in arg) {
		if (op === 'in' || op === 'nin' || op === 'hasAny' || op === 'hasAll') return { [op]: arg.list };
		return undefined;
	}
	if (op === 'like') return typeof arg.lit === 'string' ? { like: `%${esc(arg.lit)}%` } : undefined;
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
	const ops = operator(op, arg);
	return ops === undefined ? undefined : instantiate(path, ops);
}

export type FilterDescribeConfig = { manifest: EngineManifest; db: TenantDb; read: ReadEngine['run']; clock: () => string; ai?: AiPort; metering?: MeteringPort };

export function filterDescribe(cfg: FilterDescribeConfig) {
	const m = cfg.manifest, cat = catalogOf(m);
	/** Whether the caller reads collection `c` and its field `f` unmasked (rule 14): the narrowing of every option. */
	const reads = (a: Authority, c: string) => a.admin || (a.collections[c]?.read.length ?? 0) > 0;
	const unmasked = (a: Authority, c: string, f: string) => a.admin || a.collections[c]?.masks[f] === undefined;

	/** The catalogue: the caller's exposed, readable, unmasked fields of a filterable kind as (field, operator) offers. */
	async function offer(collection: string, text: string, a: Authority, b: Bindings): Promise<Field[]> {
		const c = cat.collections.get(collection)!;
		const lit = literals(text, m.workspace.locale);
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
				const label = prefix + (system ? (f.name === 'created_at' ? 'Created' : 'Updated') : s?.label ?? human(f.name));
				const rel = tc.model.one.get(f.name);
				if (rel === undefined) {
					const o = options(f, s, lit, ws);
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
		};
		leaves(collection, [], '', '', FILTER_MAX_HOPS);
		for (const [r, rel] of c.model.many) {
			if (!exposedRelation(c, r) || !reads(a, rel.child) || rel.column.includes('__')) continue;
			const tc = cat.collections.get(rel.child), rl = human(r);
			if (tc === undefined) continue;
			for (const [q, word] of [['some', 'any'], ['every', 'all'], ['none', 'none']] as const)
				leaves(rel.child, [{ k: q, rel: r }], `${rl} (${word}) › `, undefined, 0);
			// its count, and numeric child aggregates: compared with the numbers in the text
			const values: FilterValue[] = lit.numbers.map((x) => ({ label: String(x), arg: { lit: x } }));
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
		// relation candidates: one batch of label searches as the caller, ≤ 5 rows per word
		const lookups = searches.flatMap((s) => ws.map((w) => ({ s, q: ir.read(cat, s.target, { where: { [s.label]: { like: `%${esc(w)}%` } }, select: { [s.label]: true }, limit: CANDIDATES }) })));
		const searched = new Set<Field>();
		if (lookups.length > 0) {
			const answers = await cfg.read(lookups.map((r) => r.q), { as: 'caller', authority: a }, b);
			lookups.forEach(({ s }, i) => {
				for (const row of (answers[i] as { rows: readonly { readonly [k: string]: Json }[] }).rows) {
					const label = String(row[s.label]);
					if (!s.field.values.some((v) => 'lit' in v.arg && v.arg.lit === row['id'])) {
						let l = label, n = 2; while (s.field.values.some((v) => v.label === l)) l = `${label} (${n++})`;
						s.field.values.push({ label: l, arg: { lit: row['id']! } });
					}
					// the word that found this row came from the description, so the field is one it plausibly means
					searched.add(s.field);
				}
			});
		}
		// A field the description names, by its label, by a row a search on its words found, or by one of its OWN values
		// appearing in the text. A value the words contributed is not evidence — a text field is handed the description's
		// words as its options, so matching one would call every text field a hit and rank the collection by its schema.
		const said = text.toLowerCase();
		for (const f of out) {
			const tokens = f.label.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2);
			f.hit = searched.has(f) || tokens.some((x) => ws.includes(x)) || f.values.some((v) => !ws.includes(v.label) && said.includes(v.label.toLowerCase()));
		}
		return out;
	}
	/** The catalogue as plain data for the browser, without the description's text-derived values. */
	const catalogue = (fields: readonly Field[]): FilterCatalogue => fields.flatMap((f) => f.ops.map((o) => ({ label: f.label, path: f.path, op: o.op, opLabel: o.label, kind: f.kind,
		...(f.values.length === 0 ? {} : { values: f.values }), ...(f.sort === undefined ? {} : { sort: f.sort }) })));
	/** The local view's own fields (`$local`): text, number and bool only, and no relation. */
	const localFields = (fs: readonly LocalFilterField[], text: string): Field[] => fs.map((f) => ({ label: f.label, path: [{ k: 'field' as const, name: f.name }], kind: f.kind,
		...options({ kind: f.kind }, f.optional ? { optional: true } : undefined, literals(text, m.workspace.locale), words(text))!, sort: f.name }));
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

	async function call(state: DecisionRequest['state'], questions: { [id: string]: DecisionQuestion }): Promise<DecisionResult | { ok: false; code: string; message: string }> {
		const req = { state, questions };
		const d = await ask(cfg.ai, req);
		const id = randomUUID();
		await cfg.db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ($1::timestamptz, $2, 'decision.made', $3, $4::jsonb)`,
			params: [cfg.clock(), failed(d) ? 'warn' : 'info', id, JSON.stringify(decisionEvent('filter', req, d))] });
		await meter(cfg.metering, d, id);
		return failed(d) ? { ok: false, code: d.kind, message: 'Could not build a filter from that description.' } : d;
	}
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
		const subjectOf = subject(o, o.text);
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const local = o.collection === '$local';
		const fields = subjectOf.fields ?? await offer(o.collection, o.text, o.authority, o.bindings);
		if (fields.length === 0) return fail('Nothing here can be filtered by a description.');
		const qual = (f: Field, x: string) => `${f.label} · ${x}`;
		/** A choice's criteria: each option names itself (the provider reads option → description). */
		const own = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, k]));
		// one field's own operators and values, so an answer can only ever name that field: the request asks what to do
		// with a field, never which field, and so carries no answer the next question depends on
		const forField = (f: Field) => ({ ops: new Map(f.ops.map((x) => [qual(f, x.label), x])), vals: new Map(f.values.map((v) => [qual(f, v.label), v.arg])) });
		// the provider's cap per choice question (the Decisions API: 255)
		const max = cfg.ai?.sys_1.maxChoices ?? Infinity;
		const sortable = fields.filter((f) => f.sort !== undefined);
		const DIRS = { asc: 'ascending (oldest, lowest, A→Z first)', desc: 'descending (newest, highest, Z→A first)' };
		// the fields the description most plausibly means, asked about in that order: a wide collection keeps the ones a
		// person actually wrote of rather than the first twelve the schema happens to declare
		const asked = fields
			.map((f, i) => ({ f, i }))
			.sort((l, r) => Number(r.f.hit ?? false) - Number(l.f.hit ?? false) || l.i - r.i)
			.slice(0, FILTER_MAX_FIELDS);
		const state = { description: o.text, collection: human(o.collection), fields: asked.map(({ f }) => ({ label: f.label, kind: f.kind })),
			today: o.bindings.today, timezone: o.bindings.tz, weekStartsOn: 'Monday' };
		const first: { [id: string]: DecisionQuestion } = {};
		const choices2 = new Map<Field, ReturnType<typeof forField>>();
		for (const [n, { f }] of asked.entries()) {
			const q = forField(f);
			choices2.set(f, q);
			Object.assign(first, {
				[`f${n + 1}`]: { type: 'noul', instructions: `Does the description restrict the records by ${f.label}?`,
					criteria: { true: `it states a condition on ${f.label}`, false: `it states no condition on ${f.label}` } },
				[`f${n + 1}.op`]: { type: 'choice', instructions: `Which comparison does the condition on ${f.label} use?`, criteria: own([...q.ops.keys()]) },
				[`f${n + 1}.value`]: { type: 'choice', instructions: `Which value does the condition on ${f.label} compare with?`, criteria: own([NONE, ...q.vals.keys()]) } });
		}
		// the composition of every stated condition: bounded to one top-level AND, OR or their negations
		Object.assign(first, { combine: { type: 'choice', instructions: 'How do the stated conditions combine?',
			criteria: Object.fromEntries(Object.entries(COMBINE).map(([k, v]) => [k, v.because])) } });
		if (sortable.length > 0) Object.assign(first, {
			'sort.yes': { type: 'noul', instructions: 'Does the description ask for an order?', criteria: { true: 'it asks for an order', false: 'it asks for no order' } },
			'sort.field': { type: 'choice', instructions: 'Which field orders the records?', criteria: own(sortable.slice(0, max).map((f) => f.label)) },
			'sort.dir': { type: 'choice', instructions: 'Which direction?', criteria: { [DIRS.asc]: 'smallest or earliest first', [DIRS.desc]: 'largest or latest first' } } });
		const r1 = await call(state, first);
		if ('ok' in r1) return r1;
		const conds: Json[] = [];
		for (const [n, { f }] of asked.entries()) {
			if (noulOf(r1, `f${n + 1}`) <= 0.5) continue;
			// the engine has already refused an answer outside the offered criteria, so these are present; the fallbacks only
			// satisfy the type, and an unbuildable pair fails the filter below rather than being dropped
			const q = choices2.get(f)!;
			const op = q.ops.get(choiceOf(r1, `f${n + 1}.op`) ?? ''), arg = q.vals.get(choiceOf(r1, `f${n + 1}.value`) ?? '');
			const c = condition(f.path, op?.op ?? '', arg);
			if (c === undefined) return fail(`Could not build a condition on ${f.label}.`);
			conds.push(c);
			if (conds.length === FILTER_MAX_CONDITIONS) break;
		}
		const combine = COMBINE[choiceOf(r1, 'combine') ?? ''] ?? ALL;
		const group = conds.length === 1 ? conds[0]! : { [combine.join]: conds };
		const where: Json = conds.length === 0 ? { and: [] } : combine.not ? { not: group } : group;
		const sortField = sortable.length > 0 && noulOf(r1, 'sort.yes') > 0.5 ? sortable.find((f) => f.label === choiceOf(r1, 'sort.field')) : undefined;
		const dir: Json = choiceOf(r1, 'sort.dir') === DIRS.asc ? 'asc' : 'desc';
		const orderBy: Json | undefined = sortField === undefined ? undefined : sortField.sort!.split('.').reduceRight<Json>((v, k) => ({ [k]: v }), dir);
		try { // rule 11a: the same strict decode as any read literal, held to the caller's exposure
			if (!local) decodeDescribed(cat, o.authority, o.collection, { where, ...(orderBy === undefined ? {} : { orderBy }) });
		} catch (e) {
			return fail(e instanceof BoltError ? e.message : 'Could not build a filter from that description.');
		}
		return { ok: true, where, ...(orderBy === undefined ? {} : { orderBy }) };
	}
	/** `filter.options` as the caller: the same catalogue the description is asked about, as plain data for the builder. */
	async function opts(o: { collection: string; authority: Authority; bindings: Bindings; localFields?: readonly LocalFilterField[] }): Promise<{ ok: true; fields: FilterCatalogue } | { ok: false; code: string; message: string }> {
		const subjectOf = subject(o, '');
		if (subjectOf.fail !== undefined) return subjectOf.fail;
		const fields = subjectOf.fields ?? await offer(o.collection, '', o.authority, o.bindings);
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
export function decodeDescribed(cat: Catalog, a: Authority, collection: string, q: { where: Json; orderBy?: Json }): void {
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
	walk(ir.where(cat, collection, q.where), collection);
	// a related key (`assignee.name`): each hop a relation the caller reads, then the target's field
	if (q.orderBy !== undefined) for (const k of ir.order(q.orderBy, cat, collection)) {
		const steps = k.field.split('.');
		let c = collection;
		for (const s of steps.slice(0, -1)) { rel(c, s); c = cat.collections.get(c)!.model.one.get(s)!.targets[0]!; }
		field(c, steps.at(-1)!);
	}
}
