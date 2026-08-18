import { createHash } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Ref, Schema } from 'effect';
import { EffectId, type DatabaseRequest, type DatabaseResponse } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/index.js';
import { AccessControl } from '../../src/runtime/access/access-control.js';
import { ApprovalConflict, Approvals } from '../../src/runtime/approvals/approvals.js';
import { Collections, PendingApproval } from '../../src/runtime/collections/collections.js';
import { SyncWake } from '../../src/runtime/sync/wake.js';
import {
	AuthoredRuntimeService,
	emptyAuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import { Database } from '../../src/runtime/facilities/database.js';
import { AI, Files, Tasks, Transport } from '../../src/runtime/facilities/services.js';
import { Subject } from '../../src/runtime/identity/identity.js';
import { Workspace } from '../../src/runtime/workspace.js';
import { testCallContext } from '../support/bolt-test-layer.js';

/** A stable UUID for a readable fixture name — records are keyed by `norbital_id uuid`. */
const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const oneStep = {
	id: rid('one-step'),
	name: 'One step',
	steps: [{ id: rid('review'), name: 'Review', approvers: ['approvers'] }]
};
const twoStep = {
	id: rid('two-step'),
	name: 'Two step',
	steps: [
		{ id: rid('manager'), name: 'Manager', approvers: ['approvers'] },
		{ id: rid('finance'), name: 'Finance', approvers: ['approvers'] }
	]
};

const definition = workspace({
	name: 'hr',
	version: '1.0.0',
	collections: [
		collection({
			name: 'orders',
			fields: { title: field.string({ required: true }) },
			approvalLock: true
		}),
		collection({ name: 'employees', fields: { name: field.string({ required: true }) } }),
		collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
	],
	apps: [app({ name: 'hr', label: 'HR' }), app({ name: 'approvals', label: 'Approvals' })],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			roles: ['admin'],
			grants: [
				{ collection: 'orders', action: 'create' },
				{ collection: 'orders', action: 'update' },
				{ collection: 'orders', action: 'delete' },
				{ collection: 'orders', action: 'read' },
				{ collection: 'employees', action: 'create', approval: twoStep },
				{ collection: 'employees', action: 'update', approval: twoStep },
				{ collection: 'employees', action: 'delete', approval: twoStep },
				{ collection: 'employees', action: 'read' },
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'update', approval: oneStep },
				{ collection: 'notes', action: 'delete' },
				{ collection: 'notes', action: 'read' }
			]
		}),
		policy({
			name: 'admin-approval',
			effect: 'allow',
			actions: ['approve'],
			roles: ['admin'],
			apps: ['approvals']
		})
	],
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: ['database', 'tasks']
});

const subject = Subject.make({
	userId: 'admin-1',
	tenantId: 'tenant-1',
	roles: ['admin'],
	teams: ['approvers']
});

type Row = Record<string, Schema.Json>;
type ApprovalRow = { readonly requestId: string; readonly state: Schema.Json };
type AuditRow = {
	readonly kind: string;
	readonly subjectId: string;
	readonly payload: Schema.Json;
};

const quotedName = (sql: string, keyword: 'into' | 'from' | 'update'): string | undefined => {
	const match = new RegExp(`${keyword} "((?:[^"]|"")+)"`).exec(sql);
	return match?.[1]?.replaceAll('""', '"');
};

