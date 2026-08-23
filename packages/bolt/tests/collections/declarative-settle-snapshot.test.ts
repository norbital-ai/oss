import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId, InvocationId, success, type TransportRequest } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	makeTestDatabase,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

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
	it('hands hooks and change events the row captured by writer A before writer B wins', async () => {
		const id = recordId('settle-race-note');
		const afterBodies: Array<string> = [];
		let armInterleave = false;
		let interleaved = false;
		let database: BoltTestRuntime['database'] | undefined;
		const authored = {
			...emptyAuthoredRuntime,
			hooks: {
				notes: {
					update: {
						perRecord: {
							after: {
								description: 'records the exact row committed by this mutation',
								handler: (context: unknown) => {
									const record = (context as { readonly record: Record<string, unknown> }).record;
									afterBodies.push(String(record['body']));
								}
							}
						}
					}
				}
			},
			automations: {
				on_note_updated: {
					name: 'on_note_updated',
					trigger: { _tag: 'Change' as const, collection: 'notes', event: 'updated' as const },
					handler: () => undefined
				}
			}
		};

		harness = await makeBoltTestRuntime(definition, {
			authored,
			transport: {
				call: async (_metadata: unknown, request: TransportRequest) => {
					if (armInterleave && request._tag === 'Publish') {
						armInterleave = false;
						interleaved = true;
						await database?.query('update notes set body = $2 where id = $1', [id, 'writer B']);
					}
					return success({ delivered: 1 });
				}
			} as never
		});
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
					{ declarative: true }
				);
			})
		);

		expect(interleaved).toBe(true);
		expect(await database.query('select body from notes where id = $1', [id])).toEqual([
			{ body: 'writer B' }
		]);
		expect(afterBodies).toEqual(['writer A']);
		expect(answer.map((row) => row['body'])).toEqual(['writer A']);

		const tasks = await database.query(
			'select input from bolt_task where command = $1 order by effect_id',
			['automations.on_note_updated']
		);
		const incomingBodies = tasks.map((task) => {
			const input = task['input'] as { readonly scope?: { readonly incoming_record?: unknown } };
			const incoming = input.scope?.incoming_record as Record<string, unknown> | undefined;
			return String(incoming?.['body']);
		});
		expect(incomingBodies).toEqual(['writer A']);
	}, 60_000);
});
