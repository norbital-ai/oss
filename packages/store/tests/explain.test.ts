import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { build, schemaObjects, store } from '../src/index.ts';
import { shop } from './fixture.ts';
import { database, exec, script } from './support.ts';

describe('read query plans', () => {
	it.effect('keeps declared json path and relation indexes usable by compiled reads', () =>
		Effect.gen(function* () {
			const pg = yield* database;
			yield* script(pg, `${(yield* build(shop)).join(';\n')};`);
			// A tiny fixture otherwise prefers a sequential scan, hiding a mismatched index expression.
			yield* script(pg, 'set enable_seqscan = off');
			const db = store(shop);
			const objects = yield* schemaObjects(shop);
			const pathIndex = objects.find(
				(object) =>
					object.rank === 'index' &&
					object.table === 'order' &&
					object.create.some((sql) => sql.includes('#>>'))
			);
			const relationIndex = objects.find(
				(object) =>
					object.id.startsWith('index:line.') &&
					object.table === 'line' &&
					object.deps.length === 1 &&
					object.deps[0] === 'order' &&
					object.create.some((sql) => /^create index /.test(sql))
			);
			if (pathIndex === undefined || relationIndex === undefined)
				return yield* Effect.die('fixture index missing');
			const pathRead = yield* db.read('order', {
				where: { address: { city: { eq: 'Seoul' } } },
				select: { number: true },
				all: true
			});
			const pathPlan = JSON.stringify(
				yield* exec(pg)({
					text: `EXPLAIN (FORMAT JSON, COSTS OFF) ${pathRead.sql.text}`,
					params: pathRead.sql.params
				})
			);
			expect(pathPlan).toContain(pathIndex.id.slice('index:order.'.length));
			const relationRead = yield* db.read('order', {
				where: { number: { eq: 'SO-1' } },
				with: { lines: { select: { sku: true }, limit: 10 } },
				limit: 1
			});
			const relationPlan = JSON.stringify(
				yield* exec(pg)({
					text: `EXPLAIN (FORMAT JSON, COSTS OFF) ${relationRead.sql.text}`,
					params: relationRead.sql.params
				})
			);
			expect(relationPlan).toContain(relationIndex.id.slice('index:line.'.length));
			expect(relationPlan).toContain('SubPlan');
		})
	);
});
