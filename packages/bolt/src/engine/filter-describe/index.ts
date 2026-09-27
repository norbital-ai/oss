// AI filtering (rule 16a, P33, P34): the view popover's "Describe what to show…" text becomes a typed `Where` and at most
// one `OrderBy` key through System 1 alone (P37 shapes). System 1 only chooses among criteria, so the engine builds them per request
// from the collection's exposure narrowed to what the caller reads unmasked: fields, operators per kind, enum and state
// values (with the final-state set), relation candidates from a label search as the caller (≤ 5 per word), me / my team
// / my party, relative date presets, and literals parsed from the text. One request carries 4 condition slots and one
// sort slot over the state `{ description, collection, fields, today, timezone }`; a slot whose operator or value names
// another field is re-asked with only its field's options (≤ 2 round trips). Bolt caps no option set: a request too large
// is the provider's refusal (`tooLarge`). The chosen options map 1:1 onto the result, which is decoded like any read
// literal and AND-composed under the author's `where` and the caller's grants by the reader (so it only narrows).
// A System 1 failure or an answer that maps to no condition is a typed failure: nothing applies. No fallback (owner).
// Through the collection's exposed relations the caller reads, one hop: a one-relation's target fields (`is`), a
// many-relation's child fields under has any / all / none, its count and numeric child aggregates. The result is decoded
// strictly against the caller's exposure (`decodeDescribed`): a field, relation or sort key outside it is refused.
// Sorting is by an own sortable field or, one hop through an exposed one-relation, a target field the caller reads unmasked
// (`{ assignee: { name: 'asc' } }`, offered as "Assignee › Name"); `decodeDescribed` holds a related key to the same exposure.
import { randomUUID } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import { BoltError, type AiPort, type Authority, type Bindings, type EngineManifest, type MeteringPort, type Pred, type ReadEngine, type TenantDb } from '../contracts.ts';
import { ask, choiceOf, decisionEvent, failed, meter, noulOf, type DecisionQuestion, type DecisionRequest, type DecisionResult } from '../decisions/index.ts';
import { catalogOf } from '../access/pred.ts';
import { exposedField, exposedRelation, type Catalog, type FieldInfo } from '../../protocol/catalog.ts';
import * as ir from '../../protocol/ir.ts';

export const FILTER_MAX_CONDITIONS = 4;
export const FILTER_MAX_TEXT = 500;
const CANDIDATES = 5, WORDS = 8, NONE = '(no value)';

type V = { lit: Json } | { range: readonly [Json, Json] } | { set: readonly Json[] } | { actor: 'id' | 'teams' | 'party' };
/** An offered field: `put` places an operator object where the field is (own, through `is`, under a quantifier, an aggregate). */
/** `sort`: the field's `OrderBy` path (`name`, `assignee.name`) where it may order the records. */
type Field = { name: string; label: string; kind: string; ops: readonly string[]; values: Map<string, V>; put: (ops: { [op: string]: Json }) => Json; own: boolean; sort?: string };
export type Described = { ok: true; where: Json; orderBy?: Json } | { ok: false; code: string; message: string };

const NUMERIC = new Set(['int', 'decimal', 'money', 'number', 'count', 'sum']);
const ORDERED = new Set([...NUMERIC, 'date', 'instant', 'time', 'text']);
const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'from', 'are', 'aren', 'not', 'isn', 'all', 'any', 'show', 'only',
	'first', 'last', 'next', 'newest', 'oldest', 'week', 'month', 'year', 'quarter', 'today', 'yesterday', 'days', 'done', 'open', 'what', 'which', 'who', 'whose']);
const human = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
const ORDINAL = ['first', 'second', 'third', 'fourth'];

