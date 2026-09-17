import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		people: {
			create: { input: { columns: { name: true, team: true } } },
			update: { input: { columns: { name: true, team: true } } }
		}
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const write = (
	runtime: BoltTestRuntime,
	effectId: string,
	action: 'create' | 'update',
	input: Readonly<Record<string, unknown>>,
	subject = adminSubject
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			return yield* collections.write(runtime.effectId(effectId), subject, [
				{ collection: 'people', action, inputs: [input] }
			]);
		})
	);

describe('collection history', () => {
	it('stores update snapshots as JSONB through the connectionless query composer', async () => {
		harness = await makeBoltTestRuntime(undefined, { authored });
		const recordId = '00000000-0000-4000-8000-000000000072';

		await write(harness, 'history-create', 'create', {
			id: recordId,
			name: 'Ada',
			team: 'Research'
		});
		await write(harness, 'history-update', 'update', { id: recordId, team: 'Platform' });

		const rows = await harness.database.query(
			'select snapshot from bolt_collection_history where collection_name = $1 and record_id = $2 and operation = $3',
			['people', recordId, 'update']
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.['snapshot']).toEqual({ team: 'Platform' });
	});

	it('normalizes persisted patches into chronological full-record revisions', async () => {
		harness = await makeBoltTestRuntime();
		const recordId = '00000000-0000-4000-8000-000000000071';
		const instants = [
			'2026-08-24T01:00:00.000Z',
			'2026-08-24T02:00:00.000Z',
			'2026-08-24T03:00:00.000Z'
		] as const;

		// The record itself, because history is answered through the current row: a record that is
		// absent and one the predicate hides are deliberately the same answer, so a patch log with no
		// row behind it reads as nothing rather than as a record somebody may no longer see.
		await harness.database.query('insert into people (id, name, team) values ($1, $2, $3)', [
			recordId,
			'Ada Lovelace',
			'Platform'
		]);
		await harness.database.query(
			`insert into bolt_collection_history
				(sequence, collection_name, record_id, operation, subject_id, snapshot, created_at)
			values
				(1, 'people', $1, 'create', 'admin-1', $2::jsonb, $3),
				(2, 'people', $1, 'update', 'admin-1', $4::jsonb, $5),
				(3, 'people', $1, 'update', 'admin-1', $6::jsonb, $7)`,
			[
				recordId,
				JSON.stringify({ name: 'Ada', team: 'Research' }),
				instants[0],
				JSON.stringify({ name: 'Ada Lovelace' }),
				instants[1],
				JSON.stringify({ team: 'Platform' }),
				instants[2]
			]
		);

		const history = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.history(
					harness!.effectId('history-normalization'),
					adminSubject,
					'people',
					recordId
				);
			})
		);

		expect(history).toEqual([
			{
				values: { name: 'Ada', team: 'Research' },
				validFrom: instants[0],
				validTo: instants[1],
				version: 1
			},
			{
				values: { name: 'Ada Lovelace', team: 'Research' },
				validFrom: instants[1],
				validTo: instants[2],
				version: 2
			},
			{
				values: { name: 'Ada Lovelace', team: 'Platform' },
				validFrom: instants[2],
				validTo: null,
				version: 3
			}
		]);
	});
});