const memoryDatabaseLayer = () =>
	Layer.effect(
		Database.Service,
		Effect.gen(function* () {
			const approvals = yield* Ref.make<ReadonlyMap<string, ApprovalRow>>(new Map());
			const tables = yield* Ref.make<ReadonlyMap<string, ReadonlyMap<string, Row>>>(new Map());
			const audit = yield* Ref.make<ReadonlyArray<AuditRow>>([]);
			const runQuery = Effect.fn('MemoryDatabase.query')(function* (
				sql: string,
				parameters: ReadonlyArray<Schema.Json>
			) {
				if (sql.includes('insert into bolt_approvals')) {
					const requestId = String(parameters[0]);
					const current = yield* Ref.get(approvals);
					if (current.has(requestId))
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const state = parameters[2] ?? null;
					yield* Ref.set(approvals, new Map(current).set(requestId, { requestId, state }));
					return { rows: [{ state }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (
					sql.includes("state->>'_tag' = 'Pending'") &&
					sql.includes('operation') &&
					sql.includes('collection')
				) {
					const collectionName = String(parameters[0]);
					const recordId = String(parameters[1]);
					const current = yield* Ref.get(approvals);
					const found = Array.from(current.values()).find((row) => {
						if (!Schema.is(Schema.Record(Schema.String, Schema.Json))(row.state)) return false;
						if (row.state['_tag'] !== 'Pending') return false;
						const operation = row.state['operation'];
						return (
							Schema.is(Schema.Record(Schema.String, Schema.Json))(operation) &&
							operation['collection'] === collectionName &&
							operation['id'] === recordId
						);
					});
					return {
						rows: found === undefined ? [] : [{ state: found.state }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (sql.includes('select state from bolt_approvals where request_id')) {
					const current = yield* Ref.get(approvals);
					const row = current.get(String(parameters[0]));
					return {
						rows: row === undefined ? [] : [{ state: row.state }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (sql.includes('update bolt_approvals') || sql.includes('with updated as')) {
					const requestId = String(parameters[0]);
					const next = parameters[1] ?? null;
					const current = yield* Ref.get(approvals);
					const existing = current.get(requestId);
					if (
						existing === undefined ||
						!Schema.is(Schema.Record(Schema.String, Schema.Json))(existing.state) ||
						existing.state['_tag'] !== 'Pending'
					) {
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					}
					yield* Ref.set(approvals, new Map(current).set(requestId, { requestId, state: next }));
					if (sql.includes('bolt_audit')) {
						const events = yield* Ref.get(audit);
						yield* Ref.set(audit, [
							...events,
							{ kind: String(parameters[2]), subjectId: String(parameters[3]), payload: next }
						]);
					}
					return { rows: [{ state: next }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.includes('insert into bolt_audit')) {
					const events = yield* Ref.get(audit);
					yield* Ref.set(audit, [
						...events,
						{
							kind: String(parameters[0]),
							subjectId: String(parameters[1]),
							payload: parameters[2] ?? null
						}
					]);
					return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.includes('from bolt_audit')) {
					const requestId = String(parameters[0]);
					const events = yield* Ref.get(audit);
					return {
						rows: events
							.filter(
								(event) =>
									Schema.is(Schema.Record(Schema.String, Schema.Json))(event.payload) &&
									event.payload['requestId'] === requestId
							)
							.map((event) => ({
								kind: event.kind,
								subjectId: event.subjectId,
								payload: event.payload
							})),
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (sql.startsWith('insert into bolt_') || sql.includes('insert into bolt_')) {
					return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('insert into "')) {
					const table = quotedName(sql, 'into');
					if (table === undefined) return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const columns = [...sql.matchAll(/"((?:[^"]|"")+)"/g)]
						.slice(1)
						.map((match) => match[1]?.replaceAll('""', '"') ?? '');
					const row = Object.fromEntries(
						columns
							.filter((column) => column !== table)
							.map((column, index) => [column, parameters[index] ?? null])
					);
					const id = String(row['id'] ?? parameters[0]);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table) ?? new Map());
					existing.set(id, row);
					yield* Ref.set(tables, new Map(current).set(table, existing));
					return { rows: [row], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('update "') && sql.includes('norbital_approval_id = $2')) {
					const table = quotedName(sql, 'update');
					const id = String(parameters[0]);
					const requestId = String(parameters[1]);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const row = existing.get(id);
					if (
						row === undefined ||
						(typeof row['norbital_approval_id'] === 'string' &&
							row['norbital_approval_id'].length > 0)
					) {
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					}
					const next = { ...row, norbital_approval_id: requestId };
					existing.set(id, next);
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [{ id }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('update "')) {
					const table = quotedName(sql, 'update');
					const idIndex = [...sql.matchAll(/\$(\d+)/g)].at(-1);
					const id = String(
						parameters[(idIndex === undefined ? parameters.length : Number(idIndex[1])) - 1]
					);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const row = existing.get(id);
					if (row === undefined) return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const next = { ...row };
					for (const assignment of sql.matchAll(/"((?:[^"]|"")+)" = \$(\d+)/g)) {
						const column = assignment[1]?.replaceAll('""', '"');
						const index = Number(assignment[2]);
						if (column !== undefined) next[column] = parameters[index - 1] ?? null;
					}
					if (sql.includes('norbital_approval_id = null')) next['norbital_approval_id'] = null;
					existing.set(id, next);
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [next], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.includes('select norbital_approval_id')) {
					const table = quotedName(sql, 'from');
					const current = yield* Ref.get(tables);
					const row = current.get(table ?? '')?.get(String(parameters[0]));
					return {
						rows:
							row === undefined
								? []
								: [{ norbital_approval_id: row['norbital_approval_id'] ?? null }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (sql.startsWith('select * from "') || sql.startsWith('select count(*)')) {
					const table = quotedName(sql, 'from');
					const current = yield* Ref.get(tables);
					const rows = Array.from(current.get(table ?? '')?.values() ?? []);
					if (sql.startsWith('select count(*)'))
						return { rows: [{ count: rows.length }], affectedRows: 0 } satisfies DatabaseResponse;
					return { rows, affectedRows: 0 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('delete from "')) {
					const table = quotedName(sql, 'from');
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const removed = existing.delete(String(parameters[0]));
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [], affectedRows: removed ? 1 : 0 } satisfies DatabaseResponse;
				}
				return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
			});
			return Database.Service.of({
				execute: Effect.fn('Database.execute')(function* (_effectId, request: DatabaseRequest) {
					if (request._tag === 'Transaction') {
						let last: DatabaseResponse = { rows: [], affectedRows: 0 };
						for (const statement of request.statements) {
							last = yield* runQuery(statement.sql, statement.parameters);
						}
						return last;
					}
					return yield* runQuery(request.sql, request.parameters);
				})
			});
		})
	);

const context = testCallContext('approval-lock');

/**
 * A tasks facility that remembers what it was asked to enqueue.
 *
 * The follow-up work a decision schedules is the part that is easy to leave out — `resume` was
 * enqueued on approval and nothing at all was enqueued on rejection, so the lock a refused request
 * had taken was never released by anybody. Recording the calls is what lets a test say that the
 * refusal path schedules its cleanup, rather than only that the cleanup works when called by hand.
 */
const recordingTasks = (recorded: Array<string>) =>
	Tasks.layer(
		{
			// The binding is called as `(metadata, request)`; the command is in the second argument.
			call: (_metadata: unknown, request: unknown) => {
				recorded.push(JSON.stringify(request));
				return Promise.resolve({ _tag: 'Success', value: { taskId: 'task-1' } });
			}
		},
		context
	);

const workspaceLayer = Workspace.layer(definition);
const testLayer = (recorded: Array<string> = []) => {
	const tasks = recordingTasks(recorded);
	const database = memoryDatabaseLayer();
	const access = AccessControl.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, database)));
	const approvalsLayer = Approvals.layer.pipe(
		Layer.provide(Layer.mergeAll(workspaceLayer, access, database, tasks))
	);
	const authoredLayer = Layer.succeed(AuthoredRuntimeService, emptyAuthoredRuntime);
	const collectionsLayer = Collections.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				workspaceLayer,
				access,
				approvalsLayer,
				database,
				AI.layer(undefined, context),
				Files.layer(undefined, context),
				tasks,
				authoredLayer,
				// No transport is bound, so the announcement is ignored — which is exactly the behaviour
				// under test here: a write path must not depend on anywhere to publish.
				SyncWake.layer.pipe(Layer.provide(Transport.layer(undefined, context)))
			)
		)
	);
	return Layer.mergeAll(collectionsLayer, approvalsLayer);
};

describe('approval lock and resume', () => {
	it.effect('writes the row a pending mutation requested, and holds it', () =>
		Effect.gen(function* () {
			const service = yield* Collections.Service;
			const pending = yield* Effect.flip(
				service.create(EffectId.make('create-order'), subject, {
					collection: 'orders',
					id: rid('order-1'),
					values: { title: 'Held' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			// A request id is derived from the intercepted write, not a readable join of its parts:
			// `approval_request` is keyed by `norbital_id uuid`. What matters is that it is well formed
			// and stable, so a retry re-joins this approval rather than opening a second one.
			expect(pending.requestId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
			);
			// The record exists and is held, rather than being absent until somebody decides. That is
			// what makes it reviewable: the row carries the request that holds it.
			const orders = yield* service.findMany(EffectId.make('read-order'), subject, {
				collection: 'orders'
			});
			expect(orders).toHaveLength(1);
			const stored = yield* (yield* Approvals.Service).status(
				EffectId.make('status-order'),
				pending.requestId
			);
			expect(stored?._tag).toBe('Pending');
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('applies the stored row after approve and collections.resume', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				collectionsService.create(EffectId.make('create-resume'), subject, {
					collection: 'orders',
					id: rid('order-2'),
					values: { title: 'Released' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-resume'),
				pending.requestId
			);
			expect(requested?._tag).toBe('Pending');
			if (requested === undefined) return;
			const decided = yield* approvalsService.decide(
				EffectId.make('decide-resume'),
				subject,
				requested,
				'approve'
			);
			expect(decided._tag).toBe('Approved');
			yield* collectionsService.resume(EffectId.make('resume-order'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-resume'), subject, {
					collection: 'orders'
				})
			).toEqual([expect.objectContaining({ norbital_id: rid('order-2'), title: 'Released' })]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('conflicts a second mutation while the record is locked', () =>
		Effect.gen(function* () {
			const service = yield* Collections.Service;
			const first = yield* Effect.flip(
				service.create(EffectId.make('create-lock-1'), subject, {
					collection: 'orders',
					id: rid('order-3'),
					values: { title: 'First' }
				})
			);
			expect(first).toBeInstanceOf(PendingApproval);
			const second = yield* Effect.flip(
				service.create(EffectId.make('create-lock-2'), subject, {
					collection: 'orders',
					id: rid('order-3'),
					values: { title: 'Second' }
				})
			);
			expect(second).toBeInstanceOf(ApprovalConflict);
			if (!(second instanceof ApprovalConflict)) return;
			expect(second.reason).toContain('locked');
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('keeps a two-step approval pending after the first approve', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				collectionsService.create(EffectId.make('create-two-step'), subject, {
					collection: 'employees',
					id: rid('employee-1'),
					values: { name: 'Ada' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-two-step'),
				pending.requestId
			);
			expect(requested?._tag).toBe('Pending');
			if (requested === undefined) return;
			const first = yield* approvalsService.decide(
				EffectId.make('decide-two-step-1'),
				subject,
				requested,
				'approve'
			);
			expect(first).toMatchObject({ _tag: 'Pending', step: 1 });
			// Still held after the first of two approvals — the row is there, and stays held until the
			// last step decides.
			const employees = yield* collectionsService.findMany(
				EffectId.make('read-two-step'),
				subject,
				{
					collection: 'employees'
				}
			);
			expect(employees).toHaveLength(1);
			const last = yield* approvalsService.decide(
				EffectId.make('decide-two-step-2'),
				subject,
				first,
				'approve'
			);
			expect(last._tag).toBe('Approved');
			yield* collectionsService.resume(EffectId.make('resume-two-step'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-two-step-done'), subject, {
					collection: 'employees'
				})
			).toEqual([expect.objectContaining({ norbital_id: rid('employee-1'), name: 'Ada' })]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('locks an existing row without writing pending values', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			yield* collectionsService.create(EffectId.make('create-note'), subject, {
				collection: 'notes',
				id: rid('note-1'),
				values: { body: 'Original' }
			});
			const pending = yield* Effect.flip(
				collectionsService.update(EffectId.make('update-note'), subject, {
					collection: 'notes',
					id: rid('note-1'),
					values: { body: 'Pending' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			expect(
				yield* collectionsService.findMany(EffectId.make('read-note'), subject, {
					collection: 'notes'
				})
			).toEqual([
				expect.objectContaining({
					norbital_id: rid('note-1'),
					body: 'Original',
					norbital_approval_id: pending.requestId
				})
			]);
			const requested = yield* approvalsService.status(
				EffectId.make('status-note'),
				pending.requestId
			);
			expect(requested?._tag).toBe('Pending');
			if (requested === undefined) return;
			yield* approvalsService.decide(EffectId.make('decide-note'), subject, requested, 'approve');
			yield* collectionsService.resume(EffectId.make('resume-note'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-note-resumed'), subject, {
					collection: 'notes'
				})
			).toEqual([
				expect.objectContaining({
					norbital_id: rid('note-1'),
					body: 'Pending',
					norbital_approval_id: null
				})
			]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('discards the provisional row when a create is rejected', () => {
		const enqueued: Array<string> = [];
		return Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				collectionsService.create(EffectId.make('create-rejected'), subject, {
					collection: 'orders',
					id: rid('order-rejected'),
					values: { title: 'Refused' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-rejected'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.decide(
				EffectId.make('decide-rejected'),
				subject,
				requested,
				'reject',
				'not this one'
			);
			// The decision schedules its own cleanup. Asserted before running it by hand, because a
			// `discard` that works but is never called leaves the record locked in exactly the way
			// this whole path exists to prevent.
			expect(enqueued.some((request) => request.includes('collections.discard'))).toBe(true);
			yield* collectionsService.discard(EffectId.make('discard-rejected'), pending.requestId);
			// Write-then-lock means the row was already there when it was refused. Releasing its lock
			// would have published exactly the record somebody just rejected, because a workspace's
			// liveness predicate is `norbital_approval_id is null` — so the provisional write goes.
			expect(
				yield* collectionsService.findMany(EffectId.make('read-rejected'), subject, {
					collection: 'orders'
				})
			).toEqual([]);
		}).pipe(Effect.provide(testLayer(enqueued)));
	});

	it.effect('releases the lock on an existing row when its update is rejected', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			yield* collectionsService.create(EffectId.make('create-note-reject'), subject, {
				collection: 'notes',
				id: rid('note-reject'),
				values: { body: 'Original' }
			});
			const pending = yield* Effect.flip(
				collectionsService.update(EffectId.make('update-note-reject'), subject, {
					collection: 'notes',
					id: rid('note-reject'),
					values: { body: 'Pending' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-note-reject'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.decide(
				EffectId.make('decide-note-reject'),
				subject,
				requested,
				'reject'
			);
			yield* collectionsService.discard(EffectId.make('discard-note-reject'), pending.requestId);
			// The update was never applied, so the record is already what it should be and only the
			// lock has to come off. Left on, the row stayed invisible and could not be edited again.
			expect(
				yield* collectionsService.findMany(EffectId.make('read-note-reject'), subject, {
					collection: 'notes'
				})
			).toEqual([
				expect.objectContaining({
					norbital_id: rid('note-reject'),
					body: 'Original',
					norbital_approval_id: null
				})
			]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('releases the lock when a pending request is withdrawn', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				collectionsService.create(EffectId.make('create-withdrawn'), subject, {
					collection: 'orders',
					id: rid('order-withdrawn'),
					values: { title: 'Recalled' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-withdrawn'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.withdraw(EffectId.make('withdraw'), subject, requested);
			yield* collectionsService.discard(EffectId.make('discard-withdrawn'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-withdrawn'), subject, {
					collection: 'orders'
				})
			).toEqual([]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('returns decision events from the approval timeline', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				collectionsService.create(EffectId.make('create-timeline'), subject, {
					collection: 'orders',
					id: rid('order-4'),
					values: { title: 'Audited' }
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-timeline'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.decide(
				EffectId.make('decide-timeline'),
				subject,
				requested,
				'approve'
			);
			const events = yield* approvalsService.timeline(EffectId.make('timeline'), pending.requestId);
			expect(events.map((event) => event.kind)).toEqual(['approval_requested', 'approval_decided']);
			expect(events[1]).toMatchObject({
				subjectId: 'admin-1',
				payload: { _tag: 'Approved', requestId: pending.requestId }
			});
		}).pipe(Effect.provide(testLayer()))
	);
});
