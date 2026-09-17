import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	captureFieldsForWorkspace,
	projectLinkAndRouteValues,
	type DeclaredCaptureFields
} from '../src/runtime/collections/write/plan.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

const definition = workspace({
	name: 'sync-engine-capture',
	version: '1.0.0',
	collections: [
		collection({ name: 'parents', fields: { name: field.string({ required: true }) } }),
		collection({
			name: 'items',
			fields: {
				parent_id: field.string({ required: true }),
				label: field.string({ required: true }),
				payload: field.json()
			}
		})
	],
	relations: [
		{
			name: 'parent_items',
			source: 'parents',
			target: 'items',
			cardinality: 'many',
			from: { collection: 'parents', column: 'id' },
			to: { collection: 'items', column: 'parent_id' }
		}
	],
	apps: [app({ name: 'capture', label: 'Capture' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the capture test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: (['create', 'read', 'update', 'delete'] as const).flatMap((action) => [
				{ collection: 'parents', action },
				{ collection: 'items', action }
			])
		})
	]
});

const captureManifest = {
	parents: [],
	items: ['label', 'parent_id']
} satisfies DeclaredCaptureFields;

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('sync engine database mutation capture', () => {
	it('captures authoritative create, update, and delete link values after each commit', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				collections: {
					parents: { create: { input: { columns: { name: true } } } },
					items: {
						create: { input: { columns: { parent_id: true, label: true, payload: true } } },
						update: { input: { columns: { label: true } } },
						delete: {}
					}
				}
			}
		});
		const marker = 'UNDECLARED-LARGE-BODY';
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const syncCommit = yield* SyncCommit.Service;
				const parent = yield* collections.write(EffectId.make('capture-parent'), adminSubject, [
					{ collection: 'parents', action: 'create', inputs: [{ name: 'Parent' }] }
				]);
				yield* syncCommit.drainChanges;
				const parentId = String(parent.records[0]?.['id']);
				const item = yield* collections.write(EffectId.make('capture-insert'), adminSubject, [
					{
						collection: 'items',
						action: 'create',
						inputs: [
							{
								parent_id: parentId,
								label: marker.repeat(256),
								payload: { marker, nested: Array.from({ length: 128 }, () => marker) }
							}
						]
					}
				]);
				const itemId = String(item.records[0]?.['id']);
				const inserted = yield* syncCommit.drainChanges;
				yield* collections.write(EffectId.make('capture-update'), adminSubject, [
					{
						collection: 'items',
						action: 'update',
						inputs: [{ id: itemId, label: 'Updated label' }]
					}
				]);
				const updated = yield* syncCommit.drainChanges;
				yield* collections.write(EffectId.make('capture-delete'), adminSubject, [
					{ collection: 'items', action: 'delete', inputs: [{ id: itemId }] }
				]);
				const deleted = yield* syncCommit.drainChanges;
				return { parentId, itemId, inserted, updated, deleted };
			})
		);

		expect(result.inserted).toEqual([
			{
				collection: 'items',
				id: result.itemId,
				operation: 'insert',
				after: { parent_id: result.parentId }
			}
		]);
		expect(result.updated).toEqual([
			{
				collection: 'items',
				id: result.itemId,
				operation: 'update',
				before: { parent_id: result.parentId },
				after: { parent_id: result.parentId }
			}
		]);
		expect(result.deleted).toEqual([
			{
				collection: 'items',
				id: result.itemId,
				operation: 'delete',
				before: { parent_id: result.parentId }
			}
		]);
		expect(JSON.stringify([result.inserted, result.updated, result.deleted])).not.toContain(marker);
	});

	it('projects only fields declared by complete canonical capture metadata', () => {
		const projection = captureFieldsForWorkspace(definition, captureManifest);
		const fields = projection.get('items');
		if (fields === undefined) throw new Error('items capture projection was not built');
		expect([...fields]).toEqual(['label', 'parent_id']);
		expect(
			projectLinkAndRouteValues(
				{
					parent_id: 'parent-1',
					label: 'visible route',
					payload: { large: 'must-not-copy' },
					body: 'must-not-copy'
				},
				fields
			)
		).toEqual({ label: 'visible route', parent_id: 'parent-1' });
	});
});
