import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	makeAuthoringApi,
	type AuthoredCollectionOps
} from '../../src/runtime/collections/authored.js';

/**
 * A collection is reached one way: as a property. `db.query.<name>.findMany`, `db.<name>.create`,
 * `db.<name>.update`, and now `db.<name>.mutate` / `db.<name>.delete` for the elevated writes.
 *
 * There used to be a second spelling, `db.mutate(collection, rows)`, declared on the contract and
 * never implemented — the proxy behind `db` answers any string with a per-collection object, so
 * `api.db.mutate` was an object named `mutate` and `yield* api.db.mutate('payslips', rows)` raised
 * `is not iterable` while typechecking cleanly. hr-payroll's whole PERSIST phase was written that
 * way, so every payroll run computed through seven phases and threw on its first write.
 */
const recordingOps = (calls: Array<string>): AuthoredCollectionOps =>
	({
		findMany: () => Effect.succeed([]),
		findFirst: () => Effect.succeed(undefined),
		count: () => Effect.succeed(0),
		findNearest: () => Effect.succeed([]),
		create: () => Effect.succeed({}),
		update: () => Effect.succeed({}),
		delete: (collection: string, id: string) => {
			calls.push(`delete:${collection}:${id}`);
			return Effect.void;
		},
		mutate: (collection: string, payloads: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
			calls.push(`mutate:${collection}:${payloads.length}`);
			return Effect.succeed(payloads);
		},
		approvalFindMany: () => Effect.succeed([]),
		approvalFindFirst: () => Effect.succeed(undefined),
		infer: () => Effect.succeed(undefined),
		readFileAsset: () =>
			Effect.succeed({ id: '', name: '', mimeType: null, size: 0, bytes: new Uint8Array() })
	}) as unknown as AuthoredCollectionOps;

type ElevatedDb = {
	readonly db: Readonly<
		Record<
			string,
			{
				readonly mutate: (
					payloads: ReadonlyArray<Readonly<Record<string, unknown>>>
				) => Effect.Effect<unknown>;
				readonly delete: (identifiers: ReadonlyArray<string>) => Effect.Effect<void>;
			}
		>
	>;
};

describe('the elevated authoring db', () => {
	it.effect('writes through db.mutate(collection, rows) as the contract declares it', () => {
		const calls: Array<string> = [];
		const api = makeAuthoringApi(recordingOps(calls), { elevated: true }) as ElevatedDb;
		return Effect.gen(function* () {
			yield* api.db['payslips']!.mutate([{ a: 1 }, { a: 2 }]);
			expect(calls).toEqual(['mutate:payslips:2']);
		});
	});

	it.effect('deletes every identifier, not the first', () => {
		const calls: Array<string> = [];
		const api = makeAuthoringApi(recordingOps(calls), { elevated: true }) as ElevatedDb;
		return Effect.gen(function* () {
			// `clearRunResults` removes every payslip of a run before recomputing it. Removing one and
			// reporting success is a partial wipe that looks like a clean slate.
			yield* api.db['payslips']!.delete(['a', 'b', 'c']);
			expect(calls).toEqual(['delete:payslips:a', 'delete:payslips:b', 'delete:payslips:c']);
		});
	});

	it('offers neither to an unelevated api, which must obey the row predicate', () => {
		const api = makeAuthoringApi(recordingOps([])) as {
			readonly db: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
		};
		expect(api.db['payslips']?.['mutate']).toBeUndefined();
		expect(api.db['payslips']?.['delete']).toBeUndefined();
	});

	it('has no second way to reach a collection', () => {
		const api = makeAuthoringApi(recordingOps([]), { elevated: true }) as {
			readonly db: Readonly<Record<string, unknown>>;
		};
		// `db.mutate(collection, rows)` was the other spelling. It is gone: `db.mutate` is now just
		// the per-collection object for a collection that happens to be called `mutate`, and calling
		// it as a function is a `TypeError` at the call site rather than a silent second API.
		expect(typeof api.db['mutate']).toBe('object');
	});
});
