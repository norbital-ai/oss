import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	describeWorkspace,
	executeSystemTool,
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
			write: { create: 'customer_id, status', update: 'status, trials{create}', transform: true },
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

	it('prints the compiled value type of a JSON field and where a collection is filed nested', () => {
		const typed = {
			...definition,
			collections: [
				{
					name: 'jobs',
					history: true,
					fields: {
						id: field('uuid', { required: true, primaryKey: true }),
						amount_charged: field('json')
					},
					types: {
						row: '{ amount_charged: { value: number; currency: string; } | null; }',
						fields: { amount_charged: '{ value: number; currency: string; } | null' }
					},
					write: {
						create: {
							columns: { amount_charged: true },
							with: { photos: { create: { columns: { photo: true, source: true } } } }
						},
						hasTransform: false
					}
				},
				{
					name: 'photos',
					history: true,
					fields: {
						id: field('uuid', { required: true, primaryKey: true }),
						source: field('json')
					},
					write: { create: { columns: {} }, hasTransform: false }
				}
			],
			relations: [{ name: 'photos', source: 'jobs', target: 'photos', cardinality: 'many' }]
		};
		const snapshot = workspaceSnapshot(
			{
				workspace: { definition: typed } as never,
				collectionNames: ['jobs', 'photos'],
				readableCollectionNames: ['jobs', 'photos'],
				writableCollectionNames: ['jobs', 'photos'],
				readFields: {},
				standing: 'workspace administrator',
				toolNames: ['write_collection'],
				skills: []
			},
			'2026-09-24T00:00:00.000Z'
		);
		// `json` named the storage; the agent needs the value a write carries.
		expect(snapshot).toContain('amount_charged:{ value: number; currency: string } | null');
		expect(snapshot).toContain('    create: amount_charged, photos{create}');
		// The channel photo's `source` is accepted only through the job's nested create.
		expect(snapshot).toContain('    nested: jobs.create photos.create{photo, source}');
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
		expect(lines).toContain('    update: status, trials{create}');
		expect(lines).toContain('  board: "Board" src/apps/+board.svelte');
		expect(lines).toContain('  nightly: schedule 0 2 * * * src/automations/+nightly.ts');
		expect(lines).toContain('  sales_whatsapp: whatsapp src/channels/+sales_whatsapp.ts');
		expect(lines).toContain('skills: intake (read_skill by name)');
	});
});

