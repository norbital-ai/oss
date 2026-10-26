import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Instant } from '@norbital-ai/std/date';
import { build, schema, store, table } from '../src/index.ts';
import { database, run, script } from './support.ts';

const declaration = schema({
	owner: table({ key: ['id'], fields: { id: { kind: 'text' }, url: { kind: 'text' } } }),
	lease: table({
		key: ['tenant'],
		fields: {
			tenant: { kind: 'text' },
			host: { kind: 'text' },
			gen: { kind: 'int' },
			done: { kind: 'instant', optional: true }
		}
	}),
	artifact: table({
		key: ['tenant', 'commit'],
		fields: { tenant: { kind: 'text' }, commit: { kind: 'text' }, at: { kind: 'text' } }
	}),
	pin: table({
		key: ['tenant', 'commit'],
		fields: { tenant: { kind: 'text' }, commit: { kind: 'text' } }
	}),
	entry: table({
		key: ['tenant', 'key'],
		fields: {
			tenant: { kind: 'text' },
			key: { kind: 'text' },
			bytes: { kind: 'int' },
			answer: { kind: 'json' }
		}
	}),
	measurement: table({
		key: ['tenant', 'metric', 'at', 'source'],
		fields: {
			tenant: { kind: 'text' },
			metric: { kind: 'text' },
			at: { kind: 'instant' },
			source: { kind: 'text' },
			value: { kind: 'number' }
		}
	})
});
const db = store(declaration);
const fresh = Effect.gen(function* () {
	const pg = yield* database;
	yield* script(pg, (yield* build(declaration)).join(';\n'));
	return run(pg);
});

it.effect('fences each row of a set update and resolves native joins and unions', () =>
	Effect.gen(function* () {
		const execute = yield* fresh;
		const done = Instant('2026-01-01T00:00:00.000Z');
		yield* execute(
			yield* db.create('owner', [
				{ id: 'a', url: 'A' },
				{ id: 'b', url: 'B' }
			])
		);
		yield* execute(
			yield* db.create('lease', [
				{ tenant: 'acme', host: 'a', gen: 2, done },
				{ tenant: 'preview', host: 'a', gen: 3, done }
			])
		);
		const written = yield* execute(
			yield* db.updateMany('lease', [
				{ key: { tenant: 'acme' }, match: { host: 'a', gen: 2 }, set: { host: 'b' } },
				{ key: { tenant: 'preview' }, match: { host: 'a', gen: 2 }, set: { host: 'b' } }
			])
		);
		expect(written).toEqual([{ tenant: 'acme', host: 'b', gen: 2, done }]);
		expect((yield* execute(yield* db.get('lease', { tenant: 'preview' })))?.host).toBe('a');
		expect(
			yield* execute(
				yield* db.related('lease', {
					to: 'owner',
					on: { host: 'id' },
					where: { tenant: { eq: 'acme' } },
					select: { url: true },
					limit: 1
				})
			)
		).toEqual([{ id: 'b', url: 'B' }]);
		expect(
			[
				...(yield* execute(
					yield* db.union([
						{ table: 'owner', field: 'id' },
						{ table: 'lease', field: 'host' }
					])
				))
			].sort()
		).toEqual(['a', 'b']);
	})
);

