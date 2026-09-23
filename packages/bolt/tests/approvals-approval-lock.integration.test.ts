import { afterEach, describe, expect, it } from 'vitest';
import { testChannels } from './support/channels.js';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { approveBy, noApproval } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { ApprovalHeld } from '../src/runtime/collections/collections.contract.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { Subject } from '../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/**
 * The approval machine over real SQL (RFC §4.8): a routed write is committed provisionally under a
 * hold, participants may keep writing under it, the seal lifts the stamps and the restore returns
 * every row to its hold snapshot.
 */

const oneStep = { flow: () => approveBy('approvers'), superceded_by: [] };
const twoStep = {
	flow: () => approveBy('approvers').thenBy('approvers'),
	superceded_by: []
};
/** A gated update is reviewed only when it says so; under a hold a participant's edit rides the open request. */
const whenReviewed = {
	flow: (context: unknown) =>
		String(Reflect.get(Reflect.get(context as object, 'changes') as object, 'title')).startsWith(
			'Review'
		)
			? approveBy('approvers')
			: noApproval,
	superceded_by: []
};

const dataPolicy = describePolicy('admin-data', {
	description: 'Exercises one- and two-stage approval settlement.',
	grants: {
		orders: {
			mutate: { new: { approval: oneStep }, existing: { approval: whenReviewed } },
			delete: { approval: oneStep },
			read: {}
		},
		employees: {
			mutate: { new: { approval: twoStep }, existing: { approval: twoStep } },
			delete: { approval: twoStep },
			read: {}
		},
		notes: {
			mutate: { new: {}, existing: { approval: oneStep } },
			delete: {},
			read: {}
		}
	}
});

const definition = workspace({
	name: 'hr',
	version: '1.0.0',
	collections: [
		collection({ name: 'orders', fields: { title: field.string({ required: true }) } }),
		collection({ name: 'employees', fields: { name: field.string({ required: true }) } }),
		collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
	],
	apps: [],
	policies: [dataPolicy, policy({ name: 'admin-approval', effect: 'allow', actions: ['approve'] })],
	teams: {
		writers: ['admin-data'],
		approvers: ['admin-data', 'admin-approval'],
		admin: ['admin-data', 'admin-approval']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	channels: testChannels('inbox'),
	envoys: [],
	requiredFacilities: []
});

const functions = policyRuntimeFunctionsFor([dataPolicy]);
const notified: Array<string> = [];
const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	collections: {
		orders: {
			create: { input: { columns: { title: true } } },
			update: { input: { columns: { title: true } } },
			delete: {},
			notifications: {
				committed: [
					{
						channel: 'inbox',
						recipients: (event) => [event.requestor],
						message: () => ({ title: 'Order committed', body: 'Committed.' })
					}
				],
				approvalStarted: [
					{
						channel: 'inbox',
						recipients: (event) => {
							notified.push(event.requestor);
							return ['approver-1'];
						},
						message: () => ({ title: 'Order needs review', body: 'Review it.' })
					}
				]
			}
		},
		employees: {
			create: { input: { columns: { name: true } } },
			update: { input: { columns: { name: true } } },
			delete: {}
		},
		notes: {
			create: { input: { columns: { body: true } } },
			update: { input: { columns: { body: true } } },
			delete: {}
		}
	}
};

const writer = Subject.make({
	userId: 'writer-1',
	tenantId: 'test-tenant',
	teamPath: ['writers'],
	policies: []
});
const outsider = { ...writer, userId: 'writer-2' };
const reviewer = Subject.make({
	userId: 'approver-1',
	tenantId: 'test-tenant',
	teamPath: ['approvers'],
	policies: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
	notified.length = 0;
});

const start = async () => {
	harness = await makeBoltTestRuntime(definition, { authored });
	return harness;
};

const write = (
	runtime: BoltTestRuntime,
	effectId: string,
	subject: Subject,
	target: string,
	action: 'create' | 'update' | 'delete',
	input: Readonly<Record<string, unknown>>
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).write(EffectId.make(effectId), subject, [
				{ collection: target, action, inputs: [input] }
			]);
		})
	);

/** A write that must hold: the request it opened and the root id it wrote. */
const held = async (
	runtime: BoltTestRuntime,
	effectId: string,
	subject: Subject,
	target: string,
	action: 'create' | 'update' | 'delete',
	input: Readonly<Record<string, unknown>>
) => {
	const commit = await write(runtime, effectId, subject, target, action, input);
	const requestId = commit.pendingApproval?.requestId ?? '';
	expect(requestId).not.toBe('');
	return { requestId, id: String(commit.records[0]?.['id'] ?? '') };
};

