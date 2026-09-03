import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { field, type WorkspaceDefinition } from '../src/authoring/workspace-schema.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { compileCollectionPredicate } from '../src/runtime/access/effective-plan.js';

const definition: WorkspaceDefinition = {
	name: 'where-raw-test',
	version: '1',
	collections: [
		{
			name: 'component_entries',
			fields: { origin: field.json({ required: true }), amount: field.number() },
			history: true
		}
	],
	relations: [],
	apps: [],
	policies: [],
	prompt: 'Compile custom where test predicates.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [],
	integrations: [],
	requiredFacilities: []
};

const context = {
	collection: 'component_entries',
	fields: { origin: field.json({ required: true }), amount: field.number() },
	relations: [],
	collections: ['component_entries'],
	fieldsByCollection: {
		component_entries: { origin: field.json({ required: true }), amount: field.number() }
	},
	definition
};

const compilePredicate = (where: unknown, input: typeof context) =>
	compileCollectionPredicate({
		definition: input.definition,
		collection: input.collection,
		where,
		qualifier: input.collection
	});

describe('custom SQL where entries', () => {
	it('refuses the removed RAW callback escape', () => {
		const result = compilePredicate({ RAW: () => 'true' }, context);

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure.field).toBe('where.RAW');
			expect(result.failure.message).toContain('neither a field');
		}
	});

	it('refuses a string that attempts to use the removed escape', () => {
		const result = compilePredicate({ RAW: 'drop table users' }, context);

		expect(Result.isFailure(result)).toBe(true);
	});

	it('quotes declared identifiers and binds authored values', () => {
		// The compiled SQL object is what `RAW` accepts; a plain {sql, parameters} pair cannot enter
		// the grammar, and every authored operand is a bound parameter, never inlined text.
		const quotedContext = {
			...context,
			fields: { ...context.fields, 'odd"name': field.string({ required: true }) },
			fieldsByCollection: {
				component_entries: {
					...context.fieldsByCollection['component_entries'],
					'odd"name': field.string({ required: true })
				}
			},
			definition: {
				...definition,
				collections: [
					{
						...definition.collections[0]!,
						fields: {
							...definition.collections[0]!.fields,
							'odd"name': field.string({ required: true })
						}
					}
				]
			}
		};
		const attemptedSql = "x' OR true --";
		const result = compilePredicate({ 'odd"name': { eq: attemptedSql } }, quotedContext);

		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			const built = new PgDialect().sqlToQuery(result.success.sql);
			expect(built.sql).toBe('"component_entries"."odd""name" is not distinct from $1');
			expect(built.sql).not.toContain(attemptedSql);
			expect(built.params).toEqual([attemptedSql]);
		}
	});
});
