import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { writesTo } from './support/folded-write.js';

const definition = workspace({
	name: 'import-upsert',
	version: '1.0.0',
	collections: [
		collection({
			name: 'notes',
			fields: { body: field.string({ required: true }), source: field.string({ required: true }) }
		})
	],
	apps: [app({ name: 'notes', label: 'Notes' })],
	teams: { admin: ['notes-data'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'notes-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'update' },
				{ collection: 'notes', action: 'read' }
			]
		})
	]
});

/** Import rows are declared creates (RFC §8.6); a row naming a stored id is that row's update. */
const notesModule: AuthoredRuntime['collections'] = {
	notes: {
		create: { input: { columns: { body: true, source: true } } },
		update: { input: { columns: { body: true, source: true } } }
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('collection import mutation rows', () => {
	it('creates and updates through one pipeline result', async () => {
		const existingId = recordId('existing-note');
		const importEffectId = 'mixed-import';
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				collections: notesModule,
				pipelines: {
					notes: {
						import: {
							description: 'Returns one create and one update.',
							handler: () => [
								{ body: 'new', source: 'pipeline' },
								{ id: existingId, body: 'changed', source: 'pipeline' }
							]
						}
					}
				}
			}
		});

		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.write(harness!.effectId('seed-existing'), adminSubject, [
					{
						collection: 'notes',
						action: 'create',
						inputs: [{ id: existingId, body: 'old', source: 'seed' }]
					}
				]);
				const imported = yield* collections.import(
					harness!.effectId(importEffectId),
					adminSubject,
					[
						{
							collection: 'notes',
							id: recordId('posted-document'),
							values: { document: 'fixture' }
						}
					]
				);
				const rows = yield* collections.findMany(harness!.effectId('read-imported'), adminSubject, {
					collection: 'notes',
					limit: 10
				});
				return { imported, rows };
			})
		);

		expect(result.imported).toBe(2);
		expect(result.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ body: 'new', source: 'pipeline' }),
				expect.objectContaining({
					id: existingId,
					body: 'changed',
					source: 'pipeline'
				})
			])
		);
		expect(result.rows).toHaveLength(2);
	}, 30_000);

	it('writes every pipeline row across fixed 100-row chunks, one insert per chunk', async () => {
		const importEffectId = 'chunked-import';
		const rows = Array.from({ length: 101 }, (_, index) => ({
			body: `row ${index}`,
			source: 'chunked-pipeline'
		}));
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				collections: notesModule,
				pipelines: {
					notes: {
						import: {
							description: 'Returns more than one fixed import chunk.',
							handler: () => rows
						}
					}
				}
			}
		});

		harness.database.forget();
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const imported = yield* collections.import(
					harness!.effectId(importEffectId),
					adminSubject,
					[
						{
							collection: 'notes',
							id: recordId('chunked-document'),
							values: { document: 'fixture' }
						}
					]
				);
				const stored = yield* collections.findMany(
					harness!.effectId('read-chunked-import'),
					adminSubject,
					{ collection: 'notes', limit: 200 }
				);
				return { imported, stored };
			})
		);

		expect(result.imported).toBe(101);
		expect(result.stored).toHaveLength(101);
		expect(result.stored.map((row) => row['body'])).toEqual(
			expect.arrayContaining(['row 0', 'row 100'])
		);
		// Two chunks, two writes, one insert piece each: rows of one shape are never one statement each.
		expect(writesTo(harness.database.statements, 'notes')).toHaveLength(2);
	}, 30_000);
});