const decide = (
	runtime: BoltTestRuntime,
	effectId: string,
	requestId: string,
	decision: 'approve' | 'reject' | 'request_changes',
	reason?: string
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Approvals.Service).decide(
				EffectId.make(effectId),
				reviewer,
				{ requestId },
				decision,
				reason
			);
		})
	);

/** What the task runner does after a decision: the followup the decision queued, run by hand. */
const resume = (runtime: BoltTestRuntime, effectId: string, requestId: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).resume(EffectId.make(effectId), requestId);
		})
	);
const discard = (runtime: BoltTestRuntime, effectId: string, requestId: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).discard(EffectId.make(effectId), requestId);
		})
	);

const historyOf = (
	runtime: BoltTestRuntime,
	target: string,
	id: string,
	at?: { readonly before: string }
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).history(
				EffectId.make(`history:${id}`),
				adminSubject,
				target,
				id,
				at
			);
		})
	);

const revisions = (runtime: BoltTestRuntime, target: string, id: string) =>
	runtime.database.query(
		'select operation, approval_id, snapshot from bolt_collection_history where collection_name = $1 and record_id = $2 order by sequence',
		[target, id]
	);

const notifications = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		"select recipient_user as recipient, message->>'title' as title, message->>'approvalRequestId' as request from bolt_channel_outbox order by created_at, recipient_user"
	);

