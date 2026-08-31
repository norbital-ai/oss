import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	InvocationId,
	PROTOCOL_VERSION,
	Invocation,
	EnvironmentName,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, envoy, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { automation } from '../../src/authoring/automations-schema.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import { ADMIN_STATUS } from '../../src/runtime/identity/identity.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const manifestInvocation = (credential: string, command = 'workspace.manifest') =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make('manifest-1'),
		scope: {
			tenantId: TenantId.make('test-tenant'),
			environment: EnvironmentName.make('development'),
			releaseId: ReleaseId.make('local')
		},
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input: null,
		headers: { authorization: [`Bearer ${credential}`] }
	});

/**
 * The reader every one of these tests signs in as.
 *
 * `admin` is the team each fixture below declares holding the policy that grants `*`, and the
 * manifest is filtered by what the caller may read — so a caller in no team would come back with an
 * empty manifest and every assertion here would fail for a reason that is not about projection.
 */
const seedAdmin = (harness: BoltTestRuntime, token = 'admin-token') =>
	seedSession(harness, { token, user: `user-${token}`, team: 'admin' });

const value = (response: { readonly value?: unknown }): Record<string, unknown> =>
	(response.value ?? {}) as Record<string, unknown>;

describe('workspace.manifest command', () => {
	it('reports the structure a host studio needs without exposing tenant SQL', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{
						name: 'people',
						fields: { name: field.string({ required: true }), team: field.string() }
					},
					{ name: 'orders', fields: { total: field.number({ required: true }) } }
				]
			})
		);
		await seedAdmin(harness);

		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('admin-token'))
		);
		const manifest = value(response);
		expect(manifest['name']).toBe('test-workspace');

		const collections = manifest['collections'] as ReadonlyArray<{
			name: string;
			fields: ReadonlyArray<{ name: string; required: boolean }>;
		}>;
		const names = collections.map(({ name }) => name);
		expect(names).toContain('people');
		expect(names).toContain('orders');
		// Runtime-owned collections are part of the structure a studio shows.
		expect(names).toContain('approval_request');

		const people = collections.find(({ name }) => name === 'people');
		expect(people?.fields.find(({ name }) => name === 'name')?.required).toBe(true);
		expect(people?.fields.find(({ name }) => name === 'team')?.required).toBe(false);
	});

	it('gives an administrator the complete authored model without system collections', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{ name: 'people', fields: { name: field.string({ required: true }) } },
					{ name: 'payroll_runs', fields: { period: field.string({ required: true }) } }
				]
			})
		);
		await seedSession(harness, {
			token: 'author-token',
			user: 'workspace-author',
			status: ADMIN_STATUS
		});

		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('author-token', 'workspace.authoringManifest'))
		);
		const names = (value(response)['collections'] as ReadonlyArray<{ name: string }>).map(
			({ name }) => name
		);
		expect(names).toEqual(['people', 'payroll_runs']);
	});

	it('refuses the authoring model to a non-administrator', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		await seedSession(harness, { token: 'member-token', user: 'ordinary-member' });

		const failure = await harness.runtime.runPromise(
			Effect.flip(
				dispatchInvocation(manifestInvocation('member-token', 'workspace.authoringManifest'))
			)
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
	});

	/**
	 * An envoy is the one declaration a studio cannot use from its name alone: the Envoys page has to
	 * say where it is reached and who may reach it. The projection named `name` and dropped every
	 * other field the declaration carries, so the page had nothing to attribute an envoy with.
	 *
	 * `policies` and `task` are asserted absent rather than left unmentioned. `task` is the envoy's
	 * standing instruction and `policies` names everything its runs may do; `workspace.manifest`
	 * answers any authenticated caller, so publishing either would be a disclosure and not a feature.
	 *
	 * There is no `agent` key, and its absence is asserted by the exact-equality below. It used to be
	 * a back-pointer whose value was the one synthesized agent, in every workspace, always.
	 */
	it('publishes an envoy transport, audience and delegation boundary', async () => {
		harness = await makeBoltTestRuntime(
			workspace({
				name: 'envoyed',
				version: '1',
				collections: [],
				apps: [],
				policies: [
					policy({
						name: 'admin',
						effect: 'allow',
						actions: ['*'],
						capabilities: { apps: ['*'] }
					}),
					policy({ name: 'member', effect: 'allow', actions: ['read'] })
				],
				teams: {
					admin: ['admin']
				},
				automations: [],
				envoys: [
					envoy({
						name: 'support',
						transport: 'whatsapp',
						audience: 'public',
						policies: ['member'],
						groupMessages: 'mention_or_reply',
						delegation: 'enabled',
						task: 'Answer support questions for this member.'
					})
				],
				integrations: [],
				prompt: 'You are the test workspace agent.',
				tools: [],
				skills: [],
				requiredFacilities: []
			})
		);
		await seedAdmin(harness);
		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('admin-token'))
		);
		expect(value(response)['envoys']).toEqual([
			{
				name: 'support',
				transport: 'whatsapp',
				audience: 'public',
				groupMessages: 'mention_or_reply',
				delegation: 'enabled'
			}
		]);
	});

	/**
	 * Every static identity this release can mint, with a label to render it as.
	 *
	 * `bolt_audit.subject_id` and `bolt_collection_history.subject_id` are plain `text` with no
	 * foreign key, which is what lets `envoy:sales_desk` and `automation:payroll_close` be valid
	 * values with no shadow user table. What was missing was the label: a client holding
	 * `envoy:support` had nothing to render but the id, which is why seeded data shows no creator.
	 */
	it('publishes a label for every static identity it can mint', async () => {
		harness = await makeBoltTestRuntime(
			workspace({
				name: 'envoyed',
				version: '1',
				collections: [],
				apps: [],
				policies: [
					policy({
						name: 'admin',
						effect: 'allow',
						actions: ['*'],
						capabilities: { apps: ['*'] }
					}),
					policy({ name: 'member', effect: 'allow', actions: ['read'] })
				],
				teams: { admin: ['admin'] },
				automations: [
					automation({
						name: 'nightly',
						trigger: { _tag: 'Schedule', cron: '0 0 * * *' },
						command: 'automations.nightly',
						policies: ['member']
					})
				],
				envoys: [
					envoy({
						name: 'support',
						transport: 'whatsapp',
						audience: 'public',
						policies: ['member'],
						delegation: 'enabled',
						task: 'Answer support questions for this member.'
					})
				],
				integrations: [],
				prompt: 'You are the test workspace agent.',
				tools: [],
				skills: [],
				requiredFacilities: []
			})
		);
		await seedAdmin(harness);
		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('admin-token'))
		);
		expect(value(response)['principals']).toEqual([
			{ id: 'colony-system', label: 'Colony', kind: 'host', policies: [] },
			{ id: 'colony-seed', label: 'Sample data', kind: 'seed', policies: [] },
			{ id: 'envoy:support', label: 'support', kind: 'envoy', policies: ['member'] },
			{ id: 'automation:nightly', label: 'nightly', kind: 'automation', policies: ['member'] }
		]);
	});

	it('marks generated columns so a studio does not offer them as editable', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{
						name: 'people',
						fields: {
							name: field.string({ required: true }),
							...{
								initial: {
									type: 'string',
									required: false,
									indexed: false,
									generated: 'left(name, 1)'
								}
							}
						}
					}
				]
			})
		);
		await seedAdmin(harness);
		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('admin-token'))
		);
		const collections = value(response)['collections'] as ReadonlyArray<{
			name: string;
			fields: ReadonlyArray<{ name: string; generated: boolean }>;
		}>;
		const people = collections.find(({ name }) => name === 'people');
		expect(people?.fields.find(({ name }) => name === 'initial')?.generated).toBe(true);
		expect(people?.fields.find(({ name }) => name === 'name')?.generated).toBe(false);
	});

	/**
	 * The projection listed four keys and dropped the rest of the field description.
	 *
	 * `values`, `search`, `customType` and `mimeTypes` were each recovered from the declaration by
	 * work that had already landed, and then thrown away one hop before anything could read them —
	 * so a studio could not offer an enum's members, could not mark a searchable column, could not
	 * resolve a `custom()` renderer and could not set an upload's accept list. Rebuilding the shape
	 * field by field is what makes the drop silent, so every key is asserted rather than the four.
	 */
	it('carries the whole field description, not the four keys it used to name', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{
						name: 'requests',
						fields: {
							title: { type: 'string', required: true, indexed: false, search: true },
							lifecycle: {
								type: 'string',
								required: false,
								indexed: false,
								values: ['DRAFT', 'PAID']
							},
							event: { type: 'json', required: false, indexed: false, customType: 'leave_event' },
							attachment: {
								type: 'string',
								required: false,
								indexed: false,
								mimeTypes: ['application/pdf']
							}
						}
					}
				]
			})
		);
		await seedAdmin(harness);
		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('admin-token'))
		);
		const collections = value(response)['collections'] as ReadonlyArray<{
			name: string;
			fields: ReadonlyArray<{
				name: string;
				search?: boolean;
				values?: ReadonlyArray<string>;
				customType?: string;
				mimeTypes?: ReadonlyArray<string>;
			}>;
		}>;
		const fields = new Map(
			(collections.find(({ name }) => name === 'requests')?.fields ?? []).map((entry) => [
				entry.name,
				entry
			])
		);
		expect(fields.get('title')?.search).toBe(true);
		expect(fields.get('lifecycle')?.values).toEqual(['DRAFT', 'PAID']);
		expect(fields.get('event')?.customType).toBe('leave_event');
		expect(fields.get('attachment')?.mimeTypes).toEqual(['application/pdf']);
		// A field that declared none of them must not sprout empty keys: `undefined` and "declared
		// empty" are different statements, and a studio reads them differently.
		expect(fields.get('lifecycle')).not.toHaveProperty('search');
	});

	/** Collection presentation metadata survives the artifact and manifest projection. */
	it('carries the collection metadata a studio names', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{
						name: 'people',
						fields: { name: field.string() },
						description: 'Everyone employed here',
						icon: 'lucide:users'
					},
					{ name: 'orders', fields: { total: field.number() } }
				]
			})
		);
		await seedAdmin(harness);
		const response = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('admin-token'))
		);
		const collections = value(response)['collections'] as ReadonlyArray<{
			name: string;
			description?: string;
			icon?: string;
		}>;

		const people = collections.find(({ name }) => name === 'people');
		expect(people?.description).toBe('Everyone employed here');
		expect(people?.icon).toBe('lucide:users');

		// A collection that declared none of them must not sprout empty keys: "no icon" and "an icon
		// whose value is undefined" are different statements, and a studio reads them differently.
		const orders = collections.find(({ name }) => name === 'orders');
		expect(orders).not.toHaveProperty('description');
		expect(orders).not.toHaveProperty('icon');
	});

	it('shows only the collections the caller may read', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{ name: 'people', fields: { name: field.string() } },
					{ name: 'salaries', fields: { amount: field.number() } }
				],
				policies: [
					policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
					policy({
						name: 'viewer',
						effect: 'allow',
						grants: [{ collection: 'people', action: 'read' }]
					})
				],
				teams: {
					admin: ['admin', 'viewer'],
					viewer: ['viewer']
				}
			})
		);
		await seedAdmin(harness);
		// `viewer` reads `people` and not `salaries`, which is the narrowing the two manifests below
		// are compared for.
		await seedSession(harness, {
			token: 'viewer-token',
			user: 'user-viewer-token',
			team: 'viewer'
		});

		const asAdmin = value(
			await harness.runtime.runPromise(dispatchInvocation(manifestInvocation('admin-token')))
		);
		const asViewer = value(
			await harness.runtime.runPromise(dispatchInvocation(manifestInvocation('viewer-token')))
		);
		const namesOf = (manifest: Record<string, unknown>) =>
			(manifest['collections'] as ReadonlyArray<{ name: string }>).map(({ name }) => name);

		expect(namesOf(asAdmin)).toContain('salaries');
		expect(namesOf(asViewer)).toContain('people');
		expect(namesOf(asViewer)).not.toContain('salaries');
	});

	it('refuses an unauthenticated caller', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({ collections: [{ name: 'people', fields: { name: field.string() } }] })
		);
		const outcome = await harness.runtime.runPromise(
			dispatchInvocation(manifestInvocation('not-a-session')).pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
	});

	it('reports declared hook points so a studio can count them per collection', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({ collections: [{ name: 'people', fields: { name: field.string() } }] })
		);
		await seedAdmin(harness);
		const manifest = value(
			await harness.runtime.runPromise(dispatchInvocation(manifestInvocation('admin-token')))
		);
		const collections = manifest['collections'] as ReadonlyArray<{
			name: string;
			hooks: ReadonlyArray<string>;
		}>;
		// A workspace with no `+hooks.ts` reports an empty list, never a missing key — the studio
		// renders a count, and `undefined` would read as "unknown" rather than "none".
		expect(collections.find(({ name }) => name === 'people')?.hooks).toEqual([]);
	});

	it('publishes exact policy grants and authored app presentation', async () => {
		harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{ name: 'people', fields: { name: field.string(), active: field.boolean() } }
				],
				apps: [
					app({
						name: 'directory',
						label: 'People directory',
						description: 'Find everyone in the workspace.',
						icon: 'lucide:users',
						thumbnail: '/assets/directory.webp'
					})
				],
				policies: [
					policy({
						name: 'admin',
						description: 'Reads visible people and updates names.',
						effect: 'allow',
						grants: [
							{
								collection: 'people',
								action: 'read',
								fields: ['name'],
								where: { active: true },
								dependencies: ['teams']
							},
							{ collection: 'people', action: 'update' }
						],
						capabilities: { apps: ['directory'], tools: ['summarize'] }
					})
				],
				teams: {
					admin: ['admin']
				}
			})
		);
		await seedAdmin(harness);
		const manifest = value(
			await harness.runtime.runPromise(dispatchInvocation(manifestInvocation('admin-token')))
		);
		const policies = manifest['policies'] as ReadonlyArray<{
			name: string;
			description: string;
			grants: ReadonlyArray<Record<string, unknown>>;
			capabilities: Record<string, ReadonlyArray<string>>;
		}>;
		const admin = policies.find(({ name }) => name === 'admin');
		expect(admin?.description).toBe('Reads visible people and updates names.');
		expect(admin?.grants).toEqual([
			{
				collection: 'people',
				action: 'read',
				fields: ['name'],
				where: { active: true },
				dependencies: ['teams']
			},
			{ collection: 'people', action: 'update' }
		]);
		expect(admin?.capabilities).toMatchObject({
			apps: ['directory'],
			tools: ['summarize']
		});
		expect(manifest['apps']).toEqual([
			{
				name: 'directory',
				label: 'People directory',
				description: 'Find everyone in the workspace.',
				icon: 'lucide:users',
				thumbnail: '/assets/directory.webp'
			}
		]);
	});
});
