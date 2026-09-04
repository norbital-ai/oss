import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { makeAuthoringApi, type AuthoringOps } from '../src/runtime/collections/authored.js';

/** One direct collection route, with the same single declarative write in every authored context. */
const recordingOps = (calls: Array<string>): AuthoringOps => ({
	allowedCollections: new Set(['payslips', 'approval_request']),
	findMany: () => Effect.succeed([]),
	findFirst: () => Effect.succeed(undefined),
	count: () => Effect.succeed(0),
	findNearest: () => Effect.succeed([]),
	mutate: (collection: string, values: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
		calls.push(`mutate:${collection}:${String(values[0]?.['name'])}`);
		return Effect.void;
	},
	delete: (collection: string, ids: ReadonlyArray<string>) => {
		calls.push(`delete:${collection}:${ids.join(',')}`);
		return Effect.void;
	},
	runAutomation: () => Effect.succeed({ taskId: 'unused' }),
	infer: () => Effect.succeed(undefined),
	readFileAsset: () =>
		Effect.succeed({ id: '', name: '', mimeType: null, size: 0, bytes: new Uint8Array() })
});

type AuthoredDb = {
	readonly db: Readonly<
		Record<
			string,
			{
				readonly mutate: (
					values: ReadonlyArray<Readonly<Record<string, unknown>>>
				) => Effect.Effect<void>;
			}
		>
	>;
};

describe('authored collection operations', () => {
	it.effect('accepts one declarative record through mutate', () => {
		const calls: Array<string> = [];
		const api = makeAuthoringApi(recordingOps(calls)) as AuthoredDb;
		return Effect.gen(function* () {
			yield* api.db['payslips']!.mutate([{ name: 'August' }]);
			expect(calls).toEqual(['mutate:payslips:August']);
		});
	});

	it('makes private platform collections structurally absent even through reflection', () => {
		const api = makeAuthoringApi(recordingOps([]));
		expect(Reflect.get(api.db, 'user')).toBeUndefined();
		expect(Reflect.get(api.db, 'session')).toBeUndefined();
		expect(Reflect.get(api.db, 'automation_run')).toBeUndefined();
		expect(Reflect.get(api.db, 'payslips')).toBeDefined();

		const approval = Reflect.get(api.db, 'approval_request');
		expect(approval).toBeDefined();
		expect(Reflect.get(approval, 'findMany')).toBeTypeOf('function');
		expect(Reflect.get(approval, 'mutate')).toBeUndefined();
	});
});
