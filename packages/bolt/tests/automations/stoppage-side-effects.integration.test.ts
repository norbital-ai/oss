import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { automation } from '../../src/authoring/automations-schema.js';
import {
	emptyAuthoredRuntime,
	guardAuthoringOps,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	type AuthoringOps
} from '../../src/runtime/collections/authored.js';
import * as Automations from '../../src/runtime/automations/automations.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { AI, Files } from '../../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace
} from '../support/bolt-test-layer.js';

// The guard fails with `AutomationStopped`, so `guardAuthoringOps` widens the error channel; the
// declared type has to say so or the helper claims operations that can never stop.
const guardedOperations = (
	calls: Array<string>,
	guards: Array<string>
): AuthoringOps<Automations.AutomationStopped> => {
	const record = <A>(operation: string, result: A) =>
		Effect.sync(() => {
			calls.push(operation);
			return result;
		});
	const ops: AuthoringOps = {
		allowedCollections: new Set(['people', 'approval_request']),
		findMany: () => record('findMany', []),
		findFirst: () => record('findFirst', undefined),
		count: () => record('count', 0),
		findNearest: () => Effect.succeed([]),
		mutate: () => record('mutate', undefined),
		runAutomation: () => record('runAutomation', { taskId: 'child' }),
		infer: () => record('infer', {}),
		readFileAsset: () =>
			record('readFileAsset', {
				id: 'file',
				name: 'file',
				mimeType: null,
				size: 0,
				bytes: new Uint8Array()
			})
	};
	return guardAuthoringOps(ops, (operation) => {
		guards.push(operation);
		return Effect.fail(Automations.AutomationStopped.before('stopped-run', operation));
	});
};

describe('automation stoppage facility guard', () => {
	it('gives sequential direct authored creates distinct replay-stable identities', async () => {
		const harness = await makeBoltTestRuntime();
		try {
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					const ai = yield* AI.Service;
					const files = yield* Files.Service;
					const automations = yield* Automations.Service;
					const ops = makeBoundAuthoringOps(
						EffectId.make('direct-authored-writes'),
						adminSubject,
						collections,
						ai,
						files,
						automations
					);
					yield* ops.mutate('people', { name: 'First' });
					yield* ops.mutate('people', { name: 'Second' });
				})
			);
			expect(await harness.database.query('select name from people order by name')).toEqual([
				{ name: 'First' },
				{ name: 'Second' }
			]);
			const writes = harness.database.calls
				.map(({ effectId }) => String(effectId))
				.filter((effectId) =>
					/^direct-authored-writes:hook:mutate:people:root:\d+$/u.test(effectId)
				);
			expect(new Set(writes)).toEqual(
				new Set([
					'direct-authored-writes:hook:mutate:people:root:1',
					'direct-authored-writes:hook:mutate:people:root:2'
				])
			);
		} finally {
			await harness.dispose();
		}
	}, 60_000);

	it('refuses every authored side-effect surface before its underlying operation runs', async () => {
		const calls: Array<string> = [];
		const guards: Array<string> = [];
		const ops = guardedOperations(calls, guards);
		const attempts = [
			ops.mutate('people', { id: recordId('mutate'), name: 'mutate' }),
			ops.infer({ schema: Schema.Struct({}), prompt: 'infer', model: 'test/language' }),
			ops.readFileAsset({
				storage_key: 'file',
				file_name: 'file',
				file_size: 0,
				mime_type: 'application/octet-stream'
			}),
			ops.runAutomation('child', {}, undefined)
		];

		for (const attempt of attempts) {
			const outcome = await Effect.runPromise(Effect.result(attempt));
			expect(outcome._tag).toBe('Failure');
			expect(outcome._tag === 'Failure' ? outcome.failure : undefined).toBeInstanceOf(
				Automations.AutomationStopped
			);
		}

		expect(calls).toEqual([]);
		expect(guards).toEqual(['db.people.mutate', 'ai.infer', 'files.read', 'automations.child.run']);
	});

	it('observes a stop between progress and the next authored write', async () => {
		const personId = recordId('stopped-write');
		type TestAuthoringApi = Readonly<{
			db: Readonly<{
				people: Readonly<{
					mutate: (values: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
				}>;
			}>;
		}>;
		const declaration = automation({
			name: 'rebuild',
			trigger: { _tag: 'Schedule', cron: '* * * * *' },
			command: 'rebuild',
			policies: ['admin']
		});
		const definition = testWorkspace({ automations: [declaration] });
		const harness = await makeBoltTestRuntime(definition, { authored: emptyAuthoredRuntime });
		try {
			const taskId = 'stopped-rebuild';
			await harness.database.query(
				`insert into bolt_task (command, input, effect_id) values ($1, $2::jsonb, $3)`,
				[
					'automations.rebuild',
					JSON.stringify({
						args: {},
						bolt_run_as: {
							userId: 'automation:rebuild',
							tenantId: 'test-tenant',
							teamPath: [],
							policies: ['admin'],
							admin: false
						}
					}),
					taskId
				]
			);
			harness.database.forget();
			const outcome = await harness.runtime.runPromise(
				Effect.gen(function* () {
					const automations = yield* Automations.Service;
					const guard = Automations.stoppageGuard(
						automations,
						EffectId.make('stopped-rebuild:1'),
						taskId
					);
					// The prior authored boundary saw a live task, just as the 0.9 progress emission did in
					// Reclamation. The next observation must not reuse that answer after stoppage.
					yield* guard('progress');
					yield* automations.stop(harness.effectId('stop-live-run'), 'rebuild', taskId);
					const collections = yield* Collections.Service;
					const ai = yield* AI.Service;
					const files = yield* Files.Service;
					const ops = guardAuthoringOps(
						makeBoundAuthoringOps(
							EffectId.make('stopped-rebuild:1'),
							{
								userId: 'automation:rebuild',
								tenantId: 'test-tenant',
								teamPath: [],
								policies: ['admin'],
								admin: false
							},
							collections,
							ai,
							files,
							automations
						),
						guard
					);
					const api = makeAuthoringApi(ops) as TestAuthoringApi;
					return yield* Effect.result(
						api.db.people.mutate({ id: personId, name: 'must not exist' })
					);
				})
			);
			expect(outcome._tag).toBe('Failure');
			expect(outcome._tag === 'Failure' ? outcome.failure : undefined).toBeInstanceOf(
				Automations.AutomationStopped
			);

			expect(
				await harness.database.query('select id from people where id = $1', [personId])
			).toEqual([]);
			expect(
				await harness.database.query('select status, error from bolt_task where effect_id = $1', [
					taskId
				])
			).toEqual([
				{
					status: 'stopped',
					error: 'stopped'
				}
			]);
			const observations = harness.database.calls
				.map(({ effectId }) => String(effectId))
				.filter((effectId) => effectId.includes(':stoppage:'));
			expect(observations).toHaveLength(2);
			expect(new Set(observations).size).toBe(observations.length);
		} finally {
			await harness.dispose();
		}
	}, 60_000);
});
