import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { makeAuthoringApi, type AuthoringOps } from '../src/runtime/collections/authored.js';

/** One direct collection route, with the same single declared write in every authored context. */
const recordingOps = (calls: Array<string>): AuthoringOps => ({
	allowedCollections: new Set(['payslips', 'approval_request']),
	findMany: () => Effect.succeed([]),
	findFirst: () => Effect.succeed(undefined),
	count: () => Effect.succeed(0),
	findNearest: () => Effect.succeed([]),
	write: (collection, action, inputs) => {
		calls.push(`${action}:${collection}:${String(inputs[0]?.['name'] ?? inputs[0]?.['id'])}`);
		return Effect.succeed({ records: inputs, batch: { changes: [] } });
	},
	history: () => Effect.succeed([]),
	runAutomation: () => Effect.succeed({ taskId: 'unused' }),
	infer: () => Effect.succeed(undefined),
	readFileAsset: () =>
		Effect.succeed({ id: '', name: '', mimeType: null, size: 0, bytes: new Uint8Array() }),
	embed: () => Effect.succeed({ collection: 'payslips', selected: 0, embedded: 0, failed: 0 })
});

type AuthoredCollections = {
	readonly collection: Readonly<
		Record<
			string,
			{
				readonly create: (input: Readonly<Record<string, unknown>>) => Effect.Effect<unknown>;
				readonly delete: (id: string) => Effect.Effect<void>;
			}
		>
	>;
};

describe('authored collection operations', () => {
	it.effect('routes create and delete through the one declared write', () => {
		const calls: Array<string> = [];
		const api = makeAuthoringApi(recordingOps(calls)) as AuthoredCollections;
		return Effect.gen(function* () {
			yield* api.collection['payslips']!.create({ name: 'August' });
			yield* api.collection['payslips']!.delete('p-1');
			expect(calls).toEqual(['create:payslips:August', 'delete:payslips:p-1']);
		});
	});

	it('makes private platform collections structurally absent even through reflection', () => {
		const api = makeAuthoringApi(recordingOps([]));
		expect(Reflect.get(api.db, 'user')).toBeUndefined();
		expect(Reflect.get(api.db, 'session')).toBeUndefined();
		expect(Reflect.get(api.db, 'automation_run')).toBeUndefined();
		expect(Reflect.get(api.db, 'payslips')).toBeDefined();

		// `db` is reads only (RFC §4.1): no write is reachable from it, on any collection.
		const approval = Reflect.get(api.db, 'approval_request');
		expect(approval).toBeDefined();
		expect(Reflect.get(approval, 'findMany')).toBeTypeOf('function');
		for (const method of ['mutate', 'delete', 'create', 'update', 'write'])
			expect(Reflect.get(approval, method)).toBeUndefined();
		expect(Reflect.get(Reflect.get(api.db, 'payslips'), 'create')).toBeUndefined();
	});
});
