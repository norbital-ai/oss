import { describe, expect, it } from '@effect/vitest';
import { selectField, selectOperator, selectQuantifier, aggregateValue } from '../src/filter/edit.ts';
import { operatorsFor } from '../src/filter/operators.ts';
import { resolve, type Offer } from '../src/filter/catalog.ts';
import { taggedArg, type Node, type Op, type RawArg } from '../src/filter/node.ts';
import { fromWhere, toWhere } from '../src/filter/where.ts';
import type { Json, Kind, Value } from '../src/kinds/kind.ts';
import type { ModelExposure } from '../src/kinds/context.ts';

const catalog: Record<string, ModelExposure> = {
	people: {
		record_label: 'record.name',
		label: ['name'],
		fields: {
			name: { kind: 'text' },
			alias: { kind: 'text' },
			status: { kind: 'enum', values: ['open', 'closed'] },
			phase: { kind: 'state', initial: 'open', states: { open: { to: ['done'] }, done: {} } },
			hired: { kind: 'date', optional: true },
			due: { kind: 'date' },
			seen: { kind: 'instant', optional: true },
			at: { kind: 'time', optional: true },
			window: { kind: 'period', of: 'date' },
			shift: { kind: 'period', of: 'instant' },
			amount: { kind: 'number' },
			money: { kind: 'money' },
			sequence: { kind: 'seq' },
			code: { kind: 'seq', pattern: 'CASE-{0000}' },
			enabled: { kind: 'bool' },
			meta: { kind: 'json', optional: true },
			spot: { kind: 'point', optional: true },
			tags: { kind: 'text', many: true }
		},
		relations: {
			employer: { targets: ['companies'] },
			agency: { targets: ['companies'] },
			manager: { targets: ['people'] }
		},
		many: ['contracts', 'notes']
	},
	companies: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' } } },
	contracts: {
		record_label: 'record.title',
		label: ['title'],
		fields: { title: { kind: 'text' }, amount: { kind: 'number' }, ends: { kind: 'date' } },
		relations: { person: { targets: ['people'], inverse: 'contracts' } }
	},
	notes: {
		record_label: 'record.body',
		label: ['body'],
		fields: { body: { kind: 'text' } },
		relations: { person: { targets: ['people'], inverse: 'notes' } }
	}
};
const condition = (
	path: string,
	op: Op = 'eq',
	arg: Parameters<typeof taggedArg>[0] = { lit: 'hello' }
): Extract<Node, { t: 'cond' }> => ({ t: 'cond', path, op, arg: taggedArg(arg) });
const pick = (n: Node, path: string, many = false) =>
	selectField(catalog, 'people', n, path, many, []);
const change = (n: Extract<Node, { t: 'cond' }>, op: Op) =>
	selectOperator(catalog, 'people', n, op, []);
const ops = (path: string, offers: Offer[] = []) => {
	const r = resolve(catalog, 'people', path);
	if (!r) throw Error('Missing fixture field');
	return operatorsFor(offers, [], path, r).map((o) => o.op);
};
/** A literal the kind decodes, for the operator under test. */
function valueFor(r: NonNullable<ReturnType<typeof resolve>>, op: Op): Value {
	if (r.leaf === 'rel') return 'company-1';
	const k = r.kind;
	if (k.kind === 'period')
		return op === 'contains'
			? k.of === 'date'
				? '2026-10-01'
				: '2026-10-01T00:00:00.000Z'
			: k.of === 'date'
				? { from: '2026-01-01', to: '2026-12-31' }
				: { start: '2026-01-01T00:00:00.000Z', end: '2026-12-31T00:00:00.000Z' };
	if (k.kind === 'json') return { a: 1 };
	if (k.kind === 'point') return { lat: 1, lng: 1 };
	if (k.kind === 'date') return '2026-10-01';
	if (k.kind === 'instant') return '2026-10-01T00:00:00.000Z';
	if (k.kind === 'time') return '09:00';
	if (k.kind === 'bool') return true;
	if (k.kind === 'enum') return k.values[0] ?? '';
	if (k.kind === 'state') return Object.keys(k.states)[0] ?? '';
	if (k.kind === 'currency') return 'USD';
	if (k.kind === 'text') return 'x';
	if (k.kind === 'seq') return k.pattern === undefined ? 1 : 'CASE-0001';
	if (k.kind === 'money' || k.kind === 'decimal') return 12;
	return 12;
}
function argFor(r: NonNullable<ReturnType<typeof resolve>>, op: Op): RawArg | null {
	if (['is_null', 'not_null', 'is_empty', 'not_empty'].includes(op)) return null;
	const value = valueFor(r, op);
	return op === 'in' || op === 'not_in' || op === 'has_any' || op === 'has_all'
		? { list: [value] }
		: { lit: value };
}
const paths = [
	'name',
	'alias',
	'status',
	'phase',
	'hired',
	'due',
	'seen',
	'at',
	'window',
	'shift',
	'amount',
	'money',
	'sequence',
	'code',
	'enabled',
	'meta',
	'spot',
	'tags',
	'employer',
	'agency',
	'manager',
	'employer.name'
] as const;

