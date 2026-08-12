import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type { HostFileStorageBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { TRUSTED_PERMISSION_BYPASS_HEADER } from '$lib/host/identity.js';
import { workspaceJobs } from '$lib/host/jobs.js';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	TEST_PERMISSION_BYPASS_KEY,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

const APPROVAL_REQUESTOR_ID = '33333333-3333-4333-8333-333333333333';
const APPROVER_ID = '44444444-4444-4444-8444-444444444444';
const APPROVAL_POLICY_ID = '55555555-5555-4555-8555-555555555555';
const APPROVAL_TEAM_ID = '66666666-6666-4666-8666-666666666666';
const APPROVAL_CONFIG_IDS = {
	create: '77777777-7777-4777-8777-777777777771',
	update: '77777777-7777-4777-8777-777777777772',
	delete: '77777777-7777-4777-8777-777777777773'
} as const;

const approvalTeam = [{ id: APPROVAL_TEAM_ID, name: 'RFI reviewers' }] as const;
const storedFiles = new Map<string, Uint8Array>();
const fileStorage: HostFileStorageBinding = {
	put: async (key, body) => {
		storedFiles.set(key, new Uint8Array(body));
	},
	get: async (key) => storedFiles.get(key) ?? null,
	delete: async (key) => void storedFiles.delete(key)
};
const approvalRequestor: Identity = {
	userId: APPROVAL_REQUESTOR_ID,
	userName: 'RFI Requestor',
	email: 'requestor@it.local',
	role: 'basic',
	teamMembers: approvalTeam
};
const approver: Identity = {
	userId: APPROVER_ID,
	userName: 'RFI Approver',
	email: 'approver@it.local',
	role: 'basic',
	teamMembers: approvalTeam
};

/**
 * Hooks on a real collection, written over a private copy of the template.
 *
 * One overlay serves every case in this file because the harness boots once: which branch runs is
 * chosen by the submitted title, so a single `rfis` create exercises exactly one behaviour and the
 * other tests' creates pass through untouched.
 */
const RFI_HOOKS = `import type { Hooks } from './$types.js';

export default {
	create: {
		before: {
			description: 'Normalizes status, priority, and subject before an RFI is stored.',
			handler: async ({ input, api }) => {
				if (input.title === 'refuse-before') {
					throw new Error('probe before hook refused this RFI');
				}
				if (typeof input.title === 'string' && input.title.startsWith('asset:')) {
					await api.readFileAsset(input.title.slice('asset:'.length));
				}
				// The mutation on the way in. \`status\` is deliberately overwritten rather than defaulted:
				// the caller submits 'closed' below, so an unchanged stored row cannot be mistaken for a
				// hook that ran and happened to agree with the input.
				return { ...input, status: 'open', priority: 'high', subject: 'normalized:' + input.title };
			}
		},
		after: {
			description: 'Opens a companion defect for an RFI that asks for one.',
			handler: async ({ record, api }) => {
				if (record.title === 'refuse-after') {
					throw new Error('probe after hook refused this RFI');
				}
				if (typeof record.title === 'string' && record.title.startsWith('derive:')) {
					await api.db.mutate('defects', [
						{
							title: 'derived-from:' + record.title,
							status: 'open',
							severity: 'low',
							description: String(record.norbital_id)
						}
					]);
				}
			}
		}
	},
	update: {
		before: {
			description: 'Normalizes the answer and restamps the subject from the stored title.',
			handler: async ({ input, existing }) => {
				if (input.answer === 'refuse-update-before') {
					throw new Error('probe before hook refused this RFI update');
				}
				return {
					...input,
					answer: 'normalized:' + input.answer,
					subject: 'updated-from:' + existing.title
				};
			}
		},
		after: {
			description: 'Records the answered RFI as a defect for follow-up.',
			handler: async ({ record, api }) => {
				if (record.answer === 'normalized:refuse-update-after') {
					throw new Error('probe after hook refused this RFI update');
				}
				await api.db.mutate('defects', [
					{
						title: 'updated:' + record.title + ':' + record.answer,
						status: 'open',
						severity: 'low',
						description: String(record.norbital_id)
					}
				]);
			}
		}
	},
	delete: {
		before: {
			description: 'Refuses to delete an RFI that is still under review.',
			handler: async ({ existing }) => {
				if (existing.title === 'refuse-delete-before' || existing.title === 'batch-delete-refusal:3') {
					throw new Error('probe before hook refused this RFI delete');
				}
			}
		},
		after: {
			description: 'Leaves a defect noting which RFI was removed.',
			handler: async ({ record, api }) => {
				if (record.title === 'refuse-delete-after') {
					throw new Error('probe after hook refused this RFI delete');
				}
				await api.db.mutate('defects', [
					{
						title: 'deleted:' + record.title,
						status: 'open',
						severity: 'low',
						description: String(record.norbital_id)
					}
				]);
			}
		}
	}
} satisfies Hooks;
`;

/**
 * `defects` is the collection every derived write in this file lands in, so it has to accept one.
 *
 * A collection's definition is `{}` unless something declares a mutation section — `buildMutationSection`
 * returns undefined for an absent section and `allowsMutation` reads exactly that — so the stock
 * `defects` refuses `create` with a 403. Declaring an empty `create` is the ordinary authoring way to
 * say "this collection accepts creates, with no hooks on them", and it is what makes the automation's
 * own write a fair test rather than a permission error dressed up as a failure.
 */
const DEFECTS_HOOKS = `import type { Hooks } from './$types.js';

export default {
	create: {
		after: {
			description: 'Clears the RFIs a batch-cleanup defect names.',
			handler: async ({ record, api }) => {
				if (record.title !== 'delete-rfi-batch-success' && record.title !== 'delete-rfi-batch-refusal') {
					return;
				}
				const prefix = record.title === 'delete-rfi-batch-success'
					? 'batch-delete-success:'
					: 'batch-delete-refusal:';
				const rfis = await api.db.query.rfis.findMany({ limit: 500 });
				const ids = rfis
					.filter((rfi) => typeof rfi.title === 'string' && rfi.title.startsWith(prefix))
					.map((rfi) => String(rfi.norbital_id));
				await api.db.delete('rfis', ids);
			}
		}
	}
} satisfies Hooks;
`;

/** A scheduled automation: the job set derives \`pod:automation:probe_scheduled_sweep\` from this. */
const SCHEDULED_AUTOMATION = `import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ schedule: '0 3 * * *' },
	{
		kind: 'deterministic',
		description: 'Sweeps the open RFIs overnight and files a marker defect with the count.',
		handler: async (api) => {
			const rfis = await api.db.query.rfis.findMany({ limit: 500 });
			await api.db.defects.create({
				title: 'scheduled-sweep-marker',
				status: 'open',
				severity: 'low',
				description: 'swept ' + rfis.length
			});
			return { swept: rfis.length };
		}
	}
);
`;

/** An event-triggered automation. Subscribes to `rfis.created` only — never `updated`. */
const EVENT_AUTOMATION = `import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ trigger: { collection: 'rfis', event: 'created' } },
	{
		kind: 'deterministic',
		description: 'Opens a tracking defect whenever a new RFI is created.',
		handler: async (api, { scope }) => {
			const rfi = scope.incoming_record;
			await api.db.defects.create({
				title: 'event-automation:' + rfi.title,
				status: 'open',
				severity: 'low',
				description: String(rfi.norbital_id)
			});
			return { rfi_id: rfi.norbital_id };
		}
	}
);
`;

type CreateOutcome = { readonly status: number; readonly body: string };

function approvalGrant(action: keyof typeof APPROVAL_CONFIG_IDS): Record<string, unknown> {
	return {
		id: `rfi-${action}-approval`,
		collection_name: 'rfis',
		action,
		conditions: {},
		approval_config: {
			norbital_id: APPROVAL_CONFIG_IDS[action],
			approval_name: `RFI ${action} review`,
			supercede_teams: [],
			conditions: {},
			approval_step_nodes: [
				{
					id: `rfi-${action}-review`,
					name: 'RFI reviewer',
					teams_that_can_approve: [APPROVAL_TEAM_ID],
					description: null,
					conditions: {},
					nextSteps: []
				}
			]
		}
	};
}

describe('Pod automations and hooks — E2E', () => {
	let harness: PodRuntimeHarness;
	let manifest: NorbitalManifest;

	beforeAll(async () => {
		harness = await bootPodRuntime(
			'construction',
			{ fileStorage },
			{
				sources: {
					'src/collections/rfis/+hooks.ts': RFI_HOOKS,
					'src/collections/defects/+hooks.ts': DEFECTS_HOOKS,
					'src/automation/+probe_scheduled_sweep.ts': SCHEDULED_AUTOMATION,
					'src/automation/+probe_rfi_created.ts': EVENT_AUTOMATION
				}
			}
		);
		manifest = (await harness.hostCommand({ kind: 'getManifest' })) as NorbitalManifest;
		// The trusted host normally resolves these memberships into the base scope. The harness inserts
		// the matching rows too, so policy loading and approval actions exercise the same database-backed
		// grants as production rather than treating a forged scope as the grant itself.
		const client = await harness.pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
			await client.query(
				`INSERT INTO "user" (norbital_id, email, name, status, role, kind)
				 VALUES ($1::uuid, $2, $3, 'active', 'basic', 'human'),
				        ($4::uuid, $5, $6, 'active', 'basic', 'human')`,
				[
					APPROVAL_REQUESTOR_ID,
					approvalRequestor.email,
					approvalRequestor.userName,
					APPROVER_ID,
					approver.email,
					approver.userName
				]
			);
			await client.query(
				`INSERT INTO policy (
				   norbital_id, key, name, description, is_active, accessible_applications, grants
				 ) VALUES ($1::uuid, 'automation_hooks_approval_probe', 'Automation hooks approval probe',
				           NULL, TRUE, '[]'::jsonb, $2::jsonb)`,
				[
					APPROVAL_POLICY_ID,
					JSON.stringify([
						approvalGrant('create'),
						approvalGrant('update'),
						approvalGrant('delete')
					])
				]
			);
			await client.query(
				`INSERT INTO team (norbital_id, name, description, is_active, kind, policy_id)
				 VALUES ($1::uuid, 'RFI reviewers', NULL, TRUE, 'human', $2::uuid)`,
				[APPROVAL_TEAM_ID, APPROVAL_POLICY_ID]
			);
			await client.query(
				`INSERT INTO team_members (user_id, team_id)
				 VALUES ($1::uuid, $3::uuid), ($2::uuid, $3::uuid)`,
				[APPROVAL_REQUESTOR_ID, APPROVER_ID, APPROVAL_TEAM_ID]
			);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw cause;
		} finally {
			client.release();
		}
		// Advance the durable cursor past anything the template's own migration/bootstrap left in the
		// change feed, so every assertion below is about rows this file caused.
		await runJob('pod:automation-events');
	}, 240_000);

	afterAll(async () => {
		await harness?.stop();
	});

	/** Drive a job exactly as a host does: from `workspaceJobs`, over the control plane. */
	async function runJob(name: string): Promise<void> {
		const jobs = workspaceJobs({
			manifest,
			dispatch: (body) => harness.hostCommand(body),
			organizationId: harness.orgId
		});
		const job = jobs.find((candidate) => candidate.name === name);
		expect(job, `workspaceJobs did not register ${name}`).toBeDefined();
		await job!.run();
	}

	async function createRfi(
		title: string,
		extra: Record<string, unknown> = {}
	): Promise<CreateOutcome> {
		const response = await harness.request(
			{
				method: 'POST',
				path: 'collections/create',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'rfis', input: { title, ...extra } })
			},
			admin
		);
		return { status: response.status, body: await response.text() };
	}

	async function command(
		path: string,
		body: Record<string, unknown>,
		identity: Identity = admin
	): Promise<CreateOutcome> {
		const response = await harness.request(
			{
				method: 'POST',
				path,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			},
			identity
		);
		return { status: response.status, body: await response.text() };
	}

	async function rfi(title: string): Promise<{
		norbital_id: string;
		title: string;
		answer: string | null;
		subject: string | null;
		approval: string | null;
	}> {
		const result = await harness.pool.query<{
			norbital_id: string;
			title: string;
			answer: string | null;
			subject: string | null;
			approval: string | null;
		}>(
			`SELECT norbital_id, title, answer, subject, norbital_approval_id AS approval
			   FROM rfis WHERE title = $1`,
			[title]
		);
		expect(result.rows, `missing RFI ${title}`).toHaveLength(1);
		return result.rows[0]!;
	}

	async function approvalFor(recordId: string, lockType: 'record_mutation' | 'record_delete') {
		const result = await harness.pool.query<{ norbital_id: string; status: string }>(
			`SELECT norbital_id, status
			   FROM approval_request
			  WHERE locked_record_refs @> $1::jsonb
			  ORDER BY norbital_created_at DESC
			  LIMIT 1`,
			[JSON.stringify([{ collection_name: 'rfis', record_id: recordId, lock_type: lockType }])]
		);
		expect(result.rows, `missing ${lockType} approval for ${recordId}`).toHaveLength(1);
		return result.rows[0]!;
	}

	async function approvalStatus(approvalId: string): Promise<string> {
		const result = await harness.pool.query<{ status: string }>(
			`SELECT status FROM approval_request WHERE norbital_id = $1::uuid`,
			[approvalId]
		);
		return result.rows[0]?.status ?? '';
	}

	async function lockCount(approvalId: string): Promise<number> {
		const result = await harness.pool.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM _approval_lock WHERE approval_request_id = $1::uuid`,
			[approvalId]
		);
		return Number(result.rows[0]?.count ?? 0);
	}

	async function defectTitles(pattern: string): Promise<string[]> {
		const result = await harness.pool.query<{ title: string }>(
			`SELECT title FROM defects WHERE title LIKE $1 ORDER BY title`,
			[pattern]
		);
		return result.rows.map((row) => row.title);
	}

	async function automationRuns(
		name: string
	): Promise<{ status: string; output: Record<string, unknown> | null; error: string | null }[]> {
		const result = await harness.pool.query<{
			status: string;
			output: Record<string, unknown> | null;
			error: string | null;
		}>(
			`SELECT status, output, error FROM automation_run
			  WHERE automation_name = $1 ORDER BY norbital_created_at`,
			[name]
		);
		return result.rows;
	}

	it('runs a scheduled automation from the job set and leaves its effect in the database', async () => {
		// The schedule reaches the host as the workspace declared it — a job registered under the wrong
		// cron fires at the wrong time, which no assertion on the effect alone would catch.
		const jobs = workspaceJobs({
			manifest,
			dispatch: (body) => harness.hostCommand(body),
			organizationId: harness.orgId
		});
		const scheduled = jobs.find((job) => job.name === 'pod:automation:probe_scheduled_sweep');
		expect(scheduled?.schedule).toBe('0 3 * * *');

		expect(await defectTitles('scheduled-sweep-marker')).toEqual([]);
		await runJob('pod:automation:probe_scheduled_sweep');

		// The handler's own write, and the runtime's bookkeeping of the run. Both are rows, not calls.
		expect(await defectTitles('scheduled-sweep-marker')).toEqual(['scheduled-sweep-marker']);
		const runs = await automationRuns('probe_scheduled_sweep');
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe('success');
		expect(runs[0]?.error).toBeNull();
		expect(runs[0]?.output).toMatchObject({ swept: expect.any(Number) });
	});

	it('runs an event automation for a matching mutation and not for a non-matching one', async () => {
		await createRfi('event-probe');

		// Nothing yet: the change feed is dispatched by the pump, not by the mutation that wrote it.
		// An automation that fired inline would also fire on a transaction that later rolled back.
		expect(await defectTitles('event-automation:event-probe')).toEqual([]);

		await runJob('pod:automation-events');
		expect(await defectTitles('event-automation:event-probe')).toEqual([
			'event-automation:event-probe'
		]);
		expect(await automationRuns('probe_rfi_created')).toHaveLength(1);

		// The negative half, twice over: a different collection, and the same collection under a
		// different event. `rfis.updated` is the sharper of the two — a matcher that compared only the
		// collection would pass everything else in this file and still be wrong.
		const created = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id FROM rfis WHERE title = 'event-probe'`
		);
		const updated = await harness.request(
			{
				method: 'POST',
				path: 'collections/update',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					collection: 'rfis',
					record_id: created.rows[0]!.norbital_id,
					input: { answer: 'answered later' }
				})
			},
			admin
		);
		expect(updated.status, await updated.text()).toBe(200);

		const otherCollection = await harness.request(
			{
				method: 'POST',
				path: 'collections/create',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					collection: 'defects',
					input: { title: 'unrelated-defect', status: 'open', severity: 'low' }
				})
			},
			admin
		);
		expect(otherCollection.status, await otherCollection.text()).toBe(200);

		await runJob('pod:automation-events');
		// Still exactly one run and one derived row: neither the update nor the defect matched.
		expect(await automationRuns('probe_rfi_created')).toHaveLength(1);
		expect(await defectTitles('event-automation:%')).toEqual(['event-automation:event-probe']);
	});

	it('stores what a before hook returned, not what the caller submitted', async () => {
		const outcome = await createRfi('before-probe', { status: 'closed', subject: 'raw subject' });
		expect(outcome.status, outcome.body).toBe(200);

		const stored = await harness.pool.query<{
			status: string | null;
			priority: string | null;
			subject: string | null;
		}>(`SELECT status, priority, subject FROM rfis WHERE title = 'before-probe'`);
		expect(stored.rows).toHaveLength(1);
		// Submitted 'closed' / 'raw subject'; the hook rewrote both on the way in.
		expect(stored.rows[0]?.status).toBe('open');
		expect(stored.rows[0]?.subject).toBe('normalized:before-probe');
		expect(stored.rows[0]?.priority).toBe('high');
	});

	it('lands an after hook derived write alongside the record that caused it', async () => {
		const outcome = await createRfi('derive:probe');
		expect(outcome.status, outcome.body).toBe(200);

		const rfi = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id FROM rfis WHERE title = 'derive:probe'`
		);
		expect(rfi.rows).toHaveLength(1);
		const derived = await harness.pool.query<{ description: string | null }>(
			`SELECT description FROM defects WHERE title = 'derived-from:derive:probe'`
		);
		expect(derived.rows).toHaveLength(1);
		// The derived row points back at the record the hook was handed, so this is that create's
		// effect and not a coincidence of titles.
		expect(derived.rows[0]?.description).toBe(rfi.rows[0]!.norbital_id);
	});

	it('runs authored update hooks against the original row and the stored result', async () => {
		expect((await createRfi('update-probe', { answer: 'original' })).status).toBe(200);
		const existing = await rfi('update-probe');
		const outcome = await command('collections/update', {
			collection: 'rfis',
			record_id: existing.norbital_id,
			input: { answer: 'answered' }
		});
		expect(outcome.status, outcome.body).toBe(200);

		const stored = await rfi('update-probe');
		expect(stored.answer).toBe('normalized:answered');
		expect(stored.subject).toBe('updated-from:update-probe');
		expect(await defectTitles('updated:update-probe:%')).toEqual([
			'updated:update-probe:normalized:answered'
		]);
	});

	it('rolls a single update back when either authored phase refuses it', async () => {
		await createRfi('update-refused-before', { answer: 'original' });
		await createRfi('update-refused-after', { answer: 'original' });
		const before = await rfi('update-refused-before');
		const after = await rfi('update-refused-after');

		const beforeOutcome = await command('collections/update', {
			collection: 'rfis',
			record_id: before.norbital_id,
			input: { answer: 'refuse-update-before' }
		});
		expect(beforeOutcome.status).not.toBe(200);
		expect(beforeOutcome.body).toContain('probe before hook refused this RFI update');

		const afterOutcome = await command('collections/update', {
			collection: 'rfis',
			record_id: after.norbital_id,
			input: { answer: 'refuse-update-after' }
		});
		expect(afterOutcome.status).not.toBe(200);
		expect(afterOutcome.body).toContain('probe after hook refused this RFI update');

		expect((await rfi('update-refused-before')).answer).toBe('original');
		expect((await rfi('update-refused-after')).answer).toBe('original');
		expect(await defectTitles('updated:update-refused-%')).toEqual([]);
	});

	it('runs authored delete hooks and rolls the delete back when either phase refuses it', async () => {
		await createRfi('delete-probe');
		await createRfi('refuse-delete-before');
		await createRfi('refuse-delete-after');

		const deleted = await rfi('delete-probe');
		const success = await command('collections/deleteRecord', {
			collection: 'rfis',
			record_id: deleted.norbital_id
		});
		expect(success.status, success.body).toBe(200);
		expect(
			await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'delete-probe'`)
		).toMatchObject({
			rowCount: 0
		});
		expect(await defectTitles('deleted:delete-probe')).toEqual(['deleted:delete-probe']);

		for (const title of ['refuse-delete-before', 'refuse-delete-after']) {
			const existing = await rfi(title);
			const outcome = await command('collections/deleteRecord', {
				collection: 'rfis',
				record_id: existing.norbital_id
			});
			expect(outcome.status).not.toBe(200);
			expect((await rfi(title)).norbital_id).toBe(existing.norbital_id);
		}
		expect(await defectTitles('deleted:refuse-delete-%')).toEqual([]);
	});

	it('runs authored create hooks for every batch item and rejects the whole batch before writing', async () => {
		const success = await command('collections/createMany', {
			collection: 'rfis',
			inputs: [{ title: 'derive:batch-create:1' }, { title: 'derive:batch-create:2' }]
		});
		expect(success.status, success.body).toBe(200);
		expect(await defectTitles('derived-from:derive:batch-create:%')).toEqual([
			'derived-from:derive:batch-create:1',
			'derived-from:derive:batch-create:2'
		]);

		const refused = await command('collections/createMany', {
			collection: 'rfis',
			inputs: [
				{ title: 'batch-create-refused:1' },
				{ title: 'batch-create-refused:2' },
				{ title: 'refuse-before' },
				{ title: 'batch-create-refused:4' }
			]
		});
		expect(refused.status).not.toBe(200);
		const rows = await harness.pool.query(
			`SELECT 1 FROM rfis WHERE title LIKE 'batch-create-refused:%' OR title = 'refuse-before'`
		);
		expect(rows.rowCount).toBe(0);
	});

	it('lets a valid host bypass seed every collection through createMany without skipping hooks', async () => {
		const teamId = '88888888-8888-4888-8888-888888888888';
		const hostElevatedTeamId = '88888888-8888-4888-8888-888888888887';
		const seededAt = '2026-07-03T03:00:00.000Z';
		const refused = await command('collections/createMany', {
			collection: 'team',
			bypass_secret: 'not-the-host-secret',
			inputs: [{ norbital_id: teamId, name: 'Seeded through collection ops', is_active: true }]
		});
		expect(refused.status).toBe(403);

		const systemCreated = await command('collections/createMany', {
			collection: 'team',
			bypass_secret: TEST_PERMISSION_BYPASS_KEY,
			inputs: [
				{
					norbital_id: teamId,
					norbital_created_at: seededAt,
					norbital_updated_at: seededAt,
					name: 'Seeded through collection ops',
					is_active: true
				}
			]
		});
		expect(systemCreated.status, systemCreated.body).toBe(200);
		const hostElevated = await harness.request(
			{
				method: 'POST',
				path: 'collections/createMany',
				headers: {
					'content-type': 'application/json',
					[TRUSTED_PERMISSION_BYPASS_HEADER]: '1'
				},
				body: JSON.stringify({
					collection: 'team',
					inputs: [
						{
							norbital_id: hostElevatedTeamId,
							name: 'Seeded through ephemeral host capability',
							is_active: true
						}
					]
				})
			},
			admin
		);
		expect(hostElevated.status, await hostElevated.text()).toBe(200);
		const hostHooked = await harness.request(
			{
				method: 'POST',
				path: 'collections/createMany',
				headers: {
					'content-type': 'application/json',
					[TRUSTED_PERMISSION_BYPASS_HEADER]: '1'
				},
				body: JSON.stringify({
					collection: 'rfis',
					inputs: [{ title: 'derive:ephemeral-host-capability' }]
				})
			},
			admin
		);
		expect(hostHooked.status, await hostHooked.text()).toBe(200);
		expect(await defectTitles('derived-from:derive:ephemeral-host-capability')).toEqual([
			'derived-from:derive:ephemeral-host-capability'
		]);
		expect(
			await harness.pool.query(
				`SELECT name, norbital_created_at::text FROM team WHERE norbital_id = $1::uuid`,
				[teamId]
			)
		).toMatchObject({
			rows: [
				{
					name: 'Seeded through collection ops',
					norbital_created_at: '2026-07-03 03:00:00+00'
				}
			]
		});

		const assetId = '88888888-8888-4888-8888-888888888889';
		const storageKey = 'seed/elevated-hook-asset.txt';
		const bytes = new TextEncoder().encode('elevated hook asset');
		storedFiles.set(storageKey, bytes);
		const assetCreated = await command('collections/createMany', {
			collection: 'document_asset',
			bypass_secret: TEST_PERMISSION_BYPASS_KEY,
			inputs: [
				{
					norbital_id: assetId,
					owner_user_id: APPROVAL_REQUESTOR_ID,
					file_name: 'elevated-hook-asset.txt',
					mime_type: 'text/plain',
					file_size: bytes.byteLength,
					storage_key: storageKey
				}
			]
		});
		expect(assetCreated.status, assetCreated.body).toBe(200);
		const ordinaryAssetRead = await command('collections/createMany', {
			collection: 'rfis',
			inputs: [{ title: `asset:${assetId}` }]
		});
		expect(ordinaryAssetRead.status).toBe(500);
		expect(ordinaryAssetRead.body).toContain(
			'The selected file asset is not accessible to this requestor.'
		);

		const hooked = await command('collections/createMany', {
			collection: 'rfis',
			bypass_secret: TEST_PERMISSION_BYPASS_KEY,
			inputs: [
				{
					norbital_id: '99999999-9999-4999-8999-999999999999',
					title: `asset:${assetId}`
				}
			]
		});
		expect(hooked.status, hooked.body).toBe(200);
		expect((JSON.parse(hooked.body) as Array<{ norbital_id: string }>)[0]?.norbital_id).toBe(
			'99999999-9999-4999-8999-999999999999'
		);
	});

	it('runs authored update hooks for every batch item and rejects the whole batch before writing', async () => {
		for (const title of ['batch-update:1', 'batch-update:2', 'batch-update:3']) {
			await createRfi(title, { answer: 'original' });
		}
		const records = await Promise.all(
			['batch-update:1', 'batch-update:2', 'batch-update:3'].map(rfi)
		);
		const success = await command('collections/updateMany', {
			collection: 'rfis',
			updates: records.map((record, index) => ({
				record_id: record.norbital_id,
				input: { answer: `batch-success-${index + 1}` }
			}))
		});
		expect(success.status, success.body).toBe(200);
		expect(
			await Promise.all(records.map((record) => rfi(record.title).then((row) => row.answer)))
		).toEqual([
			'normalized:batch-success-1',
			'normalized:batch-success-2',
			'normalized:batch-success-3'
		]);

		const refused = await command('collections/updateMany', {
			collection: 'rfis',
			updates: records.map((record, index) => ({
				record_id: record.norbital_id,
				input: { answer: index === 2 ? 'refuse-update-before' : `must-not-land-${index}` }
			}))
		});
		expect(refused.status).not.toBe(200);
		expect(
			await Promise.all(records.map((record) => rfi(record.title).then((row) => row.answer)))
		).toEqual([
			'normalized:batch-success-1',
			'normalized:batch-success-2',
			'normalized:batch-success-3'
		]);
		expect(await defectTitles('updated:batch-update:%must-not-land%')).toEqual([]);
	});

	it('runs authored delete hooks for an elevated batch and rolls its driver back on item three', async () => {
		for (const title of [
			'batch-delete-success:1',
			'batch-delete-success:2',
			'batch-delete-success:3'
		]) {
			await createRfi(title);
		}
		const success = await command('collections/create', {
			collection: 'defects',
			input: { title: 'delete-rfi-batch-success', status: 'open', severity: 'low' }
		});
		expect(success.status, success.body).toBe(200);
		expect(
			await harness.pool.query(`SELECT 1 FROM rfis WHERE title LIKE 'batch-delete-success:%'`)
		).toMatchObject({ rowCount: 0 });
		expect(await defectTitles('deleted:batch-delete-success:%')).toEqual([
			'deleted:batch-delete-success:1',
			'deleted:batch-delete-success:2',
			'deleted:batch-delete-success:3'
		]);

		for (const title of [
			'batch-delete-refusal:1',
			'batch-delete-refusal:2',
			'batch-delete-refusal:3'
		]) {
			await createRfi(title);
		}
		const refused = await command('collections/create', {
			collection: 'defects',
			input: { title: 'delete-rfi-batch-refusal', status: 'open', severity: 'low' }
		});
		expect(refused.status).not.toBe(200);
		expect(
			await harness.pool.query(`SELECT 1 FROM rfis WHERE title LIKE 'batch-delete-refusal:%'`)
		).toMatchObject({ rowCount: 3 });
		expect(await defectTitles('delete-rfi-batch-refusal')).toEqual([]);
		expect(await defectTitles('deleted:batch-delete-refusal:%')).toEqual([]);
	});

	it('approves real gated create, update, and delete requests and releases every lock', async () => {
		const createTitle = 'derive:approval-create-approved';
		const createdOutcome = await command(
			'collections/create',
			{ collection: 'rfis', input: { title: createTitle } },
			approvalRequestor
		);
		expect(createdOutcome.status, createdOutcome.body).toBe(200);
		const created = await rfi(createTitle);
		const createApproval = await approvalFor(created.norbital_id, 'record_mutation');
		expect(created.approval).toBe(createApproval.norbital_id);

		await createRfi('approval-update-approved', { answer: 'original' });
		const updateOriginal = await rfi('approval-update-approved');
		const updatedOutcome = await command(
			'collections/update',
			{
				collection: 'rfis',
				record_id: updateOriginal.norbital_id,
				input: { answer: 'approved-answer' }
			},
			approvalRequestor
		);
		expect(updatedOutcome.status, updatedOutcome.body).toBe(200);
		const provisionalUpdate = await rfi('approval-update-approved');
		const updateApproval = await approvalFor(updateOriginal.norbital_id, 'record_mutation');
		expect(provisionalUpdate).toMatchObject({
			answer: 'normalized:approved-answer',
			approval: updateApproval.norbital_id
		});

		await createRfi('approval-delete-approved');
		const deleteOriginal = await rfi('approval-delete-approved');
		const deletedOutcome = await command(
			'collections/deleteRecord',
			{ collection: 'rfis', record_id: deleteOriginal.norbital_id },
			approvalRequestor
		);
		expect(deletedOutcome.status, deletedOutcome.body).toBe(200);
		const deleteApproval = await approvalFor(deleteOriginal.norbital_id, 'record_delete');
		expect(
			await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'approval-delete-approved'`)
		).toMatchObject({ rowCount: 0 });

		// After hooks belong to the provisional mutation transaction. All three have already fired while
		// their approvals are ONGOING; resolving the approval must not replay them.
		expect(await defectTitles('derived-from:derive:approval-create-approved')).toHaveLength(1);
		expect(await defectTitles('updated:approval-update-approved:%')).toHaveLength(1);
		expect(await defectTitles('deleted:approval-delete-approved')).toHaveLength(1);

		for (const approval of [createApproval, updateApproval, deleteApproval]) {
			expect(approval.status).toBe('ONGOING');
			expect(await lockCount(approval.norbital_id)).toBe(1);
			const outcome = await command(
				'remotes/processApprovalRequestAction',
				{
					approval_request_id: approval.norbital_id,
					action: 'APPROVED',
					comments: null,
					isSupercede: false
				},
				approver
			);
			expect(outcome.status, outcome.body).toBe(200);
			expect(await approvalStatus(approval.norbital_id)).toBe('APPROVED');
			expect(await lockCount(approval.norbital_id)).toBe(0);
		}

		expect(await rfi(createTitle)).toMatchObject({ approval: null });
		expect(await rfi('approval-update-approved')).toMatchObject({
			answer: 'normalized:approved-answer',
			approval: null
		});
		expect(
			await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'approval-delete-approved'`)
		).toMatchObject({ rowCount: 0 });
		expect(await defectTitles('derived-from:derive:approval-create-approved')).toHaveLength(1);
		expect(await defectTitles('updated:approval-update-approved:%')).toHaveLength(1);
		expect(await defectTitles('deleted:approval-delete-approved')).toHaveLength(1);
	});

	it('withdraws real gated create, update, and delete requests and restores prior record state', async () => {
		const createTitle = 'derive:approval-create-withdrawn';
		const createdOutcome = await command(
			'collections/create',
			{ collection: 'rfis', input: { title: createTitle } },
			approvalRequestor
		);
		expect(createdOutcome.status, createdOutcome.body).toBe(200);
		const created = await rfi(createTitle);
		const createApproval = await approvalFor(created.norbital_id, 'record_mutation');

		await createRfi('approval-update-withdrawn', { answer: 'original' });
		const updateOriginal = await rfi('approval-update-withdrawn');
		const updatedOutcome = await command(
			'collections/update',
			{
				collection: 'rfis',
				record_id: updateOriginal.norbital_id,
				input: { answer: 'must-be-restored' }
			},
			approvalRequestor
		);
		expect(updatedOutcome.status, updatedOutcome.body).toBe(200);
		const updateApproval = await approvalFor(updateOriginal.norbital_id, 'record_mutation');

		await createRfi('approval-delete-withdrawn');
		const deleteOriginal = await rfi('approval-delete-withdrawn');
		const deletedOutcome = await command(
			'collections/deleteRecord',
			{ collection: 'rfis', record_id: deleteOriginal.norbital_id },
			approvalRequestor
		);
		expect(deletedOutcome.status, deletedOutcome.body).toBe(200);
		const deleteApproval = await approvalFor(deleteOriginal.norbital_id, 'record_delete');

		for (const approval of [createApproval, updateApproval, deleteApproval]) {
			expect(await lockCount(approval.norbital_id)).toBe(1);
			const outcome = await command(
				'remotes/withdrawApprovalRequest',
				{ approval_request_id: approval.norbital_id },
				approvalRequestor
			);
			expect(outcome.status, outcome.body).toBe(200);
			expect(await approvalStatus(approval.norbital_id)).toBe('REJECTED');
			expect(await lockCount(approval.norbital_id)).toBe(0);
		}

		expect(
			await harness.pool.query(`SELECT 1 FROM rfis WHERE title = $1`, [createTitle])
		).toMatchObject({
			rowCount: 0
		});
		expect(await rfi('approval-update-withdrawn')).toMatchObject({
			answer: 'original',
			approval: null
		});
		expect(await rfi('approval-delete-withdrawn')).toMatchObject({
			norbital_id: deleteOriginal.norbital_id,
			approval: null
		});

		// A rejection restores only the locked record. Derived writes produced by its request-time after
		// hook are separate records: the terminal transition neither replays nor deletes them.
		expect(await defectTitles('derived-from:derive:approval-create-withdrawn')).toHaveLength(1);
		expect(await defectTitles('updated:approval-update-withdrawn:%')).toHaveLength(1);
		expect(await defectTitles('deleted:approval-delete-withdrawn')).toHaveLength(1);
	});

	it('refuses the mutation and leaves nothing behind when a before hook throws', async () => {
		const outcome = await createRfi('refuse-before');
		expect(outcome.status).not.toBe(200);
		expect(outcome.body).toContain('probe before hook refused this RFI');

		const rows = await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'refuse-before'`);
		expect(rows.rowCount).toBe(0);
	});

	it('rolls the record back when an after hook throws, because it runs inside the write transaction', async () => {
		const watermark = await harness.pool.query<{ seq: string | null }>(
			`SELECT MAX(seq)::text AS seq FROM sync_outbox`
		);
		const outcome = await createRfi('refuse-after');
		expect(outcome.status).not.toBe(200);

		// The load-bearing assertion of this file's transaction claim: the insert had already returned
		// before the after hook ran, so a row surviving here would mean the after hook sits outside the
		// transaction and every derived write in the suite above could be orphaned by a later failure.
		const rows = await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'refuse-after'`);
		expect(rows.rowCount).toBe(0);

		// And nothing partial anywhere else: the change feed must not carry a row that no longer exists.
		const outbox = await harness.pool.query(
			`SELECT 1 FROM sync_outbox
			  WHERE seq > $1
			    AND collection = 'rfis'
			    AND record_id NOT IN (SELECT norbital_id FROM rfis)`,
			[Number(watermark.rows[0]?.seq ?? 0)]
		);
		expect(outbox.rowCount).toBe(0);
	});
});
