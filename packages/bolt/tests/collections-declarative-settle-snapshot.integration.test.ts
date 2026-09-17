import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId, InvocationId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { automation } from '../src/authoring/automations-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	makeTestDatabase,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

const notesModule: AuthoredRuntime['collections'] = {
	notes: { update: { input: { columns: { body: true } } } }
};

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
	it('hands the caller and the change events the row captured by writer A before writer B wins', async () => {
		const id = recordId('settle-race-note');
		const changeBodies: Array<string> = [];
		let armInterleave = false;
		let interleaved = false;
		let database: BoltTestRuntime['database'] | undefined;
		const authored: AuthoredRuntime = {
			...emptyAuthoredRuntime,
			collections: notesModule,
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
				return yield* collections.write(EffectId.make('writer-a'), adminSubject, [
					{ collection: 'notes', action: 'update', inputs: [{ id, body: 'writer A' }] }
				]);
			})
		);

		expect(interleaved).toBe(true);
		expect(await database.query('select body from notes where id = $1', [id])).toEqual([
			{ body: 'writer B' }
		]);
		expect(answer.records.map((row) => row['body'])).toEqual(['writer A']);
		// The change automation runs in the settle phase with the same committed capture — the
		// interleave that made writer B win had already happened and the event still carries A.
		expect(changeBodies).toEqual(['writer A']);
	}, 60_000);
});
