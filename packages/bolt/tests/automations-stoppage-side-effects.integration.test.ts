import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { automation } from '../src/authoring/automations-schema.js';
import {
	emptyAuthoredRuntime,
	guardAuthoringOps,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	type AuthoredRuntime,
	type AuthoringOps
} from '../src/runtime/collections/authored.js';
import * as Automations from '../src/runtime/automations/automations.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { AI, Files } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace
} from './support/bolt-test-layer.js';

const peopleAuthored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: { people: { create: { input: { columns: { name: true, team: true } } } } }
};

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
		write: () => record('write', { records: [], batch: { changes: [] } }),
		history: () => record('history', []),
		runAutomation: () => record('runAutomation', { taskId: 'child' }),
		infer: () => record('infer', {}),
		readFileAsset: () =>
			record('readFileAsset', {
				id: 'file',
				name: 'file',
				mimeType: null,
				size: 0,
				bytes: new Uint8Array()
			}),
		embed: () => record('embed', { collection: 'people', selected: 0, embedded: 0, failed: 0 })
	};
	return guardAuthoringOps(ops, (operation) => {
		guards.push(operation);
		return Effect.fail(Automations.AutomationStopped.before('stopped-run', operation));
	});
};

describe('automation stoppage facility guard', () => {
	it('gives sequential direct authored creates distinct replay-stable identities', async () => {
		const harness = await makeBoltTestRuntime(undefined, { authored: peopleAuthored });
		try {
			await harness.runtime.runPromise(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					const ai = yield* AI.Service;
					const files = yield* Files.Service;
					const ops = makeBoundAuthoringOps(
						EffectId.make('direct-authored-writes'),
						adminSubject,
						collections,
						ai,
						files
					);
					yield* ops.write('people', 'create', [{ name: 'First' }]);
					yield* ops.write('people', 'create', [{ name: 'Second' }]);
				})
			);
			expect(await harness.database.query('select name from people order by name')).toEqual([
				{ name: 'First' },
				{ name: 'Second' }
			]);
			const writes = harness.database.calls
				.map(({ effectId }) => String(effectId))
				.filter((effectId) => /^direct-authored-writes:write:create:people:\d+$/u.test(effectId));
			expect(new Set(writes)).toEqual(
				new Set([
					'direct-authored-writes:write:create:people:1',
					'direct-authored-writes:write:create:people:2'
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
			ops.write('people', 'create', [{ name: 'create' }]),
			ops.infer({ schema: Schema.Struct({}), prompt: 'infer', model: 'test/language' }),
			ops.readFileAsset({
				storage_key: 'file',
				file_name: 'file',
				file_size: 0,
				mime_type: 'application/octet-stream'
			}),
			ops.runAutomation('child', {}, undefined),
			ops.embed({ collection: 'people' })
		];

		for (const attempt of attempts) {
			const outcome = await Effect.runPromise(Effect.result(attempt));
			expect(outcome._tag).toBe('Failure');
			expect(outcome._tag === 'Failure' ? outcome.failure : undefined).toBeInstanceOf(
				Automations.AutomationStopped
			);
		}

		expect(calls).toEqual([]);
		expect(guards).toEqual([
			'collection.people.create',
			'ai.infer',
			'files.read',
			'automations.child.run',
			'ai.embed.people'
		]);
	});

	it('observes a stop between progress and the next authored write', async () => {
		const personId = recordId('stopped-write');
		type TestAuthoringApi = Readonly<{
			collection: Readonly<{
				people: Readonly<{
					create: (input: Readonly<Record<string, unknown>>) => Effect.Effect<unknown>;
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
		const harness = await makeBoltTestRuntime(definition, { authored: peopleAuthored });
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
							files
						),
						guard
					);
					const api = makeAuthoringApi(ops) as TestAuthoringApi;
					return yield* Effect.result(
						api.collection.people.create({ id: personId, name: 'must not exist' })
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