describe('filter state transitions', () => {
	it('preserves identical selections and compatible values', () => {
		const n = condition('name');
		expect(pick(n, 'name')).toBe(n);
		expect(change(n, 'eq')).toBe(n);
		expect(pick(n, 'alias')).toEqual({ ...n, path: 'alias' });
		expect(change(n, 'ne')).toEqual({ ...n, op: 'ne' });
		expect(change(n, 'like')).toEqual({ ...n, op: 'like' });
	});
	it('adapts scalar/list operators without silently taking the first of multiple choices', () => {
		expect(change(condition('name'), 'in')).toEqual(condition('name', 'in', { list: ['hello'] }));
		expect(change(condition('name', 'in', { list: ['hello'] }), 'eq')).toEqual(condition('name'));
		expect(change(condition('name', 'in', { list: ['a', 'b'] }), 'eq').arg).toBeNull();
		expect(change(condition('name', 'in', { list: ['a', 'b'] }), 'not_in')).toEqual(
			condition('name', 'not_in', { list: ['a', 'b'] })
		);
	});
	it('clears incompatible field values and selects only an operator of the destination type', () => {
		const day = pick(condition('name', 'like'), 'hired');
		expect(day).toMatchObject({ t: 'cond', path: 'hired', op: 'eq', arg: null });
		expect(pick(condition('name', 'eq', { lit: 'open' }), 'status')).toMatchObject({
			arg: taggedArg({ lit: 'open' })
		});
		expect(pick(condition('name'), 'status')).toMatchObject({ arg: null });
		expect(pick(condition('hired', 'eq', { lit: '2026-10-01' }), 'window')).toMatchObject({
			op: 'contains',
			arg: taggedArg({ lit: '2026-10-01' })
		});
		expect(
			pick(
				condition('window', 'overlaps', { lit: { from: '2026-01-01', to: '2026-12-31' } }),
				'hired'
			)
		).toMatchObject({ op: 'eq', arg: null });
	});
	it('checks catalogue operators against type and refuses impossible operator selections', () => {
		const stale: Offer[] = [
			{
				label: 'Hired',
				path: [{ k: 'field', name: 'hired' }],
				op: 'like',
				opLabel: 'contains',
				kind: 'text'
			}
		];
		expect(ops('hired', stale)).not.toContain('like');
		expect(ops('window')).toEqual(['contains', 'overlaps', 'contained_by', 'starts_within', 'ends_within']);
		expect(ops('enabled')).toEqual(['eq']);
		expect(ops('employer')).toEqual(['eq', 'ne', 'in', 'not_in']);
		expect(ops('amount')).toContain('in');
		expect(ops('sequence')).toEqual(['eq', 'ne', 'in', 'not_in']);
		expect(ops('code')).not.toContain('like');
		expect(change(condition('amount', 'eq', { lit: 12 }), 'in').arg).toEqual(
			taggedArg({ list: [12] })
		);
		const n = condition('hired', 'eq', { lit: '2026-10-01' });
		expect(change(n, 'like')).toBe(n);
		expect(change(n, 'is_null')).toMatchObject({ op: 'is_null', arg: null });
	});
	it('retains only valid variable, field, and range operands', () => {
		expect(pick(condition('hired', 'gte', { var: 'today' }), 'due')).toMatchObject({
			arg: taggedArg({ var: 'today' })
		});
		expect(pick(condition('hired', 'gte', { var: 'today' }), 'amount')).toMatchObject({
			arg: null
		});
		expect(pick(condition('hired', 'lt', { field: 'due' }), 'due')).toMatchObject({ arg: null });
		const n = condition('hired', 'during', { range: ['2026-10-01', '2026-11-01'] });
		const offer: Offer = {
			label: 'Due',
			path: [{ k: 'field', name: 'due' }],
			op: 'during',
			opLabel: 'is within',
			kind: 'date'
		};
		expect(selectField(catalog, 'people', n, 'due', false, [offer])).toMatchObject({
			op: 'during',
			arg: n.arg
		});
	});
	it('preserves a selected record only between references to the same model', () => {
		const n = condition('employer', 'eq', { lit: 'company-1' });
		expect(pick(n, 'agency')).toMatchObject({ arg: n.arg });
		expect(pick(n, 'manager')).toMatchObject({ arg: null });
		expect(pick(n, 'name')).toMatchObject({ arg: null });
	});
	it('never carries child clauses or scalar controls across a structural change', () => {
		const n: Node = { t: 'many', rel: 'contracts', q: 'none', of: [condition('title')] };
		expect(pick(n, 'contracts', true)).toBe(n);
		expect(pick(n, 'notes', true)).toEqual({ t: 'many', rel: 'notes', q: 'some', of: [] });
		expect(pick(n, 'name')).toEqual({ t: 'cond', path: 'name', op: 'like', arg: null });
		expect(pick(condition('name'), 'contracts', true)).toEqual({
			t: 'many',
			rel: 'contracts',
			q: 'some',
			of: []
		});
		expect(pick(n, 'nonexistent', true)).toBe(n);
	});
	it('keeps aggregate thresholds in the selected aggregate field family', () => {
		expect(aggregateValue(catalog, 'contracts', 'sum', 'amount', 12)).toBe(12);
		expect(aggregateValue(catalog, 'contracts', 'max', 'ends', 12)).toBeNull();
		expect(aggregateValue(catalog, 'contracts', 'max', 'ends', '2026-10-31')).toBe('2026-10-31');
		expect(aggregateValue(catalog, 'contracts', 'count', undefined, 1.5)).toBeNull();
	});
	it('refuses an operator its field kind cannot take', () => {
		// fromWhere is the untrusted boundary: a parsed where is JSON, not a Node
		const badJson: readonly Json[] = [
			{ name: { is_null: true } },
			{ hired: { like: '%2026-10-01%' } },
			{ status: { gt: 'open' } },
			{ employer: { like: '%company-1%' } },
			{ employer: { isEmpty: true } },
			{ hired: { during: '2026-10-01' } },
			{ employer: { is: { id: { eq: 'company-1' }, name: { eq: 'Acme' } } } },
			{ sequence: { gt: 1 } },
			{ spot: { near: { lat: 1, lng: 1 } } },
			{ spot: { near: [{ lat: 1, lng: 1 }, -1] } },
			{ spot: { within: { lat: 1, lng: 1 } } },
			{ contracts: { max: { of: 'ends', gte: 12 } } },
			{ contracts: { sum: { of: 'amount', gte: '12' } } }
		];
		for (const bad of badJson)
			expect(fromWhere(catalog, 'people', bad), JSON.stringify(bad)).toBeNull();
		// toWhere takes a Node the UI built: these are well-typed nodes the catalogue still refuses
		const badNodes: readonly Node[] = [
			condition('name', 'is_null'),
			condition('hired', 'like', { lit: '2026-10-01' }),
			condition('status', 'gt', { lit: 'open' }),
			condition('employer', 'like', { lit: 'company-1' }),
			condition('employer', 'is_empty'),
			condition('employer', 'eq', { list: ['company-1'] }),
			condition('sequence', 'gt', { lit: 1 }),
			condition('spot', 'near', { lit: { lat: 1, lng: 1 } }),
			condition('spot', 'contained_by', { lit: { lat: 1, lng: 1 } }),
			{
				t: 'many',
				rel: 'contracts',
				q: 'max',
				of: [],
				op: 'gte',
				n: 12,
				field: 'ends'
			},
			{
				t: 'many',
				rel: 'contracts',
				q: 'sum',
				of: [],
				op: 'gte',
				n: '12',
				field: 'amount'
			},
			{ t: 'many', rel: 'bogus', q: 'some', of: [] }
		];
		for (const bad of badNodes)
			expect(toWhere(catalog, 'people', bad), JSON.stringify(bad)).toBeNull();
	});
	it('round-trips every operator the grammar offers for a field', () => {
		for (const path of paths) {
			const r = resolve(catalog, 'people', path);
			if (r === null) throw Error(path);
			for (const op of operatorsFor([], [], path, r)) {
				const arg = argFor(r, op.op);
				const n: Node = {
					t: 'cond',
					path,
					op: op.op,
					arg: arg === null ? null : taggedArg(arg)
				};
				const w = toWhere(catalog, 'people', n);
				expect(w, `${path} ${op.op}`).not.toBeNull();
				const back = w === null ? null : fromWhere(catalog, 'people', w);
				expect(back, `${path} ${op.op}`).not.toBeNull();
				expect(back?.[0], `${path} ${op.op}`).toMatchObject({
					t: 'cond',
					path,
					op: op.op
				});
			}
		}
		// a described span and a described radius are legal even though the fallback does not offer them
		for (const n of [
			{
				t: 'cond',
				path: 'hired',
				op: 'during',
				arg: taggedArg({ range: ['2026-10-01', '2026-11-01'] })
			},
			{
				t: 'cond',
				path: 'spot',
				op: 'near',
				arg: taggedArg({ lit: [{ lat: 1, lng: 1 }, 1500] })
			}
		] as const) {
			const w = toWhere(catalog, 'people', n);
			expect(w, `${n.path} ${n.op}`).not.toBeNull();
			expect(fromWhere(catalog, 'people', w ?? null)?.[0], `${n.path} ${n.op}`).toMatchObject({
				t: 'cond',
				path: n.path,
				op: n.op
			});
		}
	});
	it('round-trips every structural row the builder can make', () => {
		const rows: Node[] = [
			{
				t: 'group',
				join: 'or',
				of: [condition('name', 'like', { lit: 'Acme' }), condition('amount', 'gt', { lit: 3 })]
			},
			{ t: 'group', join: 'and', not: true, of: [condition('name', 'eq', { lit: 'Acme' })] },
			{
				t: 'many',
				rel: 'contracts',
				q: 'some',
				of: [condition('status', 'eq', { lit: 'open' })]
			},
			{ t: 'many', rel: 'contracts', q: 'none', of: [] },
			{ t: 'many', rel: 'contracts', q: 'every', of: [] },
			{ t: 'many', rel: 'contracts', q: 'count', of: [], op: 'gte', n: 2 },
			{
				t: 'many',
				rel: 'contracts',
				q: 'sum',
				of: [],
				op: 'gte',
				n: 12,
				field: 'amount'
			},
			{
				t: 'many',
				rel: 'contracts',
				q: 'max',
				of: [],
				op: 'lte',
				n: '2026-10-01',
				field: 'ends'
			},
			condition('employer.name', 'like', { lit: 'Acme' }),
			condition('employer', 'in', { list: ['company-1'] })
		];
		for (const n of rows) {
			const w = toWhere(catalog, 'people', n);
			expect(w, JSON.stringify(n)).not.toBeNull();
			const back = w === null ? null : fromWhere(catalog, 'people', w);
			expect(back, JSON.stringify(n)).not.toBeNull();
			for (const child of back ?? []) expect(toWhere(catalog, 'people', child)).not.toBeNull();
		}
		// only a date aggregate takes a date threshold, and only a number aggregate a number
		expect(
			fromWhere(catalog, 'people', { contracts: { max: { of: 'ends', lte: '2026-10-01' } } })
		).not.toBeNull();
		expect(
			fromWhere(catalog, 'people', { contracts: { sum: { of: 'ends', lte: 12 } } })
		).toBeNull();
		expect(
			fromWhere(catalog, 'people', { contracts: { count: { of: 'amount', lte: 12 } } })
		).toBeNull();
	});
	it('never leaves a condition on an operator or value its target kind cannot take', () => {
		const states: Extract<Node, { t: 'cond' }>[] = [];
		for (const path of paths) {
			const r = resolve(catalog, 'people', path);
			if (r === null) throw Error(path);
			for (const op of operatorsFor([], [], path, r)) {
				const arg = argFor(r, op.op);
				states.push({
					t: 'cond',
					path,
					op: op.op,
					arg: arg === null ? null : taggedArg(arg)
				});
			}
		}
		for (const state of states) {
			for (const path of paths) {
				const next = pick(state, path);
				if (next.t !== 'cond') continue;
				const r = resolve(catalog, 'people', next.path);
				if (r === null) throw Error(next.path);
				expect(
					operatorsFor([], [], next.path, r).map((o) => o.op),
					`${state.path} -> ${path}`
				).toContain(next.op);
				const w = toWhere(catalog, 'people', next);
				if (w !== null) expect(fromWhere(catalog, 'people', w), JSON.stringify(w)).not.toBeNull();
			}
			const r = resolve(catalog, 'people', state.path);
			if (r === null) throw Error(state.path);
			for (const op of operatorsFor([], [], state.path, r)) {
				const next = change(state, op.op);
				expect(
					operatorsFor([], [], state.path, r).map((o) => o.op),
					`${state.path} ${state.op} -> ${op.op}`
				).toContain(next.op);
				const w = toWhere(catalog, 'people', next);
				if (w !== null) expect(fromWhere(catalog, 'people', w), JSON.stringify(w)).not.toBeNull();
			}
		}
	});
	it('moves a many scope through its quantifiers without stale fields or values', () => {
		const contractOffers: Offer[] = [
			{
				label: 'Contracts count',
				path: [{ k: 'count', rel: 'contracts' }],
				op: 'gte',
				opLabel: 'at least',
				kind: 'count'
			},
			{
				label: 'Contracts sum amount',
				path: [{ k: 'agg', rel: 'contracts', fn: 'sum', of: 'amount' }],
				op: 'gte',
				opLabel: 'at least',
				kind: 'money'
			},
			{
				label: 'Contracts max amount',
				path: [{ k: 'agg', rel: 'contracts', fn: 'max', of: 'amount' }],
				op: 'gte',
				opLabel: 'at least',
				kind: 'money'
			},
			{
				label: 'Contracts max ends',
				path: [{ k: 'agg', rel: 'contracts', fn: 'max', of: 'ends' }],
				op: 'lte',
				opLabel: 'at most',
				kind: 'date'
			}
		];
		let m: Extract<Node, { t: 'many' }> = {
			t: 'many',
			rel: 'contracts',
			q: 'some',
			of: [condition('status', 'eq', { lit: 'open' })]
		};
		const children = m.of;
		m = selectQuantifier(catalog, 'people', contractOffers, [], m, 'none');
		expect(m.q).toBe('none');
		expect(m.of).toBe(children);
		m = selectQuantifier(catalog, 'people', contractOffers, [], m, 'count');
		expect(m).toMatchObject({ q: 'count', of: [], n: null });
		m = { ...m, op: 'gte', n: 2 };
		m = selectQuantifier(catalog, 'people', contractOffers, [], m, 'sum');
		expect(m).toMatchObject({ q: 'sum', field: 'amount', n: 2, op: 'gte' });
		m = selectQuantifier(catalog, 'people', contractOffers, [], m, 'some');
		expect(m).toMatchObject({ q: 'some', of: [] });
		expect(selectQuantifier(catalog, 'people', [], [], m, 'max')).toBe(m);
	});
});
