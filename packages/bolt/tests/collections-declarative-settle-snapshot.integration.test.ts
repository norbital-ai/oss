import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId, InvocationId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { automation } from '../src/authoring/automations-schema.js';
import { authoredHooks } from '../src/authoring/contracts-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	makeTestDatabase,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/** The fixture as a schema, so the hooks are typed the way a compiled workspace's are. */
interface SettleSnapshotSchema {
	readonly tables: {
		readonly notes: {
			readonly $inferSelect: { readonly id: string; readonly body: string };
			readonly $inferInsert: { readonly id?: string; readonly body: string };
		};
	};
	readonly relations: Record<string, never>;
}

const definition = workspace({
	name: 'declarative-settle-snapshot',
	version: '1.0.0',
	collections: [collection({ name: 'notes', fields: { body: field.string({ required: true }) } })],
	apps: [app({ name: 'notes', label: 'Notes' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'read' },
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'update' }
			]
		})
	]
});

/** The compiled declaration matching the live change handler used only by the settlement race. */
const definitionWithChangeAutomation = workspace({
	...definition,
	automations: [
		automation({
			name: 'on_note_updated',
			trigger: { _tag: 'Change', collection: 'notes', event: 'updated' },
			command: 'on_note_updated',
			policies: []
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('the test database transaction result', () => {
	it('returns rows from its final statement, like both production bindings', async () => {
		const database = await makeTestDatabase();
		try {
			const result = await database.binding.call(
				{
					invocationId: InvocationId.make('transaction-final-statement'),
					effectId: EffectId.make('transaction-final-statement'),
					deadlineEpochMs: Date.now() + 10_000,
					idempotencyKey: 'transaction-final-statement'
				},
				{
					_tag: 'Transaction',
					statements: [
						{ sql: 'select 1 as value', parameters: [] },
						{ sql: 'select 2 as value', parameters: [] }
					]
				},
				new AbortController().signal
			);
			if (result._tag !== 'Success')
				throw new Error(`transaction failed: ${JSON.stringify(result)}`);
			expect(result.value.rows).toEqual([{ value: 2 }]);
		} finally {
			await database.close();
		}
	});
});

describe('declarative settlement under a later writer', () => {
	it('reports an authored defect after commit as a non-retryable settle failure', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					notes: authoredHooks<SettleSnapshotSchema, 'notes'>({
						mutate: {
							perRecord: {
								after: {
									description: 'fails after the transaction is already committed',
									handler: ({ previous }) => {
										if (previous !== undefined) return;
										throw new Error('settlement exploded');
									}
								}
							}
						}
					})
				}
			}
		});

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('defective-declarative-settle'),
						adminSubject,
						'notes',
						[{ body: 'already committed' }],
						false,
						0,
						{}
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		if (outcome._tag !== 'Failure') return;
		expect(outcome.failure).toBeInstanceOf(Collections.MutationPhaseFailure);
		expect(outcome.failure).toMatchObject({
			phase: 'settle',
			step: 'after-hook',
			collection: 'notes',
			retryable: false
		});
		expect((outcome.failure as Collections.MutationPhaseFailure).committed).toHaveLength(1);
		expect(unwrapMutationPhase(outcome.failure)).toMatchObject({
			message: 'settlement exploded'
		});
		expect(await harness.database.query('select body from notes')).toEqual([
			{ body: 'already committed' }
		]);
	}, 60_000);

	it('hands hooks and change events the row captured by writer A before writer B wins', async () => {
		const id = recordId('settle-race-note');
		const afterBodies: Array<string> = [];
		const afterTransitions: Array<Readonly<Record<string, unknown>>> = [];
		const changeBodies: Array<string> = [];
		let armInterleave = false;
		let interleaved = false;
		let database: BoltTestRuntime['database'] | undefined;
		const authored = {
			...emptyAuthoredRuntime,
			hooks: {
				notes: authoredHooks<SettleSnapshotSchema, 'notes'>({
					mutate: {
						perRecord: {
							after: {
								description: 'records the exact row committed by this mutation',
								handler: ({ previous, changes, record }) => {
									if (previous === undefined) return;
									afterBodies.push(String(record.body));
									afterTransitions.push({
										previous: previous.body,
										changes: changes.body,
										record: record.body
									});
								}
							}
						}
					}
				})
			},
			automations: {
				on_note_updated: {
					name: 'on_note_updated',
					policies: [],
					trigger: { _tag: 'Change' as const, collection: 'notes', event: 'updated' as const },
					handler: async (_api: unknown, context: unknown) => {
						const scope =
							typeof context === 'object' && context !== null
								? Reflect.get(context, 'scope')
								: undefined;
						const incoming =
							typeof scope === 'object' && scope !== null
								? Reflect.get(scope, 'incoming_record')
								: undefined;
						if (armInterleave && typeof incoming === 'object' && incoming !== null) {
							armInterleave = false;
							interleaved = true;
							await database?.query('update notes set body = $2 where id = $1', [id, 'writer B']);
						}
						if (typeof incoming === 'object' && incoming !== null)
							changeBodies.push(String(Reflect.get(incoming, 'body')));
						return undefined;
					}
				}
			}
		};

		harness = await makeBoltTestRuntime(definitionWithChangeAutomation, { authored });
		database = harness.database;
		await database.query('insert into notes (id, body) values ($1, $2)', [id, 'original']);

		armInterleave = true;
		const answer = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(
					EffectId.make('writer-a'),
					adminSubject,
					'notes',
					[{ id, body: 'writer A' }],
					false,
					0,
					{}
				);
			})
		);

		expect(interleaved).toBe(true);
		expect(await database.query('select body from notes where id = $1', [id])).toEqual([
			{ body: 'writer B' }
		]);
		expect(afterBodies).toEqual(['writer A']);
		expect(afterTransitions).toEqual([
			{ previous: 'original', changes: 'writer A', record: 'writer A' }
		]);
		expect(answer.records.map((row) => row['body'])).toEqual(['writer A']);
		// The change automation runs in the settle phase with the same committed capture — the
		// interleave that made writer B win had already happened and the event still carries A.
		expect(changeBodies).toEqual(['writer A']);
	}, 60_000);
});
