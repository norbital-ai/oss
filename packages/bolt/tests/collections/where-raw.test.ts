import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { field } from '../../src/authoring/workspace-schema.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
	compileWhere,
	type WhereContext
} from '../../src/runtime/collections/read/where.js';

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

	it('quotes declared identifiers and binds authored values', () => {
		// The compiled SQL object is what `RAW` accepts; a plain {sql, parameters} pair cannot enter
		// the grammar, and every authored operand is a bound parameter, never inlined text.
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
			const built = new PgDialect().sqlToQuery(result.success);
			expect(built.sql).toBe('"component_entries"."odd""name" = $1');
			expect(built.sql).not.toContain(attemptedSql);
			expect(built.params).toEqual([attemptedSql]);
		}
	});
});
