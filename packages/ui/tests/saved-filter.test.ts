import { expect, it } from '@effect/vitest';
import { compile, context } from '@norbital-ai/store/formula';
import { fromWhere, rowsWhere } from '../src/filter/where.ts';
import { operandsFor, variablesFor, type FilterVariables } from '../src/filter/operators.ts';
import { resolve, savedFilterCatalog } from '../src/filter/catalog.ts';
import { selectField, selectOperator } from '../src/filter/edit.ts';
import { type Node } from '../src/filter/node.ts';
import type { Json } from '../src/client/contract.ts';
import type { ModelExposure } from '../src/kinds/context.ts';

const catalog: Record<string, ModelExposure> = {
	items: {
		record_label: 'record.name',
		label: ['name'],
		fields: {
			name: { kind: 'text' },
			amount: { kind: 'number' },
			enabled: { kind: 'bool' },
			date: { kind: 'date' }
		}
	}
};
const scope = context(
	{
		ctx: {
			kind: 'object',
			fields: {
				amount: { kind: 'number' },
				enabled: { kind: 'bool' },
				date: { kind: 'date' },
				ids: { kind: 'text', many: true }
			}
		}
	},
	{ numbers: 'float' }
);
const variables: FilterVariables = {
	presets: ['ctx.amount', 'ctx.enabled', 'ctx.date', 'ctx.ids'],
	validate(text, position, op) {
		const result = compile(
			scope,
			text,
			op === 'in' || op === 'not_in'
				? 'json'
				: position.leaf === 'field' && position.kind.kind === 'number'
					? 'money'
					: position.leaf === 'field' && position.kind.kind === 'bool'
						? 'bool'
						: 'json'
		);
		return 'error' in result ? result.error : undefined;
	}
};

it('saved filters retain caller-owned numeric, boolean, list and date expressions without evaluating them', () => {
	const cases: readonly Json[] = [
		{ amount: { gte: { var: 'ctx.amount' } } },
		{ enabled: { eq: { var: 'ctx.enabled' } } },
		{ name: { in: { var: 'ctx.ids' } } },
		{ date: { gte: { var: 'ctx.date' } } },
		{ or: [{ amount: { gt: { var: 'ctx.amount' } } }, { enabled: { eq: { var: 'ctx.enabled' } } }] }
	];
	for (const where of cases) {
		const rows = fromWhere(catalog, 'items', where, 'items', '', variables);
		expect(rows).not.toBeNull();
		expect(rowsWhere(catalog, 'items', rows ?? [], undefined, variables)).toEqual(where);
		expect(fromWhere(catalog, 'items', where)).toBeNull();
	}
});

it('saved rule fields retain hidden readable bindings and nullable record conditions', () => {
	const original: Record<string, ModelExposure> = {
		...catalog,
		obligation: {
			label: [],
			fields: {
				state: { kind: 'enum', values: ['OPEN', 'FULFILLED'] },
				subject_id: { kind: 'text', optional: true, hidden: true }
			}
		},
		entry: {
			label: [],
			fields: {},
			relations: {
				payslip_id: { targets: ['items'], optional: true },
				employment_id: { targets: ['items'], optional: true }
			}
		}
	};
	const captured: FilterVariables = {
		presets: ['ctx.event.row.id'],
		validate: (text) => (text === 'ctx.event.row.id' ? undefined : 'Unknown captured binding.')
	};
	const editable = savedFilterCatalog(original);
	for (const [model, where] of [
		['obligation', { state: { eq: 'OPEN' }, subject_id: { eq: { var: 'ctx.event.row.id' } } }],
		['entry', { payslip_id: { is_null: true }, employment_id: { eq: { var: 'ctx.event.row.id' } } }]
	] as const) {
		const rows = fromWhere(editable, model, where, model, '', captured);
		expect(rows).not.toBeNull();
		expect(rows).toHaveLength(2);
		expect(rowsWhere(editable, model, rows ?? [], undefined, captured)).toEqual({
			and: Object.entries(where).map(([field, condition]) => ({ [field]: condition }))
		});
	}
	expect(fromWhere(original, 'obligation', { subject_id: { eq: 'subject' } })).toBeNull();
	expect(original.obligation?.fields.subject_id?.hidden).toBe(true);
	expect(fromWhere(editable, 'obligation', { unreadable_field: { eq: 'secret' } })).toBeNull();
});

it('the same field and operator transitions recheck saved expressions against the destination', () => {
	const node: Extract<Node, { t: 'cond' }> = {
		t: 'cond',
		path: 'amount',
		op: 'eq',
		arg: { _tag: 'var', var: 'ctx.amount' }
	};
	expect(selectOperator(catalog, 'items', node, 'gte', [], [], variables).arg).toEqual(node.arg);
	expect(selectField(catalog, 'items', node, 'enabled', false, [], [], variables)).toMatchObject({
		path: 'enabled',
		arg: null
	});
	const amount = resolve(catalog, 'items', 'amount');
	if (amount === null) throw Error('The model declares amount.');
	expect(operandsFor(amount, 'eq')).not.toContain('var');
	expect(operandsFor(amount, 'eq', variables)).toContain('var');
	expect(variablesFor(amount, 'eq', variables).map((v) => v.name)).toEqual(['ctx.amount']);
	expect(
		fromWhere(catalog, 'items', { amount: { eq: { var: 'other.amount' } } }, 'items', '', variables)
	).toBeNull();
	expect(
		fromWhere(catalog, 'items', { amount: { eq: { var: 'ctx.amount +' } } }, 'items', '', variables)
	).toBeNull();
});

it('a saved like takes a whole variable pattern and returns it unchanged', () => {
	const rule: FilterVariables = { presets: [], validate: () => undefined };
	const where = { name: { like: { var: "'SG:' + ctx.id + ':%'" } } };
	const rows = fromWhere(catalog, 'items', where, 'items', '', rule);
	expect(rows).not.toBeNull();
	expect(rowsWhere(catalog, 'items', rows ?? [], undefined, rule)).toEqual(where);
	// without a variable scope the pattern is not shown as a variable
	expect(fromWhere(catalog, 'items', where)).toBeNull();
	// a literal stays words in order
	const words = fromWhere(catalog, 'items', { name: { like: '%a%b%' } });
	expect(rowsWhere(catalog, 'items', words ?? [])).toEqual({ name: { like: '%a%b%' } });
});