describe('approval hold, seal and restore', () => {
	it('commits a gated create provisionally, stamped and with a null-snapshot hold revision', async () => {
		const runtime = await start();
		const { requestId, id } = await held(runtime, 'create-order', writer, 'orders', 'create', {
			title: 'Held'
		});
		expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(await runtime.database.query('select id, title, approval_id from orders')).toEqual([
			{ id, title: 'Held', approval_id: requestId }
		]);
		expect(await revisions(runtime, 'orders', id)).toEqual([
			{ operation: 'hold', approval_id: requestId, snapshot: null },
			expect.objectContaining({ operation: 'create' })
		]);
		expect(
			await runtime.database.query(
				'select collection_name, record_id, action, status, applied_at from approval_request'
			)
		).toEqual([
			{
				collection_name: 'orders',
				record_id: id,
				action: 'create',
				status: 'ONGOING',
				applied_at: null
			}
		]);
		// The hold is what the record's history shows, not a revision of its own.
		expect(
			(await historyOf(runtime, 'orders', id)).map((revision) => revision.values['title'])
		).toEqual(['Held']);
		// The approvalStarted rule ran with the requestor and landed in the ledger with the request.
		expect(notified).toEqual([writer.userId]);
		expect(await notifications(runtime)).toEqual([
			{ recipient: 'approver-1', title: 'Order needs review', request: requestId }
		]);
	});

	it('writes a gated update provisionally with a hold revision carrying the full pre-image', async () => {
		const runtime = await start();
		const created = await write(runtime, 'create-note', writer, 'notes', 'create', {
			body: 'Original'
		});
		expect(created.pendingApproval).toBeUndefined();
		const id = String(created.records[0]?.['id']);
		const { requestId } = await held(runtime, 'update-note', writer, 'notes', 'update', {
			id,
			body: 'Pending'
		});
		expect(await runtime.database.query('select body, approval_id from notes')).toEqual([
			{ body: 'Pending', approval_id: requestId }
		]);
		const rows = await revisions(runtime, 'notes', id);
		expect(rows.map((row) => row['operation'])).toEqual(['create', 'hold', 'update']);
		expect(rows[1]).toMatchObject({
			approval_id: requestId,
			snapshot: expect.objectContaining({ id, body: 'Original', approval_id: null })
		});
	});

	it('refuses a non-participant write to a held row and stamps a participant write', async () => {
		const runtime = await start();
		const { requestId, id } = await held(runtime, 'create-order', writer, 'orders', 'create', {
			title: 'Held'
		});
		const refused = await write(runtime, 'outsider-update', outsider, 'orders', 'update', {
			id,
			title: 'Hijacked'
		}).then(
			() => undefined,
			(cause: unknown) => unwrapMutationPhase(cause)
		);
		expect(refused).toBeInstanceOf(ApprovalHeld);
		expect(refused).toMatchObject({ collection: 'orders', id, requestId });

		const participant = await write(runtime, 'requestor-update', writer, 'orders', 'update', {
			id,
			title: 'Held v2'
		});
		expect(participant.pendingApproval).toBeUndefined();
		expect(await runtime.database.query('select title, approval_id from orders')).toEqual([
			{ title: 'Held v2', approval_id: requestId }
		]);
		expect((await revisions(runtime, 'orders', id)).map((row) => row['operation'])).toEqual([
			'hold',
			'create',
			'hold',
			'update'
		]);
		// A participant's write that would itself route to review rides the open request instead
		// of opening a second one: the requestor revising what they asked for is the common case.
		const second = await write(runtime, 'requestor-review', writer, 'orders', 'update', {
			id,
			title: 'Review again'
		});
		expect(second.pendingApproval).toBeUndefined();
		expect(await runtime.database.query('select title, approval_id from orders')).toEqual([
			{ title: 'Review again', approval_id: requestId }
		]);
		expect(await runtime.database.query('select count(*)::int as n from bolt_approvals')).toEqual([
			{ n: 1 }
		]);
	});

	it('seals on the last approve: stamps lifted, applied_at set, committed notified', async () => {
		const runtime = await start();
		const { requestId, id } = await held(runtime, 'create-order', writer, 'orders', 'create', {
			title: 'Released'
		});
		const decided = await decide(runtime, 'approve-order', requestId, 'approve');
		expect(decided._tag).toBe('Approved');
		// The decision's notification rides its own channel drain beside the lifecycle task.
		expect(
			await runtime.database.query(
				"select command from bolt_task where command = 'channels.drain'"
			)
		).toHaveLength(1);
		expect(
			await runtime.database.query(
				"select command, input from bolt_task where command <> 'channels.drain'"
			)
		).toEqual([{ command: 'collections.resume', input: { requestId } }]);
		await resume(runtime, 'resume-order', requestId);
		expect(await runtime.database.query('select id, title, approval_id from orders')).toEqual([
			{ id, title: 'Released', approval_id: null }
		]);
		expect(
			await runtime.database.query(
				'select status, applied_at is not null as applied from approval_request where id = $1',
				[requestId]
			)
		).toEqual([{ status: 'APPROVED', applied: true }]);
		expect(await notifications(runtime)).toEqual([
			{ recipient: 'approver-1', title: 'Order needs review', request: requestId },
			{ recipient: writer.userId, title: 'Order committed', request: requestId }
		]);
	});

	it('keeps a two-step approval held after the first approve', async () => {
		const runtime = await start();
		const { requestId, id } = await held(
			runtime,
			'create-employee',
			writer,
			'employees',
			'create',
			{
				name: 'Ada'
			}
		);
		const first = await decide(runtime, 'approve-1', requestId, 'approve');
		expect(first).toMatchObject({ _tag: 'Pending', step: 1 });
		expect(await runtime.database.query('select approval_id from employees')).toEqual([
			{ approval_id: requestId }
		]);
		expect(await runtime.database.query('select command from bolt_task')).toEqual([]);
		const last = await decide(runtime, 'approve-2', requestId, 'approve');
		expect(last._tag).toBe('Approved');
		await resume(runtime, 'resume-employee', requestId);
		expect(await runtime.database.query('select id, name, approval_id from employees')).toEqual([
			{ id, name: 'Ada', approval_id: null }
		]);
	});

	it('restores a rejected update to its pre-image and reads it back before the hold', async () => {
		const runtime = await start();
		const id = String(
			(await write(runtime, 'create-note', writer, 'notes', 'create', { body: 'Original' }))
				.records[0]?.['id']
		);
		const { requestId } = await held(runtime, 'update-note', writer, 'notes', 'update', {
			id,
			body: 'Pending'
		});
		// The pre-hold state is readable while the hold is open.
		expect(
			(await historyOf(runtime, 'notes', id, { before: requestId })).map((r) => r.values['body'])
		).toEqual(['Original']);
		await decide(runtime, 'reject-note', requestId, 'reject', 'not this one');
		expect(await runtime.database.query('select command, input from bolt_task')).toEqual([
			{ command: 'collections.discard', input: { requestId } }
		]);
		await discard(runtime, 'discard-note', requestId);
		expect(await runtime.database.query('select id, body, approval_id from notes')).toEqual([
			{ id, body: 'Original', approval_id: null }
		]);
		const rows = await revisions(runtime, 'notes', id);
		expect(rows.map((row) => row['operation'])).toEqual(['create', 'hold', 'update', 'restore']);
		expect(rows[3]).toMatchObject({
			approval_id: requestId,
			snapshot: expect.objectContaining({ body: 'Original', approval_id: null })
		});
		expect((await historyOf(runtime, 'notes', id)).map((r) => r.values['body'])).toEqual([
			'Original',
			'Pending',
			'Original'
		]);
		expect(
			await runtime.database.query('select status from approval_request where id = $1', [requestId])
		).toEqual([{ status: 'REJECTED' }]);
	});

	it('deletes a rejected create, including what a participant wrote under the hold', async () => {
		const runtime = await start();
		const { requestId, id } = await held(runtime, 'create-order', writer, 'orders', 'create', {
			title: 'Refused'
		});
		await write(runtime, 'requestor-update', writer, 'orders', 'update', {
			id,
			title: 'Refused v2'
		});
		await decide(runtime, 'reject-order', requestId, 'reject', 'no');
		await discard(runtime, 'discard-order', requestId);
		expect(await runtime.database.query('select id from orders')).toEqual([]);
		const rows = await revisions(runtime, 'orders', id);
		expect(rows.map((row) => row['operation'])).toEqual([
			'hold',
			'create',
			'hold',
			'update',
			'restore'
		]);
		expect(rows[4]).toMatchObject({ approval_id: requestId, snapshot: { id } });
	});

	it('restores on request-for-change, which stays the request final state', async () => {
		const runtime = await start();
		const { requestId } = await held(runtime, 'create-order', writer, 'orders', 'create', {
			title: 'Needs revision'
		});
		const changed = await decide(
			runtime,
			'changes-order',
			requestId,
			'request_changes',
			'Please add the missing evidence.'
		);
		expect(changed).toMatchObject({
			_tag: 'ChangesRequested',
			reason: 'Please add the missing evidence.'
		});
		// The decision's notification rides its own channel drain beside the lifecycle task.
		expect(
			await runtime.database.query(
				"select command from bolt_task where command = 'channels.drain'"
			)
		).toHaveLength(1);
		expect(
			await runtime.database.query(
				"select command from bolt_task where command <> 'channels.drain'"
			)
		).toEqual([{ command: 'collections.discard' }]);
		await discard(runtime, 'discard-order', requestId);
		expect(await runtime.database.query('select id from orders')).toEqual([]);
		expect(
			await runtime.database.query('select status from approval_request where id = $1', [requestId])
		).toEqual([{ status: 'CHANGES_REQUESTED' }]);
	});

	it('restores a withdrawn request the same way', async () => {
		const runtime = await start();
		const id = String(
			(await write(runtime, 'create-note', writer, 'notes', 'create', { body: 'Original' }))
				.records[0]?.['id']
		);
		const { requestId } = await held(runtime, 'update-note', writer, 'notes', 'update', {
			id,
			body: 'Recalled'
		});
		const withdrawn = await runtime.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).withdraw(EffectId.make('withdraw-note'), writer, {
					requestId
				});
			})
		);
		expect(withdrawn._tag).toBe('Withdrawn');
		expect(await runtime.database.query('select command, input from bolt_task')).toEqual([
			{ command: 'collections.discard', input: { requestId } }
		]);
		await discard(runtime, 'discard-note', requestId);
		expect(await runtime.database.query('select body, approval_id from notes')).toEqual([
			{ body: 'Original', approval_id: null }
		]);
		expect((await revisions(runtime, 'notes', id)).map((row) => row['operation'])).toEqual([
			'create',
			'hold',
			'update',
			'restore'
		]);
	});

	it('re-inserts a row deleted under a hold when the request is rejected', async () => {
		const runtime = await start();
		const { requestId: createRequest, id } = await held(
			runtime,
			'create-order',
			writer,
			'orders',
			'create',
			{
				title: 'Kept'
			}
		);
		await decide(runtime, 'approve-create', createRequest, 'approve');
		await resume(runtime, 'resume-create', createRequest);
		const { requestId } = await held(runtime, 'delete-order', writer, 'orders', 'delete', { id });
		expect(await runtime.database.query('select id from orders')).toEqual([]);
		await decide(runtime, 'reject-delete', requestId, 'reject', 'keep it');
		await discard(runtime, 'discard-delete', requestId);
		expect(await runtime.database.query('select id, title, approval_id from orders')).toEqual([
			{ id, title: 'Kept', approval_id: null }
		]);
		expect((await revisions(runtime, 'orders', id)).map((row) => row['operation'])).toEqual([
			'hold',
			'create',
			'hold',
			'delete',
			'restore'
		]);
	});

	it('returns decision events from the approval timeline', async () => {
		const runtime = await start();
		const { requestId } = await held(runtime, 'create-order', writer, 'orders', 'create', {
			title: 'Audited'
		});
		await decide(runtime, 'approve-order', requestId, 'approve');
		const events = await runtime.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).timeline(EffectId.make('timeline'), requestId);
			})
		);
		expect(events.map((event) => event.kind)).toEqual(['approval_requested', 'approval_decided']);
		expect(events[1]).toMatchObject({
			subjectId: reviewer.userId,
			payload: { _tag: 'Approved', requestId }
		});
	});
});
