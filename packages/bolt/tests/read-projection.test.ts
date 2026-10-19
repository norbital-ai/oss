import { describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import type { Bindings } from '../src/engine/contracts.ts';
import type { ReadIR } from '../src/protocol/ir-types.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { projectionContext } from '../src/engine/query/read-projector.ts';
import { applyReadProjection, assertReadSubset } from '../src/engine/query/projection.ts';

describe('native JSON read projection', () => {
	it('withholds fields and rows while preserving actual identities and order', () => {
		const original = [
			{ id: 'a', public: 0, private: 100 },
			{ id: 'b', public: false },
			{ id: 'c', public: '' }
		];
		expect(() =>
			assertReadSubset(original, [
				{ id: 'a', public: 0 },
				{ id: 'c', public: '' }
			])
		).not.toThrow();
		expect(() => assertReadSubset(original, [])).not.toThrow();
	});
	it('rejects additions, changed values, removed identities, duplication and reordering', () => {
		const original = [
			{ id: 'a', amount: 0 },
			{ id: 'b', amount: 2 }
		];
		for (const output of [
			[{ id: 'a', amount: 1 }],
			[{ amount: 0 }],
			[{ id: 'a', extra: true }],
			[{ id: 'b' }, { id: 'a' }],
			[{ id: 'a' }, { id: 'a' }],
			[{ id: 'unknown' }]
		])
			expect(() => assertReadSubset(original, output)).toThrow();
	});
	it('protects nonprojected columns and supports complete withholding of selected JSON', () => {
		const original = {
			id: 'native',
			revision: 3,
			facts: { salary: 0, private: false },
			label: 'original'
		};
		expect(applyReadProjection(original, { facts: { salary: 0 } }, ['facts'])).toEqual({
			...original,
			facts: { salary: 0 }
		});
		expect(applyReadProjection(original, {}, ['facts'])).toEqual({
			id: 'native',
			revision: 3,
			label: 'original'
		});
		for (const output of [{ id: 'replacement' }, { revision: 4 }, { extra: true }])
			expect(() => applyReadProjection(original, output, ['facts'])).toThrow();
		expect(original.facts).toEqual({ salary: 0, private: false });
	});
	it('preserves null, false, zero and empty text distinctly', () => {
		for (const value of [null, false, 0, '']) {
			expect(() => assertReadSubset(value, value)).not.toThrow();
			for (const other of [null, false, 0, ''].filter((other) => other !== value))
				expect(() => assertReadSubset(value, other)).toThrow();
		}
	});
});

describe('trusted projection context batching', () => {
	const bindings: Bindings = {
		now: '2026-10-11T00:00:00Z',
		today: '2026-10-11',
		tz: 'UTC',
		params: {}
	};
	it.effect('coalesces 100 concurrent captures, preserves order and limits captured columns', () =>
		Effect.gen(function* () {
			const batches: (readonly ReadIR[])[] = [];
			const context = projectionContext({
				run: (reads, reader, b) =>
					Effect.sync(() => {
						expect(reader).toEqual({ as: 'workspace' });
						expect(b).toBe(bindings);
						batches.push(reads);
						return reads.map((read) => {
							if (read.kind !== 'get') throw new Error('unexpected read');
							return { id: read.id, revision: 2, doc: { public: read.id }, secret: true };
						});
					})
			});
			const values = yield* Effect.all(
				Array.from({ length: 100 }, (_, i) =>
					context('orders', String(i), ['doc'], undefined, bindings)
				),
				{ concurrency: 'unbounded' }
			);
			expect(batches).toHaveLength(1);
			expect(batches[0]).toHaveLength(100);
			expect(values).toEqual(
				Array.from({ length: 100 }, (_, i) => ({
					id: String(i),
					revision: 2,
					doc: { public: String(i) }
				}))
			);
		})
	);
	it.effect(
		'keeps binding objects and resolver scopes isolated, and captures actual historical revisions',
		() =>
			Effect.gen(function* () {
				const batches: { reads: readonly ReadIR[]; bindings: Bindings }[] = [];
				const raw = {
					run: (reads: readonly ReadIR[], _reader: unknown, b: Bindings) =>
						Effect.sync(() => {
							batches.push({ reads, bindings: b });
							return reads.map(() => null);
						})
				};
				const context = projectionContext(raw),
					other = projectionContext(raw),
					changed = { ...bindings };
				yield* Effect.all(
					[
						context('orders', 'a', ['doc'], 3, bindings),
						context('orders', 'b', ['doc'], 4, bindings),
						context('orders', 'c', ['doc'], undefined, changed),
						other('orders', 'd', ['doc'], undefined, bindings)
					],
					{ concurrency: 'unbounded' }
				);
				expect(batches).toHaveLength(3);
				expect(batches.find((batch) => batch.reads.length === 2)?.reads).toEqual([
					{
						kind: 'history',
						collection: 'orders',
						id: 'a',
						at: { _tag: 'Revision', revision: 3 },
						full: true
					},
					{
						kind: 'history',
						collection: 'orders',
						id: 'b',
						at: { _tag: 'Revision', revision: 4 },
						full: true
					}
				]);
				expect(batches.filter((batch) => batch.bindings === changed)).toHaveLength(1);
			})
	);
	it.effect('preserves unavailable captures and the original error for every failed request', () =>
		Effect.gen(function* () {
			const missing = projectionContext({ run: () => Effect.succeed([null]) });
			expect(yield* missing('orders', 'a', ['doc'], undefined, bindings)).toBeNull();
			const failure = BoltError.make('forbidden', 'deliver', 'capture refused');
			let calls = 0;
			const context = projectionContext({
				run: () =>
					Effect.suspend(() => {
						calls++;
						return Effect.fail(failure);
					})
			});
			const answers = yield* Effect.all(
				['a', 'b'].map((id) => Effect.result(context('orders', id, ['doc'], undefined, bindings))),
				{ concurrency: 'unbounded' }
			);
			expect(calls).toBe(1);
			for (const answer of answers) {
				expect(Result.isFailure(answer)).toBe(true);
				if (Result.isFailure(answer)) expect(answer.failure).toBe(failure);
			}
		})
	);
});