/** Rule 16a's relative presets: day bounds on `date` fields, calendar bounds (Monday weeks, workspace timezone) on both. */
function presets(kind: string): [string, V][] {
	const day: [string, V][] = [['today', { range: [{ today: '' }, { today: '+1d' }] }], ['yesterday', { range: [{ today: '-1d' }, { today: '' }] }],
		['last 7 days', { range: [{ today: '-7d' }, { today: '+1d' }] }], ['next 7 days', { range: [{ today: '' }, { today: '+8d' }] }],
		['last 30 days', { range: [{ today: '-30d' }, { today: '+1d' }] }]];
	const at = (unit: string, shift: number): Json => shift === 0 ? { startOf: unit } : { startOf: unit, shift };
	const cal = ['week', 'month', 'quarter', 'year'].flatMap((u): [string, V][] => [[`this ${u}`, { range: [at(u, 0), at(u, 1)] }],
		[`last ${u}`, { range: [at(u, -1), at(u, 0)] }], ...(u === 'week' ? [[`next ${u}`, { range: [at(u, 1), at(u, 2)] }] as [string, V]] : [])]);
	return kind === 'date' ? [...day, ...cal] : cal;
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

/** One condition from a field, an operator and a value option; `undefined` when the pair means nothing. */
function condition(f: Field, op: string, v: V | undefined): Json | undefined {
	if (op === 'is empty' || op === 'is not empty') return f.put({ isNull: op === 'is empty' });
	if (v === undefined) return undefined;
	const one = (o: string, x: Json): Json => f.put({ [o]: x });
	if (f.kind === 'period') {
		// ponytail: a preset's upper bound is exclusive and a period's `to` a day, so a span ends one day late at its edge
		if (op === 'in force on') return 'lit' in v ? one('contains', v.lit) : undefined;
		if ((op === 'overlaps' || op === 'within') && 'range' in v) return one(op, { from: v.range[0], to: v.range[1] });
		return undefined;
	}
	if ('range' in v) {
		const [lo, hi] = v.range;
		return op === 'within' || op === 'is' ? f.put({ gte: lo, lt: hi }) : op === 'before' ? one('lt', lo) : op === 'on or after' ? one('gte', lo) : undefined;
	}
	if ('set' in v) return op === 'is' ? one('in', v.set as Json) : op === 'is not' ? one('nin', v.set as Json) : undefined;
	if ('actor' in v) {
		const many = v.actor === 'teams';
		return op === 'is' ? one(many ? 'in' : 'eq', v) : op === 'is not' ? one(many ? 'nin' : 'ne', v) : undefined;
	}
	const CMP: { readonly [op: string]: string } = { is: 'eq', within: 'eq', 'is not': 'ne', 'more than': 'gt', 'at least': 'gte', 'on or after': 'gte',
		'less than': 'lt', before: 'lt', 'at most': 'lte' };
	if (op === 'contains') return typeof v.lit === 'string' ? one('like', `%${esc(v.lit)}%`) : undefined;
	return CMP[op] === undefined ? undefined : one(CMP[op]!, v.lit);
}

export type FilterDescribeConfig = { manifest: EngineManifest; db: TenantDb; read: ReadEngine['run']; clock: () => string; ai?: AiPort; metering?: MeteringPort };

export function filterDescribe(cfg: FilterDescribeConfig) {
	const m = cfg.manifest, cat = catalogOf(m);

	/** The operators and values a field of kind `k` is offered with, or `undefined` when no option can express it. */
	function options(f: FieldInfo, s: Spec | undefined, lit: ReturnType<typeof literals>, ws: readonly string[]): { ops: string[]; values: Map<string, V> } | undefined {
		const values = new Map<string, V>();
		const add = (label: string, v: V) => { let l = label, n = 2; while (values.has(l)) l = `${label} (${n++})`; values.set(l, v); };
		let ops: string[];
		if (f.kind === 'enum' || f.kind === 'state') {
			ops = ['is', 'is not'];
			const states = s?.states ?? {};
			for (const v of f.kind === 'enum' ? s?.values ?? [] : Object.keys(states)) add(v, { lit: v });
			if (f.kind === 'state') add('a final state', { set: Object.keys(states).filter((k) => (states[k]!.to ?? []).length === 0) });
		} else if (f.kind === 'bool') {
			ops = ['is']; add('yes', { lit: true }); add('no', { lit: false });
		} else if (f.kind === 'text') {
			ops = ['is', 'is not', 'contains'];
			for (const x of [...lit.strings, ...ws]) add(x, { lit: x });
		} else if (NUMERIC.has(f.kind)) {
			ops = ['is', 'more than', 'at least', 'less than', 'at most'];
			for (const x of lit.numbers) add(String(x), { lit: x });
		} else if (f.kind === 'date' || f.kind === 'instant') {
			ops = ['within', 'before', 'on or after'];
			for (const [l, v] of presets(f.kind)) add(l, v);
			if (f.kind === 'date') for (const d of lit.dates) add(d, { lit: d });
		} else if (f.kind === 'period' && f.periodOf === 'date') {
			// a date period (an employment's effective_range): in force on a day, or overlapping / inside a span
			ops = ['in force on', 'overlaps', 'within'];
			add('today', { lit: { today: '' } });
			for (const [l, v] of presets('date')) add(l, v);
			for (const d of lit.dates) add(d, { lit: d });
		} else return undefined;
		if (s?.optional === true) ops.push('is empty', 'is not empty');
		return { ops, values };
	}
	/** Whether the caller reads collection `c` and its field `f` unmasked (rule 14): the narrowing of every option. */
	const reads = (a: Authority, c: string) => a.admin || (a.collections[c]?.read.length ?? 0) > 0;
	const unmasked = (a: Authority, c: string, f: string) => a.admin || a.collections[c]?.masks[f] === undefined;

	/** The offered fields: exposed, read unmasked by the caller, of a kind the options can express; then one hop through each exposed relation. */
	async function offer(collection: string, text: string, a: Authority, b: Bindings): Promise<Field[]> {
		const c = cat.collections.get(collection)!;
		const spec = m.models[collection]?.fields ?? {};
		const lit = literals(text, m.workspace.locale);
		const ws = words(text);
		const out: Field[] = [];
		const searches: { field: Field; target: string; label: string }[] = [];
		for (const f of c.model.fields.values()) {
			const system = ['created_at', 'updated_at'].includes(f.name);
			const s = spec[f.name] as Spec | undefined;
			if (f.name.includes('.') || f.many || (!system && s === undefined && !c.model.one.has(f.name)) || s?.hidden || !exposedField(c, f.name)) continue;
			if (!unmasked(a, collection, f.name)) continue;
			const put = (ops: { [op: string]: Json }): Json => ({ [f.name]: ops });
			const label = system ? (f.name === 'created_at' ? 'Created' : 'Updated') : s?.label ?? human(f.name);
			const rel = c.model.one.get(f.name);
			if (rel !== undefined) {
				if (rel.targets.length > 1) continue;
				const target = rel.targets[0]!;
				const field: Field = { name: f.name, label, kind: 'record', ops: ['is', 'is not', 'is empty', 'is not empty'], values: new Map(), put, own: true };
				if (target === 'sys_user') field.values.set('me', { actor: 'id' });
				if (target === 'sys_team') field.values.set('my team', { actor: 'teams' });
				if (a.actor.kind === 'member' && a.actor.party?.collection === target) field.values.set('my party', { actor: 'party' });
				const tl = [m.models[target]?.label ?? 'name'].flat()[0]!;
				if (cat.collections.get(target)?.model.fields.get(tl)?.kind === 'text' && reads(a, target) && unmasked(a, target, tl)) searches.push({ field, target, label: tl });
				out.push(field);
				continue;
			}
			const o = options(f, s, lit, ws);
			if (o !== undefined) out.push({ name: f.name, label, kind: f.kind, ...o, put, own: true, sort: f.name });
		}
		// one hop through the exposed relations into collections the caller reads: the target's own declared, unmasked fields
		const through = (target: string, prefix: string, wrap: (inner: Json) => Json, sort?: string) => {
			const tc = cat.collections.get(target), tspec = m.models[target]?.fields ?? {};
			if (tc === undefined || !reads(a, target)) return;
			for (const f of tc.model.fields.values()) {
				const s = tspec[f.name] as Spec | undefined;
				if (s === undefined || s.hidden || f.name.includes('.') || f.many || tc.model.one.has(f.name) || !exposedField(tc, f.name) || !unmasked(a, target, f.name)) continue;
				const o = options(f, s, lit, ws);
				if (o !== undefined) out.push({ name: f.name, label: `${prefix} › ${s.label ?? human(f.name)}`, kind: f.kind, ...o, own: false, put: (ops) => wrap({ [f.name]: ops }),
					...(sort === undefined ? {} : { sort: `${sort}.${f.name}` }) });
			}
		};
		for (const [r, rel] of c.model.one) {
			if (rel.targets.length > 1 || !exposedRelation(c, r) || !unmasked(a, collection, r)) continue;
			through(rel.targets[0]!, human(r), (inner) => ({ [r]: { is: inner } }), r);
		}
		for (const [r, rel] of c.model.many) {
			if (!exposedRelation(c, r) || !reads(a, rel.child) || rel.column.includes('__')) continue;
			const tc = cat.collections.get(rel.child), rl = human(r);
			if (tc === undefined) continue;
			for (const [q, word] of [['some', 'any'], ['every', 'all'], ['none', 'none']] as const) through(rel.child, `${rl} (${word})`, (inner) => ({ [r]: { [q]: inner } }));
			// its count, and numeric child aggregates: compared with the numbers in the text
			const numbers = new Map<string, V>(lit.numbers.map((x) => [String(x), { lit: x }]));
			const cmp = ['is', 'more than', 'at least', 'less than', 'at most'];
			out.push({ name: r, label: `${rl} › count`, kind: 'count', ops: cmp, values: new Map(numbers), own: false, put: (ops) => ({ [r]: { count: ops } }) });
			for (const f of tc.model.fields.values()) {
				const s = m.models[rel.child]?.fields[f.name] as Spec | undefined;
				if (s === undefined || s.hidden || f.many || !['int', 'decimal', 'money'].includes(f.kind) || !exposedField(tc, f.name) || !unmasked(a, rel.child, f.name)) continue;
				for (const [fn, word] of [['sum', 'total'], ['avg', 'average'], ['min', 'lowest'], ['max', 'highest']] as const)
					out.push({ name: f.name, label: `${rl} › ${word} ${(s.label ?? human(f.name)).toLowerCase()}`, kind: 'decimal', ops: cmp, values: new Map(numbers), own: false,
						put: (ops) => ({ [r]: { [fn]: { of: f.name, ...ops } } }) });
			}
		}
		// relation candidates: one batch of label searches as the caller, ≤ 5 rows per word
		const lookups = searches.flatMap((s) => ws.map((w) => ({ s, q: ir.read(cat, s.target, { where: { [s.label]: { like: `%${esc(w)}%` } }, select: { [s.label]: true }, limit: CANDIDATES }) })));
		if (lookups.length > 0) {
			const answers = await cfg.read(lookups.map((r) => r.q), { as: 'caller', authority: a }, b);
			lookups.forEach(({ s }, i) => {
				for (const row of (answers[i] as { rows: readonly { readonly [k: string]: Json }[] }).rows) {
					const label = String(row[s.label]);
					if (![...s.field.values.values()].some((v) => 'lit' in v && v.lit === row['id'])) {
						let l = label, n = 2; while (s.field.values.has(l)) l = `${label} (${n++})`;
						s.field.values.set(l, { lit: row['id']! });
					}
				}
			});
		}
		return out;
	}

	async function call(state: DecisionRequest['state'], questions: { [id: string]: DecisionQuestion }): Promise<DecisionResult | Described> {
		const req = { state, questions };
		const d = await ask(cfg.ai, req);
		const id = randomUUID();
		await cfg.db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ($1::timestamptz, $2, 'decision.made', $3, $4::jsonb)`,
			params: [cfg.clock(), failed(d) ? 'warn' : 'info', id, JSON.stringify(decisionEvent('filter', req, d))] });
		await meter(cfg.metering, d, id);
		return failed(d) ? { ok: false, code: d.kind, message: 'Could not build a filter from that description.' } : d;
	}

	/** `filter.describe` as the caller: `{ collection, text }` → a decoded `Where` and optional `OrderBy`, or a typed failure. */
	async function describe(o: { collection: string; text: string; authority: Authority; bindings: Bindings }): Promise<Described> {
		const fail = (message: string): Described => ({ ok: false, code: 'invalid', message });
		if (o.text.trim() === '' || o.text.length > FILTER_MAX_TEXT) return fail(`A description is 1–${FILTER_MAX_TEXT} characters.`);
		if (!cat.collections.has(o.collection) || (!o.authority.admin && (o.authority.collections[o.collection]?.read.length ?? 0) === 0))
			return { ok: false, code: 'notFound', message: 'Not found or no access.' };
		const fields = await offer(o.collection, o.text, o.authority, o.bindings);
		if (fields.length === 0) return fail('Nothing here can be filtered by a description.');
		const byLabel = new Map(fields.map((f) => [f.label, f]));
		const qual = (f: Field, x: string) => `${f.label} · ${x}`;
		/** A choice's criteria: each option names itself (the provider reads option → description). */
		const own = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, k]));
		const opsOf = (fs: readonly Field[]) => own(fs.flatMap((f) => f.ops.map((x) => qual(f, x))));
		// the provider's cap per choice question (the Decisions API: 255): a field's values past it are not offered
		const max = cfg.ai?.sys_1.maxChoices ?? Infinity;
		const valuesOf = (fs: readonly Field[]) => own([NONE, ...fs.flatMap((f) => [...f.values.keys()].map((x) => qual(f, x)))].slice(0, max));
		const together = Object.keys(opsOf(fields)).length <= max && fields.reduce((n, f) => n + f.values.size, 1) <= max;
		const sortable = fields.filter((f) => f.sort !== undefined && ORDERED.has(f.kind));
		const DIRS = { asc: 'ascending (oldest, lowest, A→Z first)', desc: 'descending (newest, highest, Z→A first)' };
		const state = { description: o.text, collection: human(o.collection), fields: fields.map((f) => ({ label: f.label, kind: f.kind })),
			today: o.bindings.today, timezone: o.bindings.tz, weekStartsOn: 'Monday' };
		const slot = (n: number, fs: readonly Field[]): { [id: string]: DecisionQuestion } => ({
			[`c${n}.op`]: { type: 'choice', instructions: `Which comparison does the ${ORDINAL[n]} condition use?`, criteria: opsOf(fs) },
			[`c${n}.value`]: { type: 'choice', instructions: `Which value does the ${ORDINAL[n]} condition compare with?`, criteria: valuesOf(fs) } });
		const first: { [id: string]: DecisionQuestion } = {};
		for (let n = 0; n < FILTER_MAX_CONDITIONS; n++) Object.assign(first, {
			[`c${n}.yes`]: { type: 'noul', instructions: `Does the description restrict the records by at least ${n + 1} condition${n === 0 ? '' : 's'}? (About the ${ORDINAL[n]} condition.)`,
				criteria: { true: `it states a ${ORDINAL[n]} condition`, false: `it states fewer than ${n + 1} condition${n === 0 ? '' : 's'}` } },
			[`c${n}.field`]: { type: 'choice', instructions: `Which field does the ${ORDINAL[n]} condition restrict?`,
				criteria: Object.fromEntries(fields.slice(0, max).map((f) => [f.label, `${f.label} (${f.kind})`])) },
			// every field's operators and values in the one request, unless they pass the provider's cap: then each chosen
			// field's are asked in a second request, from that field alone
			...(together ? slot(n, fields) : {}) });
		if (sortable.length > 0) Object.assign(first, {
			'sort.yes': { type: 'noul', instructions: 'Does the description ask for an order?', criteria: { true: 'it asks for an order', false: 'it asks for no order' } },
			'sort.field': { type: 'choice', instructions: 'Which field orders the records?', criteria: Object.fromEntries(sortable.slice(0, max).map((f) => [f.label, `${f.label} (${f.kind})`])) },
			'sort.dir': { type: 'choice', instructions: 'Which direction?', criteria: { [DIRS.asc]: 'smallest or earliest first', [DIRS.desc]: 'largest or latest first' } } });
		const r1 = await call(state, first);
		if ('ok' in r1) return r1;

		// a slot is settled when its operator and value both belong to its field; the rest are re-asked once
		const pick = (f: Field, r: DecisionResult, n: number) => {
			const op = choiceOf(r, `c${n}.op`), value = choiceOf(r, `c${n}.value`);
			const mine = (x: string | undefined, none: boolean) => x !== undefined && (x.startsWith(`${f.label} · `) || (none && x === NONE));
			return mine(op, false) && mine(value, true) ? { f, op: op!.slice(f.label.length + 3), value: value === NONE ? null : value!.slice(f.label.length + 3) } : f;
		};
		// true is the likelier side above 0.5: this reads the answer and is no confidence threshold
		const slots = Array.from({ length: FILTER_MAX_CONDITIONS }, (_, n) => n).filter((n) => noulOf(r1, `c${n}.yes`) > 0.5)
			.map((n) => ({ n, p: pick(byLabel.get(choiceOf(r1, `c${n}.field`)!)!, r1, n) }));
		const again = slots.filter((s) => !('f' in s.p));
		if (again.length > 0) {
			const r2 = await call(state, Object.assign({}, ...again.map((s) => slot(s.n, [s.p as Field]))));
			if ('ok' in r2) return r2;
			for (const s of again) s.p = pick(s.p as Field, r2, s.n);
		}
		const conds: Json[] = [];
		for (const { p } of slots) {
			if (!('f' in p)) return fail('Could not build a filter from that description.');
			const c = condition(p.f, p.op, p.value === null ? undefined : p.f.values.get(p.value));
			if (c === undefined) return fail(`Could not build a condition on ${p.f.label}.`);
			conds.push(c);
		}
		// the same condition asked twice is one; `is` twice on one field is `is any of` ("sent or won")
		const merged: Json[] = [];
		for (const c of conds) {
			const [field, cmp] = Object.entries(c as { [f: string]: Json })[0]!;
			const eq = (x: Json) => x !== null && typeof x === 'object' && !Array.isArray(x) && 'eq' in x ? (x as { eq: Json }).eq : undefined;
			const prior = merged.findIndex((m) => field in (m as object) && eq((m as { [f: string]: Json })[field]!) !== undefined);
			if (merged.some((m) => JSON.stringify(m) === JSON.stringify(c))) continue;
			if (eq(cmp!) !== undefined && prior >= 0) merged[prior] = { [field]: { in: [eq((merged[prior] as { [f: string]: Json })[field]!)!, eq(cmp!)!] } };
			else merged.push(c);
		}
		const where: Json = merged.length === 1 ? merged[0]! : { and: merged };
		const sortField = sortable.length > 0 && noulOf(r1, 'sort.yes') > 0.5 ? sortable.find((f) => f.label === choiceOf(r1, 'sort.field')) : undefined;
		const dir: Json = choiceOf(r1, 'sort.dir') === DIRS.asc ? 'asc' : 'desc';
		const orderBy: Json | undefined = sortField === undefined ? undefined : sortField.sort!.split('.').reduceRight<Json>((v, k) => ({ [k]: v }), dir);
		try { // rule 11a: the same strict decode as any read literal, held to the caller's exposure
			decodeDescribed(cat, o.authority, o.collection, { where, ...(orderBy === undefined ? {} : { orderBy }) });
		} catch (e) {
			return fail(e instanceof BoltError ? e.message : 'Could not build a filter from that description.');
		}
		return { ok: true, where, ...(orderBy === undefined ? {} : { orderBy }) };
	}
	return { describe };
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