describe('workspace_type', () => {
	const typed = {
		...definition,
		collections: [
			{
				name: 'jobs',
				fields: {
					id: field('uuid', { required: true, primaryKey: true }),
					scheduled_for: field('instant', { required: true, precision: 'day' }),
					status: field('string')
				},
				write: { create: { columns: { status: true } }, hasTransform: true },
				types: {
					row: '{\n  /** Where the work has got to. */\n  status: string | null;\n}',
					fields: { status: 'string | null', scheduled_for: 'string' },
					create: '{\n  status?: string | null;\n}',
					createFields: { status: '?string | null' },
					docs: {
						collection: {
							text: 'One dispatched day job.',
							source: 'src/collections/jobs/+collection.ts:3'
						},
						create: { text: '', source: 'src/collections/jobs/+collection.ts:5' },
						transform: {
							text: 'Files it unassigned until a contractor holds it. Stamps the dispatch.',
							source: 'src/collections/jobs/+collection.ts:9'
						},
						fields: {
							status: {
								text: 'Where the work has got to.',
								source: 'src/collections/jobs/+model.ts:12'
							},
							scheduled_for: { text: '', source: 'src/collections/jobs/+model.ts:8' }
						}
					}
				}
			}
		],
		automations: [
			{
				name: 'review',
				trigger: { _tag: 'Schedule', cron: '*/15 * * * *' },
				description: 'Reads each new photo and fills its checksum and flags.',
				command: 'x'
			}
		]
	} as unknown as WorkspaceDefinition;
	const hosted: Array<unknown> = [];
	const context = {
		collectionNames: ['jobs'],
		agentId: 'web',
		effectId: 'e1',
		conversationId: 'c1',
		subject: { system: true, policies: [] },
		workspace: { definition: typed },
		hostTools: {
			execute: (_id: unknown, request: { tool: string; input: unknown }) => {
				hosted.push(request);
				return Effect.succeed({
					output: {
						found: true,
						type: 'default: Automation',
						source: 'src/automations/+review.ts:4'
					}
				});
			}
		}
	} as never;
	const ask = (input: unknown) =>
		Effect.runPromise(executeSystemTool('workspace_type', input, context));

	it('answers collections from the index with the authored comment and where it is written', async () => {
		expect(await ask({ name: 'collections.jobs' })).toEqual({
			name: 'collections.jobs',
			type: '{\n  /** Where the work has got to. */\n  status: string | null;\n}',
			docs: 'One dispatched day job.',
			source: 'src/collections/jobs/+collection.ts:3'
		});
		// A write input carries what the workspace does on its own, so no one samples rows to learn it.
		expect(await ask({ name: 'collections.jobs.create' })).toEqual({
			name: 'collections.jobs.create',
			type: '{\n  status?: string | null;\n}',
			onWrite: 'Files it unassigned until a contractor holds it. Stamps the dispatch.',
			onWriteSource: 'src/collections/jobs/+collection.ts:9',
			source: 'src/collections/jobs/+collection.ts:5'
		});
		expect(await ask({ name: 'collections.jobs.status' })).toEqual({
			name: 'collections.jobs.status',
			type: 'string | null',
			create: '?string | null',
			docs: 'Where the work has got to.',
			source: 'src/collections/jobs/+model.ts:12'
		});
		expect(hosted).toEqual([]);
	});

	it('hands every other name and any position to the host type service', async () => {
		expect(await ask({ name: 'automations.review' })).toEqual({
			found: true,
			type: 'default: Automation',
			source: 'src/automations/+review.ts:4'
		});
		expect(hosted).toEqual([
			{ tool: 'workspace_type', input: { name: 'automations.review' }, sessionId: 'c1' }
		]);
	});

	it("prints what a write does, a day column, and an automation's lifecycle in the snapshot", () => {
		const snapshot = workspaceSnapshot(
			{
				workspace: { definition: typed } as never,
				collectionNames: ['jobs'],
				readableCollectionNames: ['jobs'],
				writableCollectionNames: ['jobs'],
				readFields: {},
				standing: 'workspace administrator',
				toolNames: [],
				skills: []
			},
			'2026-09-24T19:04:00.000Z'
		);
		expect(snapshot).toContain('scheduled_for:instant(day)!');
		expect(snapshot).toContain('    on write: "Files it unassigned until a contractor holds it."');
		expect(snapshot).toContain(
			'review: schedule */15 * * * * src/automations/+review.ts — "Reads each new photo and fills its checksum and flags."'
		);
	});
});

describe('geocode', () => {
	it('answers places as the value a geolocation field takes', async () => {
		const context = {
			effectId: 'e1',
			geocoding: {
				search: () =>
					Effect.succeed({
						results: [
							{
								id: 'onemap:289000',
								formatted_address: '40 WILKINSON ROAD SINGAPORE 436674',
								lat: 1.3121,
								lon: 103.9051,
								postal_code: '436674'
							}
						]
					})
			}
		} as never;
		expect(
			await Effect.runPromise(executeSystemTool('geocode', { query: '40 Wilkinson Road' }, context))
		).toEqual({
			places: [
				{
					formatted_address: '40 WILKINSON ROAD SINGAPORE 436674',
					postal_code: '436674',
					location: {
						type: 'Point',
						srid: 4326,
						geometry: { lat: 1.3121, lon: 103.9051 },
						formatted_address: '40 WILKINSON ROAD SINGAPORE 436674'
					}
				}
			]
		});
		const failed = await Effect.runPromise(
			Effect.flip(executeSystemTool('geocode', { query: 'x' }, { effectId: 'e1' } as never))
		);
		expect(String((failed as { detail: string }).detail)).toContain('no address search');
	});
});
