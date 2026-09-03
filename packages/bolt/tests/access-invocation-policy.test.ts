import { describe, expect, it } from 'vitest';
import { predicateStatement, type RowPredicate } from '../src/runtime/access/predicate.js';
import {
	afterHookElevation,
	policyHashSource
} from '../src/runtime/access/policy-surface.js';

describe('invocation policy contracts', () => {
	it('keeps approval while narrowing after-hook elevation', () => {
		const source: RowPredicate = {
			allowed: true,
			reason: 'matching authored grant',
			expression: {
				kind: 'comparison',
				column: 'owner_id',
				operator: 'eq',
				value: 'user-1'
			},
			actorBound: true,
			fields: ['name'],
			authorization: { id: 'authorize-write' },
			approval: { id: 'approval-route' }
		};

		expect(afterHookElevation(source)).toEqual({
			allowed: true,
			reason: 'after-hook elevation',
			expression: { kind: 'constant', value: true },
			actorBound: false,
			approval: { id: 'approval-route' }
		});
	});

	it('produces stable policy-hash material from executed predicate and mask', () => {
		const source: RowPredicate = {
			allowed: true,
			reason: 'matching authored grant',
			expression: {
				kind: 'or',
				expressions: [
					{
						kind: 'comparison',
						column: 'owner_id',
						operator: 'eq',
						value: 'user-1'
					},
					{ kind: 'constant', value: false }
				]
			},
			actorBound: true,
			fields: ['status', 'name', 'status']
		};

		const hash = policyHashSource('read', 'people', source);
		expect(hash).toMatchObject({
			action: 'read',
			resource: 'people',
			allowed: true,
			parameters: ['user-1'],
			fields: ['name', 'status']
		});
		expect(hash.sql).toContain('"owner_id" is not distinct from $1');
		expect(hash.sql).toContain('or false');
	});

	it('owns qualification and parameter offsets at the statement compiler boundary', () => {
		const source: RowPredicate = {
			allowed: true,
			reason: 'matching authored grant',
			expression: {
				kind: 'and',
				expressions: [
					{
						kind: 'comparison',
						column: 'owner_id',
						operator: 'eq',
						value: 'user-1'
					},
					{
						kind: 'membership',
						column: 'status',
						negated: false,
						values: ['open', 'closed']
					}
				]
			},
			actorBound: true
		};

		const statement = predicateStatement(source, {
			qualifier: 'candidate',
			parameterOffset: 3
		});

		expect(statement.sql).toContain('"candidate"."owner_id" is not distinct from $4');
		expect(statement.sql).toContain('"candidate"."status" in ($5, $6)');
		expect(statement.sql).not.toContain(' as "predicate"');
		expect(statement.parameters).toEqual(['user-1', 'open', 'closed']);
	});
});
