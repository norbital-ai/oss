import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { deriveRecordId } from '../../src/runtime/derive-record-id.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

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

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('collection import mutation rows', () => {
	it('creates and updates through one pipeline result while retaining the derived create id', async () => {
		const existingId = recordId('existing-note');
		const importEffectId = 'mixed-import';
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
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
				yield* collections.create(harness!.effectId('seed-existing'), adminSubject, {
					collection: 'notes',
					id: existingId,
					values: { body: 'old', source: 'seed' }
				});
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
				expect.objectContaining({
					id: deriveRecordId(`notes:${importEffectId}:0`),
					body: 'new',
					source: 'pipeline'
				}),
				expect.objectContaining({
					id: existingId,
					body: 'changed',
					source: 'pipeline'
				})
			])
		);
		expect(result.rows).toHaveLength(2);
	}, 30_000);
});
