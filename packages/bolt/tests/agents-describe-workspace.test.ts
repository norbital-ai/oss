import { describe, expect, it } from 'vitest';
import { describeWorkspace } from '../src/runtime/agents/capability-catalog.js';
import type { WorkspaceDefinition } from '../src/authoring/workspace-schema.js';

const field = (
	type: 'string' | 'uuid' | 'number' | 'boolean' | 'instant' | 'json',
	extra: Record<string, unknown> = {}
) => ({ type, required: false, indexed: false, ...extra });

/** The parts of a definition the description reads; the rest of the artifact is irrelevant here. */
const definition = {
	name: '@template/colour',
	version: '0.0.1',
	collections: [
		{
			name: 'projects',
			history: true,
			description: 'One customer enquiry.',
			recordLabel: 'project_no',
			sourcePath: 'src/collections/projects',
			search: { documentColumn: 'search_document' },
			fields: {
				id: field('uuid', { required: true, primaryKey: true }),
				created_at: field('instant', { required: true }),
				row_version: field('number', { required: true }),
				search_document: field('string', { generated: 'tsvector' }),
				project_no: field('string', { required: true, search: true }),
				customer_id: field('uuid', { required: true }),
				status: field('string', { values: ['pending', 'done'] }),
				light_sources: field('string', { values: ['D65', 'CWF'], array: true }),
				plaque: field('json', { file: true }),
				documents: field('json', { file: true, fileMultiple: true })
			},
			write: {
				create: { columns: { customer_id: true, status: true } },
				update: { columns: { status: true }, with: { trials: { create: {} } } },
				hasTransform: true,
				similarity: [{ name: 'colour', column: 'reading', metric: 'l2', input: [] }]
			}
		},
		{
			name: 'customers',
			history: true,
			fields: { id: field('uuid', { required: true, primaryKey: true }), name: field('string') }
		}
	],
	relations: [
		{
			name: 'project_customer',
			source: 'projects',
			target: 'customers',
			cardinality: 'one',
			from: { collection: 'projects', column: 'customer_id' },
			to: { collection: 'customers', column: 'id' }
		}
	],
	apps: [
		{ name: 'board', label: 'Board', description: 'The kanban.' },
		{ name: 'kiosk', label: 'Kiosk', kiosk: true }
	],
	automations: [
		{
			name: 'post_stock',
			trigger: { _tag: 'Change', collection: 'stock', event: 'created' },
			command: 'x'
		},
		{ name: 'nightly', trigger: { _tag: 'Schedule', cron: '0 2 * * *' }, command: 'y' }
	],
	envoys: [{ name: 'whatsapp' }],
	integrations: [
		{ name: 'erp', collection: 'customers', policies: [], receive: [{}], webhooks: [], send: [] }
	]
} as unknown as WorkspaceDefinition;

describe('describe_workspace', () => {
	it('answers the shape of every reachable collection, its contract, and the rest of the surface', () => {
		const described = describeWorkspace({
			workspace: { definition } as never,
			collectionNames: ['projects', 'customers'],
			readableCollectionNames: ['projects', 'customers'],
			writableCollectionNames: ['projects'],
			toolNames: ['read_collection', 'write_collection'],
			skills: [{ name: 'intake' } as never]
		});
		expect(described.note).toMatch(/src\/collections\/<name>\/\+model\.ts/);
		const [projects, customers] = described.collections as ReadonlyArray<Record<string, unknown>>;
		expect(projects).toEqual({
			name: 'projects',
			description: 'One customer enquiry.',
			label: 'project_no',
			// System columns and the search document stay out; a field is one token.
			fields: [
				'project_no:string!(search)',
				'customer_id:uuid!->customers',
				'status:string=pending|done',
				'light_sources:string[]=D65|CWF',
				'plaque:json(file)',
				'documents:json(files)'
			],
			write: { create: 'customer_id, status', update: 'status, trials{…}', transform: true },
			search: ['/colour']
		});
		expect(customers).toEqual({
			name: 'customers',
			fields: ['name:string'],
			write: null,
			integrations: ['erp']
		});
		expect(described.apps).toEqual(['board: Board — The kanban.', 'kiosk: Kiosk (kiosk)']);
		expect(described.automations).toEqual([
			'post_stock [stock created]',
			'nightly [schedule 0 2 * * *]'
		]);
		expect(described.integrations).toEqual(['erp on customers (1 pull)']);
		expect(described.tools).toEqual(['read_collection', 'write_collection']);
		expect(described.skills).toEqual(['intake']);
	});
});