it.effect(
	'retains ranked rows, protects joined records and admits group budgets in the database',
	() =>
		Effect.gen(function* () {
			const execute = yield* fresh;
			yield* execute(
				yield* db.create(
					'artifact',
					[1, 2, 3].map((n) => ({ tenant: 'acme', commit: String(n), at: String(n) }))
				)
			);
			yield* execute(
				yield* db.delete('artifact', {
					where: { tenant: { eq: 'acme' } },
					keep: { orderBy: [{ at: 'desc' }, 'commit'], limit: 1 }
				})
			);
			yield* execute(yield* db.create('pin', { tenant: 'acme', commit: '3' }));
			expect(
				yield* execute(
					yield* db.delete('artifact', {
						where: { tenant: { eq: 'acme' } },
						absent: { table: 'pin', on: { tenant: 'tenant', commit: 'commit' } }
					})
				)
			).toEqual([]);
			yield* execute(yield* db.delete('pin', { key: { tenant: 'acme', commit: '3' } }));
			expect(
				yield* execute(
					yield* db.delete('artifact', {
						where: { tenant: { eq: 'acme' } },
						absent: { table: 'pin', on: { tenant: 'tenant', commit: 'commit' } }
					})
				)
			).toEqual([{ tenant: 'acme', commit: '3' }]);
			const put = (key: string, bytes: number) =>
				db.upsert(
					'entry',
					{ tenant: 'acme', key, bytes, answer: null },
					{ limits: [{ by: ['tenant'], sum: 'bytes', max: 10 }] }
				);
			yield* execute(yield* put('a', 6));
			expect(yield* execute(yield* put('b', 6))).toEqual([]);
			yield* execute(yield* put('a', 4));
			yield* execute(yield* put('b', 6));
			expect(
				(yield* execute(yield* db.get('entry', { tenant: 'acme', key: 'a' })))?.answer
			).toBeNull();
			yield* execute(
				yield* db.update('entry', {
					key: { tenant: 'acme', key: 'a' },
					set: { answer: { $patch: { payload: 'ok' } } }
				})
			);
			expect(
				(yield* execute(yield* db.get('entry', { tenant: 'acme', key: 'a' })))?.answer
			).toEqual({ payload: 'ok' });
		})
);

it.effect(
	'sums writers before bucket peaks and carries the latest gauge independently per source',
	() =>
		Effect.gen(function* () {
			const execute = yield* fresh,
				start = Date.UTC(2026, 0, 1),
				step = 300_000;
			const at = (offset: number) => Instant(new Date(start + offset * step).toISOString());
			yield* execute(
				yield* db.create('measurement', [
					{ tenant: 'acme', metric: 'memory', at: at(0), source: 'a', value: 100 },
					{ tenant: 'acme', metric: 'memory', at: at(0), source: 'b', value: 20 },
					{ tenant: 'acme', metric: 'memory', at: at(1), source: 'a', value: 40 },
					{ tenant: 'acme', metric: 'memory', at: at(1), source: 'b', value: 10 },
					{ tenant: 'acme', metric: 'files', at: at(0), source: 'a', value: 100 },
					{ tenant: 'acme', metric: 'files', at: at(0), source: 'b', value: 50 },
					{ tenant: 'acme', metric: 'files', at: at(1), source: 'a', value: 0 }
				])
			);
			expect(
				yield* execute(
					yield* db.rollup('measurement', {
						by: ['metric'],
						time: 'at',
						value: 'value',
						stepMillis: step * 2,
						where: { metric: { eq: 'memory' } }
					})
				)
			).toEqual([{ key: { metric: 'memory' }, at: start, peak: 120, total: 170, latest: 50 }]);
			expect(
				yield* execute(
					yield* db.rollup('measurement', {
						by: ['metric'],
						time: 'at',
						value: 'value',
						stepMillis: step * 2,
						combine: 'max',
						where: { metric: { eq: 'memory' } }
					})
				)
			).toEqual([{ key: { metric: 'memory' }, at: start, peak: 100, total: 140, latest: 40 }]);
			const gauges = {
				by: ['metric'],
				time: 'at',
				value: 'value',
				latestPer: ['source'],
				where: { metric: { eq: 'files' } }
			} as const;
			expect(yield* execute(yield* db.rollup('measurement', gauges))).toEqual([
				{ key: { metric: 'files' }, at: null, peak: 50, total: 50, latest: 50 }
			]);
			expect(
				(yield* execute(
					yield* db.rollup('measurement', {
						...gauges,
						carry: { from: at(0), until: at(2), stepMillis: step }
					})
				)).map((row) => [row.at, row.peak])
			).toEqual([
				[start, 150],
				[start + step, 50],
				[start + step * 2, 50]
			]);
		})
);
