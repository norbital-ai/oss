import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { field } from '../../src/authoring/workspace-schema.js';
import {
	compileWhere,
	whereExpression,
	type WhereContext
} from '../../src/runtime/collections/where.js';

const context: WhereContext = {
	collection: 'component_entries',
	fields: { origin: field.json({ required: true }), amount: field.number() },
	relations: [],
	collections: ['component_entries'],
	fieldsByCollection: {
		component_entries: { origin: field.json({ required: true }), amount: field.number() }
	}
};

describe('custom SQL where entries', () => {
	it('refuses the removed RAW callback escape', () => {
		const result = compileWhere({ RAW: () => 'true' }, context);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure.field).toBe('RAW');
			expect(result.failure.message).toContain('neither a column');
		}
	});

	it('refuses a string that attempts to use the removed escape', () => {
		const result = compileWhere({ RAW: 'drop table users' }, context);

		expect(Result.isFailure(result)).toBe(true);
	});

	it('refuses unbranded SQL at the Drizzle conversion boundary', () => {
		expect(() => whereExpression({ sql: 'true', parameters: [] } as never)).toThrowError(
			'only output from compileWhere'
		);
	});

	it('quotes declared identifiers and binds authored values', () => {
		const quotedContext: WhereContext = {
			...context,
			fields: { ...context.fields, 'odd"name': field.string({ required: true }) },
			fieldsByCollection: {
				component_entries: {
					...context.fieldsByCollection['component_entries'],
					'odd"name': field.string({ required: true })
				}
			}
		};
		const attemptedSql = "x' OR true --";
		const result = compileWhere({ 'odd"name': { eq: attemptedSql } }, quotedContext);

		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.success.sql).toBe(
				'"component_entries"."odd""name" collate "C" = $1'
			);
			expect(result.success.sql).not.toContain(attemptedSql);
			expect(result.success.parameters).toEqual([attemptedSql]);
		}
	});
});
