import { describe, expect, it } from '@effect/vitest';
import { Effect, SchemaRepresentation } from 'effect';
import { Validator } from '@cfworker/json-schema';

describe('runtime JSON Schema compatibility', () => {
	it.effect('retains conditional JSON Schema constraints supported by system-technic', () =>
		Effect.sync(() => {
			// Authored system-technic definitions accept active conditionals and dependentSchemas; Effect's JSON Schema import rejects them.
			const schema: import('@cfworker/json-schema').Schema = {
				type: 'object',
				properties: { kind: { type: 'string' }, value: { type: 'number' } },
				if: { properties: { kind: { const: 'positive' } }, required: ['kind'] },
				then: { properties: { value: { minimum: 1 } }, required: ['value'] }
			};
			const validator = new Validator(schema, '2020-12', false);
			expect(validator.validate({ kind: 'positive', value: 2 }).valid).toBe(true);
			expect(validator.validate({ kind: 'positive', value: 0 }).valid).toBe(false);
			expect(() =>
				SchemaRepresentation.fromJsonSchemaDocument({
					dialect: 'draft-2020-12',
					schema: { ...schema },
					definitions: {}
				})
			).toThrow('Cannot import JSON Schema keyword "if"');
		})
	);
});
