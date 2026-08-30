import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Api } from '../../src/authoring/contracts-schema.js';
import { vectorDistance } from '../../src/runtime/persistence.js';

/**
 * That a vector search is checked at compile time, not refused at run time.
 *
 * The predecessor took `column: string`, `probe: number[]` and `metric: string`, so a typo, a text
 * column, a probe of the wrong shape and an invented metric all compiled — and were refused by a
 * tenant's database after it had already been asked to do the query's work. Every
 * `@ts-expect-error` below fails `tsc -p tests/tsconfig.json`, which `pnpm lint` runs, the moment
 * one of those stops being rejected; and this file stops compiling at all if a shape that should be
 * admitted starts being rejected.
 *
 * The assertions live in a function nobody calls because they are assertions about types: running
 * them would prove nothing and would need a database to prove it against. The schema is written by
 * hand rather than generated, because what is under test is the type the compiler emits *into*.
 */
interface TestSchema {
	readonly tables: {
		readonly photo_evidence: {
			$inferSelect: {
				id: string;
				sha256: string;
				perceptual_embedding: number[];
				captured_at: Date;
			};
			$inferInsert: { sha256: string; perceptual_embedding: number[] };
		};
	};
	readonly relations: { readonly photo_evidence: Record<string, never> };
}

declare const photos: Api<TestSchema>['db']['photo_evidence'];
declare const probe: number[];

const admitted = () => {
	const nearest = photos.findNearest({
		column: 'perceptual_embedding',
		probe,
		metric: 'l2',
		maxDistance: 4,
		limit: 50,
		columns: { id: true, sha256: true },
		// Excluding the probe's own row is the ordinary where clause. There is no `excludeIds`,
		// because a filter that could exclude by id and by nothing else was a second vocabulary for a
		// question `where` already answers.
		where: { id: { ne: 'self' } }
	});
	return nearest;
};

/** The measured distance rides beside the record, and the record still narrows by `columns`. */
type NearestRow =
	ReturnType<typeof admitted> extends Effect.Effect<infer Rows, infer _E, infer _R>
		? Rows extends ReadonlyArray<infer Row>
			? Row
			: never
		: never;

const narrowed = () => {
	const distance: number = null as unknown as NearestRow['distance'];
	const sha256: string = null as unknown as NearestRow['sha256'];
	// @ts-expect-error `columns` asked for `id` and `sha256`; a column it did not ask for is absent.
	const captured: Date = null as unknown as NearestRow['captured_at'];
	return { distance, sha256, captured };
};

const refused = () => {
	photos.findNearest({
		// @ts-expect-error `sha256` is text; only a vector column can be measured against.
		column: 'sha256',
		probe
	});
	photos.findNearest({
		// @ts-expect-error `captured_at` is a timestamp, not a vector.
		column: 'captured_at',
		probe
	});
	photos.findNearest({
		// @ts-expect-error there is no such column at all.
		column: 'perceptual_embeddings',
		probe
	});
	photos.findNearest({
		column: 'perceptual_embedding',
		// @ts-expect-error a probe is the column's own value, not a string.
		probe: 'not-a-vector'
	});
	photos.findNearest({
		column: 'perceptual_embedding',
		probe,
		// @ts-expect-error the accepted metrics are the closed set pgvector implements.
		metric: 'manhattan'
	});
	photos.findNearest({
		column: 'perceptual_embedding',
		probe,
		// @ts-expect-error the distance is the ordering; a second one would discard the answer.
		orderBy: { captured_at: 'desc' }
	});
	photos.findNearest({
		column: 'perceptual_embedding',
		probe,
		// @ts-expect-error nearest-neighbour reads do not hydrate relations.
		with: { evidence_job: true }
	});
	photos.findNearest({
		column: 'perceptual_embedding',
		probe,
		// @ts-expect-error vector probes do not also accept collection text search.
		search: 'ignored'
	});
	photos.findNearest({
		column: 'perceptual_embedding',
		probe,
		// @ts-expect-error root offset pagination is not part of the nearest surface.
		offset: 10
	});
};

describe('vector search', () => {
	it('binds the probe as one parameter and casts it, rather than interpolating it', () => {
		const distance = vectorDistance(sql`"perceptual_embedding"`, '<->', [0.5, 0.25]);
		const query = distance.getSQL().toQuery({
			escapeName: (name: string) => `"${name}"`,
			escapeParam: (index: number) => `$${index + 1}`,
			escapeString: (value: string) => `'${value}'`
		});
		expect(query.sql).toContain('<->');
		expect(query.sql).toContain('::vector');
		// The probe never reaches the statement text: a driver binds a JavaScript array as a Postgres
		// array, which `vector` is not, so the value travels as one bound parameter in pgvector's own
		// literal text form.
		expect(query.sql).not.toContain('0.25');
		expect(query.params).toEqual(['[0.5,0.25]']);
	});

	it('keeps the compile-time assertions in the build', () => {
		// `admitted` and `refused` are never called; naming them here is what stops an unused-symbol
		// rule from deleting the assertions this file exists for.
		expect(typeof admitted).toBe('function');
		expect(typeof narrowed).toBe('function');
		expect(typeof refused).toBe('function');
	});
});
