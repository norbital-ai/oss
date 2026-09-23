import { describe, expect, it } from 'vitest';
import {
	describeWorkspace,
	subjectStanding,
	workspaceSnapshot
} from '../src/runtime/agents/capability-catalog.js';
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
	channels: [{ name: 'sales_whatsapp', transport: 'whatsapp' }],
	envoys: [{ name: 'whatsapp' }],
	integrations: [
		{
			name: 'erp',
			policies: [],
			syncs: [{ name: 'customers', collection: 'customers', direction: 'one_way', source: 'http' }]
		}
	],
	teams: { 'R&D': ['color_matcher'], Reviewers: ['submission_reviewer'] }
} as unknown as WorkspaceDefinition;

describe('describe_workspace', () => {
	it('answers the shape of every reachable collection, its contract, and the rest of the surface', () => {
		const described = describeWorkspace({
			workspace: { definition } as never,
			collectionNames: ['projects', 'customers'],
			readableCollectionNames: ['projects', 'customers'],
			writableCollectionNames: ['projects'],
			readFields: {},
			standing: 'not an administrator; team R&D; policies color_matcher',
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
		expect(described.channels).toEqual(['sales_whatsapp (whatsapp)']);
		expect(described.integrations).toEqual(['erp: customers (one-way, http)']);
		expect(described.teams).toEqual(['R&D: color_matcher', 'Reviewers: submission_reviewer']);
		expect(described.you).toBe('not an administrator; team R&D; policies color_matcher');
		expect(described.tools).toEqual(['read_collection', 'write_collection']);
		expect(described.skills).toEqual(['intake']);
	});

	it('describes only the fields a masked read returns', () => {
		const described = describeWorkspace({
			workspace: { definition } as never,
			collectionNames: ['customers'],
			readableCollectionNames: ['customers'],
			writableCollectionNames: [],
			readFields: { customers: ['id'] },
			standing: 'x',
			toolNames: [],
			skills: []
		});
		// `name` is withheld by the grant, so describing it would invite a read that returns nothing.
		expect((described.collections as ReadonlyArray<{ fields: unknown }>)[0]?.fields).toEqual([]);
	});
});

describe('subjectStanding', () => {
	it('states a team member by team and held policies, never as an administrator', () => {
		// A member holds policies through their team, so `subject.policies` is empty — which the
		// previous `you` line read as "admin (every collection, no policy scope)".
		expect(
			subjectStanding(
				{ userId: 'u1', tenantId: 't', teamPath: ['Contractor'], policies: [], admin: false },
				['field_ops_contractor']
			)
		).toBe('not an administrator; team Contractor; policies field_ops_contractor');
	});

	it('states an administrator with no team as exactly that', () => {
		expect(
			subjectStanding({ userId: 'u1', tenantId: 't', teamPath: [], policies: [], admin: true }, [])
		).toBe(
			'workspace administrator (reads and writes every authored collection, whatever the policies); no team; policies none'
		);
	});

	it('puts the same shape in the prompt as a stamped YAML snapshot with every source path', () => {
		const snapshot = workspaceSnapshot(
			{
				workspace: { definition } as never,
				collectionNames: ['projects', 'customers'],
				readableCollectionNames: ['projects', 'customers'],
				writableCollectionNames: ['projects'],
				readFields: {},
				standing: 'not an administrator; team R&D; policies color_matcher',
				toolNames: ['read_collection'],
				skills: [{ name: 'intake' } as never]
			},
			'2026-09-24T00:00:00.000Z'
		);
		const lines = snapshot.split('\n');
		expect(lines[0]).toBe(
			'# Workspace snapshot — valid as of 2026-09-24T00:00:00.000Z only. Its structure holds for this turn; records change, so read them fresh. describe_workspace refreshes it.'
		);
		expect(lines).toContain('  projects:');
		expect(lines).toContain('    src: src/collections/projects/');
		expect(lines).toContain('    update: status, trials{…}');
		expect(lines).toContain('  board: "Board" src/apps/+board.svelte');
		expect(lines).toContain('  nightly: schedule 0 2 * * * src/automations/+nightly.ts');
		expect(lines).toContain('  sales_whatsapp: whatsapp src/channels/+sales_whatsapp.ts');
		expect(lines).toContain('skills: intake (read_skill by name)');
	});
});
