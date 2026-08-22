import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { field } from '../../src/authoring/workspace-schema.js';
import { compileWhere, type WhereContext } from '../../src/runtime/collections/where.js';

/**
 * `RAW` is a declared part of the authoring contract — how a workspace expresses a predicate the
 * operator vocabulary cannot, such as a JSONB path. The earlier compiler dropped unrecognised keys
 * silently, so a `RAW` filter was ignored and the query ran unfiltered, quietly returning the wrong
 * count; the rewrite then rejected it outright. Neither ran the predicate the author wrote.
 */
const context: WhereContext = {
	collection: 'component_entries',
	fields: { origin: field.json({ required: true }), amount: field.number() },
	relations: [],
	collections: ['component_entries'],
	fieldsByCollection: {
		component_entries: { origin: field.json({ required: true }), amount: field.number() }
	}
};

const compiled = (where: unknown) => {
	const result = compileWhere(where, context);
	if (Result.isFailure(result)) throw new Error(result.failure.message);
	return result.success;
};

describe('RAW where entries', () => {
	it('renders a jsonb predicate the operator vocabulary cannot express', () => {
		const query = compiled({
			RAW: (
				table: Record<string, unknown>,
				{ sql }: { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }
			) => sql`${table['origin']}->>'kind' = 'CLAIM'`
		});
		expect(query.sql).toContain("->>'kind' = 'CLAIM'");
		expect(query.sql).toContain('origin');
	});

	it('binds an interpolated operand instead of pasting it into the statement', () => {
		const query = compiled({
			RAW: (
				table: Record<string, unknown>,
				{ sql }: { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }
			) => sql`(${table['origin']}->>'incurred_on')::date >= ${'2026-01-01'}::date`
		});
		expect(query.parameters).toEqual(['2026-01-01']);
		// The literal must not appear inline — that is the difference between a bound value and an
		// injection point.
		expect(query.sql).not.toContain('2026-01-01');
	});

	it('combines with ordinary column conditions rather than replacing them', () => {
		const query = compiled({
			approval_id: { isNull: true },
			RAW: (
				table: Record<string, unknown>,
				{ sql }: { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }
			) => sql`${table['origin']}->>'kind' = 'CLAIM'`
		});
		expect(query.sql).toContain('is null');
		expect(query.sql).toContain("->>'kind'");
	});

	it('refuses a RAW that is not a function', () => {
		const result = compileWhere({ RAW: 'drop table users' }, context);
		expect(Result.isFailure(result)).toBe(true);
	});

	it('reports a callback that throws instead of running an unfiltered query', () => {
		const result = compileWhere(
			{
				RAW: () => {
					throw new Error('boom');
				}
			},
			context
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) expect(result.failure.message).toContain('boom');
	});

	it('refuses a callback that returns something other than a sql fragment', () => {
		const result = compileWhere({ RAW: () => 'true' }, context);
		expect(Result.isFailure(result)).toBe(true);
	});
});
