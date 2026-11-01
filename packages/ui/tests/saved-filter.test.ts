import { expect, it } from '@effect/vitest';
import { compile, context } from '@norbital-ai/std/formula';
import {
	fromWhere,
	operandsFor,
	resolve,
	rowsWhere,
	selectField,
	selectOperator,
	variablesFor,
	type FilterVariables,
	type Node
} from '../src/filter/filter.ts';
import type { Json } from '../src/client/contract.ts';
import type { ModelExposure } from '../src/kinds/context.ts';

const catalog: Record<string, ModelExposure> = {
	items: {
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
				ids: { kind: 'list', of: { kind: 'text' } }
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
			op === 'in' || op === 'nin'
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
