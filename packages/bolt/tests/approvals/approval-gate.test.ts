import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { PendingApproval } from '../../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * A valid record id for a readable fixture name.
 *
 * Records are keyed by `id uuid`. Names like `'person-1'` were only ever accepted by the
 * `id text` primary key Bolt used to invent, so these fixtures built rows a real database would have
 * rejected — and passed anyway.
 */
const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

/**
 * The approval gate over real SQL.
 *
 * Approval was the one core system whose only evidence was a live probe. What a probe cannot show is
 * the part that matters most here — that a held write leaves *nothing* behind. `approvalLock` is a
 * claim about the database, so it is checked against the database.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const gatedWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'people',
			fields: { name: field.string({ required: true }) },
			approvalLock: true
		})
	],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

const rowCount = async (runtime: BoltTestRuntime, name: string): Promise<number> => {
	const rows = await runtime.database.query(`select count(*)::int as total from ${name}`);
	const [row] = rows;
	return typeof row?.['total'] === 'number' ? row['total'] : -1;
};

describe('approval gate over SQL', () => {
	it('writes the row a gated create requested, and holds it under the approval', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);
		const { runtime, effectId } = harness;

		const failure = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					yield* collections.create(effectId('create-held'), adminSubject, {
						collection: 'people',
						id: rid('person-1'),
						values: { name: 'Ada' }
					});
				})
			)
		);

		expect(failure).toBeInstanceOf(PendingApproval);
		expect(failure).toMatchObject({ collection: 'people', id: rid('person-1'), action: 'create' });
		// The point of the gate is not that the record is absent — it is that it is not settled. The row
		// is written so a reviewer has something to open and the table has something to badge, and it
		// carries the request that holds it, which is what every later mutation checks.
		expect(await rowCount(harness, 'people')).toBe(1);
		const held = await harness.database.query('select approval_id from people where id = $1', [
			rid('person-1')
		]);
		expect(held[0]?.['approval_id']).toEqual(expect.any(String));
	});

	it('records the held request so a reviewer can find and read it', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);
		const { runtime, effectId } = harness;

		const failure = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).create(effectId('create-held'), adminSubject, {
						collection: 'people',
						id: rid('person-2'),
						values: { name: 'Grace' }
					});
				})
			)
		);
		const requestId = failure instanceof PendingApproval ? failure.requestId : '';
		expect(requestId).not.toBe('');

		const state = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(effectId('status'), requestId);
			})
		);
		expect(state?._tag).toBe('Pending');

		// The operation is kept whole. A reviewer approves the write that was actually requested, not
		// a reconstruction of it.
		const rows = await harness.database.query(
			'select collection_name, record_id, action, status from approval_request'
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			collection_name: 'people',
			record_id: rid('person-2'),
			action: 'create'
		});
	});

	it('leaves an ungated collection alone', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(effectId('create-direct'), adminSubject, {
					collection: 'people',
					id: rid('person-3'),
					values: { name: 'Ada' }
				});
			})
		);

		expect(await rowCount(harness, 'people')).toBe(1);
		expect(await harness.database.query('select 1 from approval_request')).toHaveLength(0);
	});

	it('holds each write independently rather than letting one decision cover a batch', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);
		const { runtime, effectId } = harness;

		const failure = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).createMany(effectId('create-many'), adminSubject, [
						{ collection: 'people', id: rid('person-4'), values: { name: 'Ada' } },
						{ collection: 'people', id: rid('person-5'), values: { name: 'Grace' } }
					]);
				})
			)
		);

		expect(failure).toBeInstanceOf(PendingApproval);
		// Each row is written and held on its own request; a batch is not one decision.
		expect(await rowCount(harness, 'people')).toBe(1);
	});

	it('replicates a held write, because a reviewer reads through the replica', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).create(effectId('create-held'), adminSubject, {
						collection: 'people',
						id: rid('person-6'),
						values: { name: 'Ada' }
					});
				})
			)
		);

		// A held record has to reach the replica. The decision surface reads a row's
		// `approval_id` to know it is pending and to offer approve/reject on it, and it reads
		// through the replica like everything else — so a record withheld until approval is a record
		// nobody can approve. Who may see it is still the access predicate's question, not this one's.
		const outbox = (await harness.database.query(
			"select operation, record from bolt_sync_outbox where collection_name = 'people' order by xid, sequence"
		)) as ReadonlyArray<{ readonly operation: string; readonly record: unknown }>;
		// Legacy `create` publishes the inserted row and then the approval lock that makes it held. The
		// replica applies both in cursor order, so the reviewer ends on the locked representation. The
		// declarative browser mutation path is different by contract: it holds before a domain row exists.
		expect(outbox).toHaveLength(2);
		expect(outbox.map(({ operation }) => operation)).toEqual(['create', 'update']);
		expect(outbox[1]?.record).toMatchObject({ approval_id: expect.any(String) });
	});
});
