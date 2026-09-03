import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

const definition = workspace({
	name: 'export-pipeline',
	version: '1.0.0',
	collections: [
		collection({
			name: 'notes',
			fields: { body: field.string({ required: true }) }
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
				{ collection: 'notes', action: 'read' }
			]
		})
	]
});

let harness: BoltTestRuntime | undefined;

type NoteRow = Readonly<{ readonly body: string }>;
type ExportPipelineApi = Readonly<{
	readonly db: Readonly<{
		readonly notes: Readonly<{
			readonly findMany: (
				input: Readonly<Record<string, unknown>>
			) => Effect.Effect<ReadonlyArray<NoteRow>, unknown, never>;
		}>;
	}>;
}>;

afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('authored collection export pipeline', () => {
	it('passes selected records as context and the authored api as the second handler argument', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				pipelines: {
					notes: {
						export: {
							description: 'Exports selected notes after an authored API read.',
							handler(
								{ records }: Readonly<{ readonly records: ReadonlyArray<NoteRow> }>,
								api: ExportPipelineApi
							) {
								return Effect.map(
									api.db.notes.findMany({ orderBy: { body: 'asc' }, limit: 10 }),
									(allNotes) => [
										{
											label: 'Notes',
											attachments: [
												{
													name: 'notes.json',
													contentType: 'JSON' as const,
													content: {
														selected: records.map((record) => record.body),
														all: allNotes.map((record) => record.body)
													}
												}
											]
										}
									]
								);
							}
						}
					}
				}
			}
		});

		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const seeded = yield* collections.mutate(
					harness!.effectId('seed-notes'),
					adminSubject,
					'notes',
					[{ body: 'Selected' }, { body: 'Other' }]
				);
				const selectedId = seeded.records.find((record) => record['body'] === 'Selected')?.['id'];
				if (typeof selectedId !== 'string') throw new Error('selected seed row has no id');
				return yield* collections.export(harness!.effectId('export-notes'), adminSubject, {
					collection: 'notes',
					where: { id: { in: [selectedId] } },
					limit: 10
				});
			})
		);

		expect(result).toEqual([
			{
				label: 'Notes',
				attachments: [
					{
						name: 'notes.json',
						contentType: 'JSON',
						content: { selected: ['Selected'], all: ['Other', 'Selected'] }
					}
				]
			}
		]);
	}, 30_000);
});