describe('collection history horizon', () => {
	it('folds a record’s log to the horizon with one prune per batch', async () => {
		harness = await makeBoltTestRuntime(undefined, { authored });
		const recordId = '00000000-0000-4000-8000-000000000073';
		await write(harness, 'horizon-create', 'create', { id: recordId, name: 'Ada', team: 'T0' });
		for (let step = 1; step <= 260; step += 1)
			await write(harness, `horizon-update-${step}`, 'update', { id: recordId, team: `T${step}` });
		const rows = await harness.database.query(
			'select operation, snapshot from bolt_collection_history where collection_name = $1 and record_id = $2 order by sequence',
			['people', recordId]
		);
		// 261 entries were written; the log holds the horizon, and its oldest survivor carries the
		// folded state of everything pruned before it.
		expect(rows.length).toBeLessThanOrEqual(256);
		expect(rows.length).toBeGreaterThan(200);
		const oldest = rows[0]?.['snapshot'] as Record<string, unknown>;
		expect(oldest['name']).toBe('Ada');
		expect(String(oldest['team'])).toMatch(/^T\d+$/);
		expect(rows.at(-1)?.['snapshot']).toEqual({ team: 'T260' });
	});

	it('reads the state an anchor names: a revision ordinal or an instant', async () => {
		harness = await makeBoltTestRuntime();
		const recordId = '00000000-0000-4000-8000-000000000073';
		const instants = [
			'2026-08-24T01:00:00.000Z',
			'2026-08-24T02:00:00.000Z',
			'2026-08-24T03:00:00.000Z'
		] as const;
		await harness.database.query('insert into people (id, name, team) values ($1, $2, $3)', [
			recordId,
			'Ada Lovelace',
			'Platform'
		]);
		await harness.database.query(
			`insert into bolt_collection_history
				(sequence, collection_name, record_id, operation, subject_id, snapshot, created_at)
			values
				(1, 'people', $1, 'create', 'admin-1', $2::jsonb, $3),
				(2, 'people', $1, 'update', 'admin-1', $4::jsonb, $5),
				(3, 'people', $1, 'update', 'admin-1', $6::jsonb, $7)`,
			[
				recordId,
				JSON.stringify({ name: 'Ada', team: 'Research' }),
				instants[0],
				JSON.stringify({ name: 'Ada Lovelace' }),
				instants[1],
				JSON.stringify({ team: 'Platform' }),
				instants[2]
			]
		);
		const read = (
			at?: Readonly<{ readonly revision: number }> | Readonly<{ readonly instant: string }>
		) =>
			harness!.runtime.runPromise(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.history(
						harness!.effectId('history-anchor'),
						adminSubject,
						'people',
						recordId,
						at
					);
				})
			);
		expect((await read({ revision: 1 }))[0]?.values).toMatchObject({
			name: 'Ada',
			team: 'Research'
		});
		expect((await read({ revision: 2 }))[0]?.values).toMatchObject({
			name: 'Ada Lovelace',
			team: 'Research'
		});
		expect((await read({ revision: 3 }))[0]?.values).toMatchObject({
			name: 'Ada Lovelace',
			team: 'Platform'
		});
		// A future instant reconstructs everything, so the last revision is the live state.
		expect((await read({ instant: '2026-08-25T00:00:00.000Z' }))[0]?.values).toMatchObject({
			name: 'Ada Lovelace',
			team: 'Platform'
		});
		// An instant between the create and the first update stops at the create.
		expect((await read({ instant: '2026-08-24T01:30:00.000Z' }))[0]?.values).toMatchObject({
			name: 'Ada',
			team: 'Research'
		});
		// Before the record existed there is no revision to read.
		expect(await read({ instant: '2026-08-24T00:30:00.000Z' })).toEqual([]);
		// No anchor still answers every revision.
		expect(await read()).toHaveLength(3);
	});

	/**
	 * RFC §4.8: a write policy routes to approval is committed provisionally under a hold, and the
	 * `hold` revision is the record's restore point. `{ before: approvalId }` reads the record as it
	 * stood before the hold; the hold revision itself never changes what the log has said.
	 */
	it('reads the restore point of an approval with { before: approvalId }', async () => {
		const gated = describePolicy('admin', {
			description: 'Edits to people are reviewed.',
			grants: {
				people: {
					read: {},
					mutate: {
						new: {},
						existing: { approval: { flow: () => approveBy('reviewers'), superceded_by: [] } }
					}
				}
			}
		});
		const definition = testWorkspace({
			policies: [gated],
			teams: { admin: ['admin'], reviewers: [] }
		});
		const functions = policyRuntimeFunctionsFor(definition.policies);
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...authored,
				policyAuthorizations: functions.authorizations,
				approvalFlows: functions.approvalFlows
			}
		});
		const requestor = { ...adminSubject, admin: false };
		const created = await write(
			harness,
			'hold-create',
			'create',
			{ name: 'Ada', team: 'Research' },
			requestor
		);
		const recordId = String(created.records[0]?.['id']);
		const held = await write(
			harness,
			'hold-update',
			'update',
			{ id: recordId, team: 'Platform' },
			requestor
		);
		const requestId = held.pendingApproval?.requestId;
		if (requestId === undefined) throw new Error('the reviewed update opened no approval request');

		// The provisional value is live and stamped; the hold revision carries the pre-image.
		expect(await harness.database.query('select team, approval_id from people')).toEqual([
			{ team: 'Platform', approval_id: requestId }
		]);
		const holds = await harness.database.query(
			`select snapshot from bolt_collection_history where record_id = $1 and operation = 'hold' and approval_id = $2`,
			[recordId, requestId]
		);
		expect(holds).toHaveLength(1);
		expect(holds[0]?.['snapshot']).toMatchObject({ team: 'Research' });

		const read = (at?: Readonly<{ readonly before: string }>) =>
			harness!.runtime.runPromise(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.history(
						harness!.effectId('history-before'),
						adminSubject,
						'people',
						recordId,
						at
					);
				})
			);
		expect((await read({ before: requestId }))[0]?.values).toMatchObject({
			name: 'Ada',
			team: 'Research'
		});
		// The hold is skipped by reconstruction: the log reads create, then the held update.
		const revisions = await read();
		expect(revisions).toHaveLength(2);
		expect(revisions.at(-1)?.values).toMatchObject({ team: 'Platform' });
		// An unknown approval names no restore point.
		expect(await read({ before: '00000000-0000-4000-8000-00000000dead' })).toEqual([]);
	});
});
