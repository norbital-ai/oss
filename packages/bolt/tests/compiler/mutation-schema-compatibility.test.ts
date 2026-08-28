import { describe, expect, it } from 'vitest';
import { collection, workspace } from '../../src/authoring/workspace-schema.js';
import {
	advanceMutationCompatibilityLedger,
	classifyMutationSchemaTransition,
	composeMutationCompatibilityAdapters,
	mutationCompatibilityArtifact,
	mutationSchemaFingerprint,
	type MutationSchemaDescriptor,
	type MutationSchemaField
} from '../../src/compiler/mutation-schema-compatibility.js';
import { reconcileMutationSchema } from '../../src/compiler/schema-plan.js';

const scalar = (overrides: Partial<MutationSchemaField> = {}): MutationSchemaField => ({
	type: 'text',
	typeSchema: null,
	dimensions: 0,
	notNull: false,
	default: null,
	generated: null,
	...overrides
});

const schema = (
	collections: Readonly<Record<string, Readonly<Record<string, MutationSchemaField>>>>,
	relations: MutationSchemaDescriptor['relations'] = []
): MutationSchemaDescriptor => ({
	collections: Object.fromEntries(
		Object.entries(collections).map(([name, fields]) => [name, { fields }])
	),
	relations
});

describe('compiler-owned mutation schema compatibility', () => {
	it('fingerprints mutation-visible defaults and relationship topology', () => {
		const first = schema({ people: { id: scalar({ type: 'uuid', notNull: true }), name: scalar() } });
		const changedDefault = schema({
			people: {
				id: scalar({ type: 'uuid', notNull: true }),
				name: scalar({ default: "'Anonymous'" })
			}
		});
		const changedRelation = schema(
			{ people: { id: scalar({ type: 'uuid', notNull: true }), name: scalar() } },
			[{ name: 'people_jobs', source: 'people', target: 'jobs', cardinality: 'many' }]
		);
		expect(mutationSchemaFingerprint(first)).not.toBe(mutationSchemaFingerprint(changedDefault));
		expect(mutationSchemaFingerprint(first)).not.toBe(mutationSchemaFingerprint(changedRelation));
	});

	it('turns explicit generated table and column renames into a lossless adapter', () => {
		const before = schema({
			employees: { id: scalar({ type: 'uuid', notNull: true }), name: scalar() }
		});
		const after = schema({
			people: { id: scalar({ type: 'uuid', notNull: true }), full_name: scalar() }
		});
		expect(
			classifyMutationSchemaTransition({
				fromSchemaFingerprint: 'schema:employees',
				from: before,
				to: after,
				statements: [
					'ALTER TABLE "employees" RENAME TO "people";',
					'ALTER TABLE "people" RENAME COLUMN "name" TO "full_name";'
				]
			})
		).toEqual({
			fromSchemaFingerprint: 'schema:employees',
			collectionRenames: { employees: 'people' },
			fieldRenames: { employees: { name: 'full_name' } }
		});
	});

	it('quarantines type changes, removed collections, unsafe creates, and identity rewrites', () => {
		const before = schema({
			entries: {
				id: scalar({ type: 'uuid', notNull: true }),
				amount: scalar({ type: 'numeric' })
			},
			retired: { id: scalar({ type: 'uuid', notNull: true }) }
		});
		const after = schema({
			entries: {
				record_id: scalar({ type: 'uuid', notNull: true }),
				amount: scalar({ type: 'text' }),
				currency: scalar({ notNull: true })
			}
		});
		const adapter = classifyMutationSchemaTransition({
			fromSchemaFingerprint: 'schema:old',
			from: before,
			to: after,
			statements: ['ALTER TABLE "entries" RENAME COLUMN "id" TO "record_id";']
		});
		expect(adapter.fieldRenames?.['entries']).toBeUndefined();
		expect(adapter.incompatibleFields?.['entries']).toEqual(['amount', 'id']);
		expect(adapter.incompatibleActions?.['entries']).toEqual(['create']);
		expect(adapter.incompatibleActions?.['retired']).toEqual(['create', 'update', 'delete']);
	});

	it('composes retained adapters directly across more than one release', () => {
		const direct = composeMutationCompatibilityAdapters(
			{
				fromSchemaFingerprint: 'schema:s1',
				collectionRenames: { employees: 'people' },
				fieldRenames: { employees: { name: 'full_name' } }
			},
			{
				fromSchemaFingerprint: 'schema:s2',
				collectionRenames: { people: 'workers' },
				fieldRenames: { people: { full_name: 'display_name' } },
				incompatibleActions: { people: ['create'] }
			}
		);
		expect(direct).toEqual({
			fromSchemaFingerprint: 'schema:s1',
			collectionRenames: { employees: 'workers' },
			fieldRenames: { employees: { name: 'display_name' } },
			incompatibleActions: { employees: ['create'] }
		});
	});

	it('ships adapters for the full horizon, then expires them without deleting audit checkpoints', () => {
		const firstSchema = schema({ rows: { id: scalar({ type: 'uuid', notNull: true }) } });
		const secondSchema = schema({
			rows: { id: scalar({ type: 'uuid', notNull: true }), note: scalar() }
		});
		const first = advanceMutationCompatibilityLedger({
			previous: undefined,
			schema: firstSchema,
			statements: [],
			atEpochMs: 1_000,
			offlineHorizonMillis: 100
		});
		const second = advanceMutationCompatibilityLedger({
			previous: first,
			schema: secondSchema,
			statements: ['ALTER TABLE "rows" ADD COLUMN "note" text;'],
			atEpochMs: 1_010
		});
		expect(mutationCompatibilityArtifact(second, 1_110)).toMatchObject({
			currentSchemaFingerprint: second.currentSchemaFingerprint,
			adapters: [{ fromSchemaFingerprint: first.currentSchemaFingerprint }]
		});
		expect(mutationCompatibilityArtifact(second, 1_111).adapters).toEqual([]);
		expect(second.checkpoints).toHaveLength(2);
		expect(second.checkpoints[0]?.adapterToCurrent).toBeDefined();
	});

	it('makes action incompatibility and identity preservation runtime quarantine decisions', () => {
		const definition = workspace({
			name: 'compatibility',
			version: '1',
			collections: [
				collection({ name: 'rows', fields: { name: { type: 'string', required: false, indexed: false } } })
			],
			relations: [],
			apps: [],
			policies: [],
			prompt: 'test',
			tools: [],
			skills: [],
			automations: [],
			envoys: [],
			integrations: [],
			requiredFacilities: [],
			mutationCompatibility: {
				offlineHorizonMillis: 100,
				currentSchemaFingerprint: 'schema:new',
				adapters: [
					{
						fromSchemaFingerprint: 'schema:old',
						incompatibleActions: { rows: ['create'] },
						fieldRenames: { rows: { id: 'record_id' } }
					}
				]
			}
		});
		const resolution = reconcileMutationSchema(definition, {
			fromSchemaFingerprint: 'schema:old',
			toSchemaFingerprint: 'schema:new',
			ageMillis: 1,
			graph: { action: 'create', collection: 'rows', values: { name: 'Ada' } },
			baseVersions: []
		});
		expect(resolution.resolution).toBe('quarantined');
		if (resolution.resolution === 'quarantined')
			expect(resolution.reason).toContain('record identity');
	});

	it('applies action fences recursively to nested relationship reconciliation', () => {
		const definition = workspace({
			name: 'nested-compatibility',
			version: '1',
			collections: [
				collection({ name: 'parents', fields: { name: { type: 'string', required: false, indexed: false } } }),
				collection({
					name: 'children',
					fields: {
						parent_id: { type: 'uuid', required: true, indexed: false },
						name: { type: 'string', required: false, indexed: false }
					}
				})
			],
			relations: [
				{
					name: 'parent_children',
					source: 'parents',
					target: 'children',
					cardinality: 'many',
					from: { collection: 'children', column: 'parent_id' },
					to: { collection: 'parents', column: 'id' }
				}
			],
			apps: [],
			policies: [],
			prompt: 'test',
			tools: [],
			skills: [],
			automations: [],
			envoys: [],
			integrations: [],
			requiredFacilities: [],
			mutationCompatibility: {
				offlineHorizonMillis: 100,
				currentSchemaFingerprint: 'schema:new',
				adapters: [
					{
						fromSchemaFingerprint: 'schema:old',
						incompatibleActions: { children: ['create'] }
					}
				]
			}
		});
		const resolution = reconcileMutationSchema(definition, {
			fromSchemaFingerprint: 'schema:old',
			toSchemaFingerprint: 'schema:new',
			ageMillis: 1,
			graph: {
				action: 'update',
				collection: 'parents',
				values: {
					id: 'parent-1',
					// V2 creates already carry client-minted ids; only a matching base-version coordinate
					// makes a nested node an update.
					parent_children: [{ id: 'client-minted-child', name: 'new child' }]
				}
			},
			baseVersions: []
		});
		expect(resolution.resolution).toBe('quarantined');
		if (resolution.resolution === 'quarantined')
			expect(resolution.reason).toContain('children cannot preserve create semantics');

		const updateFenced = {
			...definition,
			mutationCompatibility: {
				offlineHorizonMillis: 100,
				currentSchemaFingerprint: 'schema:new',
				adapters: [
					{
						fromSchemaFingerprint: 'schema:old',
						incompatibleActions: { children: ['update'] as const }
					}
				]
			}
		};
		const clientIdentifiedCreate = reconcileMutationSchema(updateFenced, {
			fromSchemaFingerprint: 'schema:old',
			toSchemaFingerprint: 'schema:new',
			ageMillis: 1,
			graph: {
				action: 'update',
				collection: 'parents',
				values: {
					id: 'parent-1',
					parent_children: [{ id: 'client-minted-child', name: 'new child' }]
				}
			},
			baseVersions: []
		});
		expect(clientIdentifiedCreate.resolution).toBe('rebased');
		const existingChildUpdate = reconcileMutationSchema(updateFenced, {
			fromSchemaFingerprint: 'schema:old',
			toSchemaFingerprint: 'schema:new',
			ageMillis: 1,
			graph: {
				action: 'update',
				collection: 'parents',
				values: {
					id: 'parent-1',
					parent_children: [{ id: 'client-minted-child', name: 'existing child' }]
				}
			},
			baseVersions: [
				{
					row: { collection: 'children', recordId: 'client-minted-child' },
					rowVersion: 1
				}
			]
		});
		expect(existingChildUpdate.resolution).toBe('quarantined');
		if (existingChildUpdate.resolution === 'quarantined')
			expect(existingChildUpdate.reason).toContain('children cannot preserve update semantics');
	});

	it('applies implied delete compatibility only to owned relationships', () => {
		const base = workspace({
			name: 'relationship-delete-compatibility',
			version: '1',
			collections: [
				collection({ name: 'parents', fields: {} }),
				collection({
					name: 'children',
					fields: {
						parent_id: { type: 'uuid', required: true, indexed: false }
					}
				})
			],
			relations: [
				{
					name: 'parent_children',
					source: 'parents',
					target: 'children',
					cardinality: 'many',
					from: { collection: 'children', column: 'parent_id' },
					to: { collection: 'parents', column: 'id' }
				}
			],
			apps: [],
			policies: [],
			prompt: 'test',
			tools: [],
			skills: [],
			automations: [],
			envoys: [],
			integrations: [],
			requiredFacilities: [],
			mutationCompatibility: {
				offlineHorizonMillis: 100,
				currentSchemaFingerprint: 'schema:new',
				adapters: [
					{
						fromSchemaFingerprint: 'schema:old',
						incompatibleActions: { children: ['delete'] }
					}
				]
			}
		});
		const reconcile = (definition: typeof base) =>
			reconcileMutationSchema(definition, {
				fromSchemaFingerprint: 'schema:old',
				toSchemaFingerprint: 'schema:new',
				ageMillis: 1,
				graph: {
					action: 'update',
					collection: 'parents',
					values: { id: 'parent-1', parent_children: [] }
				},
				baseVersions: []
			});

		expect(reconcile(base).resolution).toBe('rebased');

		const directCascade = {
			...base,
			relations: base.relations.map((relation) => ({ ...relation, cascade: true }))
		};
		const direct = reconcile(directCascade);
		expect(direct.resolution).toBe('quarantined');
		if (direct.resolution === 'quarantined')
			expect(direct.reason).toContain('children cannot preserve delete semantics');

		const inverseCascade = {
			...base,
			relations: [
				{
					name: 'parent_children',
					source: 'parents',
					target: 'children',
					cardinality: 'many' as const
				},
				{
					name: 'child_parent',
					source: 'children',
					target: 'parents',
					cardinality: 'one' as const,
					from: { collection: 'children', column: 'parent_id' },
					to: { collection: 'parents', column: 'id' },
					cascade: true
				}
			]
		};
		const inverse = reconcile(inverseCascade);
		expect(inverse.resolution).toBe('quarantined');
		if (inverse.resolution === 'quarantined')
			expect(inverse.reason).toContain('children cannot preserve delete semantics');
	});
});
