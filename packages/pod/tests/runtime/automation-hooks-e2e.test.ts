import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { workspaceJobs } from '$lib/bin/invocation/jobs.js';
import { dockerAvailable } from '../support/pg-harness.js';
import { bootPodRuntime, type Identity, type PodRuntimeHarness } from '../support/pod-runtime-harness.js';

const hasDocker = dockerAvailable();

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
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
		before: async ({ input }) => {
			if (input.title === 'refuse-before') {
				throw new Error('probe before hook refused this RFI');
			}
			// The mutation on the way in. \`status\` is deliberately overwritten rather than defaulted:
			// the caller submits 'closed' below, so an unchanged stored row cannot be mistaken for a
			// hook that ran and happened to agree with the input.
			return { ...input, status: 'open', priority: 'high', subject: 'normalized:' + input.title };
		},
		after: async ({ record, api }) => {
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
	},
	// Declared, with no hooks on it, so the negative case below can issue a real \`rfis\` update. An
	// undeclared section is a 403, which would have proved the automation did not fire for the wrong
	// reason — the mutation never happened at all.
	update: {}
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

export default { create: {} } satisfies Hooks;
`;

/** A scheduled automation: the job set derives \`pod:automation:probe_scheduled_sweep\` from this. */
const SCHEDULED_AUTOMATION = `import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation({ schedule: '0 3 * * *' }, async (api) => {
	const rfis = await api.db.query.rfis.findMany({ limit: 500 });
	await api.db.defects.create({
		title: 'scheduled-sweep-marker',
		status: 'open',
		severity: 'low',
		description: 'swept ' + rfis.length
	});
	return { swept: rfis.length };
});
`;

/** An event-triggered automation. Subscribes to `rfis.created` only — never `updated`. */
const EVENT_AUTOMATION = `import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ trigger: { collection: 'rfis', event: 'created' } },
	async (api, { scope }) => {
		const rfi = scope.incoming_record;
		await api.db.defects.create({
			title: 'event-automation:' + rfi.title,
			status: 'open',
			severity: 'low',
			description: String(rfi.norbital_id)
		});
		return { rfi_id: rfi.norbital_id };
	}
);
`;

type CreateOutcome = { readonly status: number; readonly body: string };

describe.skipIf(!hasDocker)('Pod automations and hooks — E2E', () => {
	let harness: PodRuntimeHarness;
	let manifest: NorbitalManifest;

	beforeAll(async () => {
		harness = await bootPodRuntime(
			'construction',
			{},
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

	async function createRfi(title: string, extra: Record<string, unknown> = {}): Promise<CreateOutcome> {
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

	it('refuses the mutation and leaves nothing behind when a before hook throws', async () => {
		const outcome = await createRfi('refuse-before');
		expect(outcome.status).not.toBe(200);
		expect(outcome.body).toContain('probe before hook refused this RFI');

		const rows = await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'refuse-before'`);
		expect(rows.rowCount).toBe(0);
	});

	it('rolls the record back when an after hook throws, because it runs inside the write transaction', async () => {
		const outcome = await createRfi('refuse-after');
		expect(outcome.status).not.toBe(200);

		// The load-bearing assertion of this file's transaction claim: the insert had already returned
		// before the after hook ran, so a row surviving here would mean the after hook sits outside the
		// transaction and every derived write in the suite above could be orphaned by a later failure.
		const rows = await harness.pool.query(`SELECT 1 FROM rfis WHERE title = 'refuse-after'`);
		expect(rows.rowCount).toBe(0);

		// And nothing partial anywhere else: the change feed must not carry a row that no longer exists.
		const outbox = await harness.pool.query(
			`SELECT 1 FROM sync_outbox WHERE collection = 'rfis' AND record_id NOT IN (SELECT norbital_id FROM rfis)`
		);
		expect(outbox.rowCount).toBe(0);
	});
});
