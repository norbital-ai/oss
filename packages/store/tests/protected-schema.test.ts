import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { schema, schemaObjects, table } from '../src/index.ts';

it.effect('keeps custom hidden vector columns and their HNSW index in the Store schema', () =>
	Effect.gen(function* () {
		const declaration = schema({
			document: table({
				fields: { embedding: { kind: 'vector', dim: 3, metric: 'l2' } },
				search: {
					text: [],
					indexes: {
						derived: { dim: 2, metric: 'cosine' },
						stored: { field: 'embedding', dim: 3, metric: 'l2' }
					}
				}
			})
		});
		const objects = yield* schemaObjects(declaration);
		expect(objects.find((object) => object.id === 'extension:vector')?.create).toEqual([
			'create extension if not exists vector'
		]);
		expect(objects.find((object) => object.id === 'column:document.$idx_derived')?.create).toEqual([
			'alter table "document" add column "$idx_derived" vector(2)'
		]);
		expect(
			objects.some(
				(object) =>
					object.rank === 'index' &&
					object.create.some((sql) => sql.includes('using hnsw ("$idx_derived" vector_cosine_ops)'))
			)
		).toBe(true);
		expect(objects.some((object) => object.id === 'column:document.$idx_stored')).toBe(false);
		const mismatch = schema({
			document: table({
				fields: declaration.tables.document.fields,
				search: { text: [], indexes: { stored: { field: 'embedding', dim: 2, metric: 'l2' } } }
			})
		});
		expect((yield* Effect.flip(schemaObjects(mismatch))).message).toContain(
			"must match its vector field 'embedding'"
		);
	})
);
