import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { makeAuthoringApi, type AuthoringOps } from '../../src/runtime/collections/authored.js';

/** One direct collection route, with the same single declarative write in every authored context. */
const recordingOps = (calls: Array<string>): AuthoringOps => ({
	findMany: () => Effect.succeed([]),
	findFirst: () => Effect.succeed(undefined),
	count: () => Effect.succeed(0),
		findNearest: () => Effect.succeed([]),
	mutate: (collection: string, values: Readonly<Record<string, unknown>>) => {
		calls.push(`mutate:${collection}:${String(values['name'])}`);
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
				readonly mutate: (values: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
			}
		>
	>;
};

describe('authored collection operations', () => {
	it.effect('accepts one declarative record through mutate', () => {
		const calls: Array<string> = [];
		const api = makeAuthoringApi(recordingOps(calls)) as AuthoredDb;
		return Effect.gen(function* () {
			yield* api.db['payslips']!.mutate({ name: 'August' });
			expect(calls).toEqual(['mutate:payslips:August']);
		});
	});
});
