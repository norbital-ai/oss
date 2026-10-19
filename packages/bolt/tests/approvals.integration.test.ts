// Approval requests, the provisional-commit model (rules 44–46, approvals/machine.ts): a routed write commits at once and
// is held by its request; approval keeps it, rejection or withdrawal rolls every held record back to its checkpoint as
// `restored` history, request-for-change hands the record back to its requester, and the lock refuses everyone else.
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option } from 'effect';
import { Writes, Approvals, Callables, Reads } from '../src/engine/services.ts';
import { acquireEngine } from './effect-engine.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import {
	TenantDb as TenantDbService,
	type TenantDbShape as TenantDb
} from '../src/engine/db/tenant-db.ts';
import { dbError } from '../src/engine/db/wire.ts';
import type { Json } from '../src/decl/values.ts';
import type { ApprovalRoute, Authority, Outcome } from '../src/engine/contracts.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { Authorities, previewAs } from '../src/engine/identity/actor.ts';
type Engine = Effect.Success<ReturnType<typeof acquireEngine>>;
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { applyPlan, plan, readApplied } from '../src/engine/schema/plan.ts';
import { recordCapabilities, type ActRequest } from '../src/engine/write/act.ts';
import { restoreRecord } from '../src/engine/write/restore.ts';
import { pruneHistory, readHistory } from '../src/engine/query/history.ts';
import { lowerRead } from '../src/engine/query/engine.ts';
import { approvalHook, type DecisionStatus } from '../src/engine/approvals/approvals.ts';
import { MACHINE, movesFor, transition } from '../src/engine/approvals/machine.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';

const salesId = '0199a000-0000-7000-8000-000000000001',
	financeId = '0199a000-0000-7000-8000-000000000002',
	leadId = '0199a000-0000-7000-8000-000000000003',
	readerId = '0199a000-0000-7000-8000-000000000004',
	opsId = '0199a000-0000-7000-8000-000000000005',
	sales2Id = '0199a000-0000-7000-8000-000000000006';
const route: ApprovalRoute = { steps: [['finance'], ['lead']], superseded_by: ['lead'] };
const updateRoute: ApprovalRoute = {
	fields: ['title', 'note', 'status', 'lines', 'customer', 'tags'],
	steps: [['finance']]
};
const orderGrant = {
	read: true,
	update: { fields: ['title'] },
	approval: { create: [route], update: [updateRoute], delete: [{ steps: [['finance']] }] }
};
const orders = base.collections['orders'];
const orderModel = base.models['orders'];
if (orders === undefined || orderModel === undefined) throw new Error('Missing orders fixture');
const EVENTS = [
	'committed',
	'approvalStarted',
	'approvalStepRequested',
	'approvalStepApproved',
	'approvalCompleted',
	'rejected',
	'approvalChangesRequested',
	'approvalResubmitted',
	'approvalWithdrawn',
	'approvalSuperseded',
	'approvalCommented'
] as const;
const source: EngineManifest = {
	...base,
	models: {
		...base.models,
		customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } },
		accounts: { description: 'An account', label: 'name', fields: { name: { kind: 'text' } } },
		payments: {
			description: 'A payment',
			label: 'amount',
			fields: { amount: { kind: 'decimal', scale: 2 } }
		},
		orders: {
			...orderModel,
			fields: { ...orderModel.fields, paid: { kind: 'sum', of: 'payments.amount' } }
		}
	},
	relationships: {
		...base.relationships,
		'orders.customer': { to: 'customers', inverse: 'orders', optional: true, onDelete: 'setNull' },
		'orders.account': { to: 'accounts', inverse: 'orders', optional: true, onDelete: 'cascade' },
		'payments.order': { to: 'orders', inverse: 'payments', optional: true }
	},
	teams: {
		sales: { name: 'Sales', policies: ['sales'] },
		finance: { name: 'Finance', policies: ['reviewer'] },
		lead: { name: 'Leadership', policies: ['reviewer'] },
		reader: ['reader'],
		ops: { name: 'Operations', policies: ['direct'] }
	},
	policies: {
		sales: { description: 'Sales', grants: { orders: orderGrant, customers: { read: true } } },
		// approvers may edit the note while they review (that edit is part of their review)
		reviewer: {
			description: 'Review',
			grants: { orders: { read: true, update: { fields: ['note'] } }, lines: { read: true } }
		},
		reader: { description: 'Read', grants: { orders: { read: true } } },
		direct: {
			description: 'Direct',
			grants: {
				orders: { read: true, create: true, update: true, delete: true, moves: 'all' },
				lines: { read: true, create: true, update: true, delete: true },
				customers: { read: true, create: true, delete: true },
				accounts: { read: true, create: true, delete: true },
				payments: { read: true, create: true },
				tags: { read: true, create: true }
			}
		}
	},
	collections: {
		...base.collections,
		customers: { read: { fields: 'all' }, create: { input: { columns: ['name'] } }, delete: {} },
		accounts: { read: { fields: 'all' }, create: { input: { columns: ['name'] } }, delete: {} },
		payments: { read: { fields: 'all' }, create: { input: { columns: ['amount', 'order'] } } },
		orders: {
			...orders,
			create: {
				input: {
					...orders.create!.input,
					columns: ['title', 'note', 'status', 'customer', 'account']
				}
			},
			update: {
				input: {
					...orders.update!.input,
					columns: ['title', 'note', 'status', 'customer']
				}
			},
			notifications: Object.fromEntries(
				EVENTS.map((event) => [
					event,
					[
						{
							to: [
								event === 'approvalStepRequested' || event === 'approvalResubmitted'
									? 'step_approvers'
									: 'requestor'
							],
							title: event
						}
					]
				])
			)
		}
	}
};
let pg: PGlite,
	db: TenantDb,
	e: Engine,
	manifest: EngineManifest,
	sales: Authority,
	sales2: Authority,
	finance: Authority,
	lead: Authority,
	reader: Authority,
	ops: Authority,
	n: number,
	/** Database round trips through the engine's `TenantDb` (reads, writes and transactions). */
	trips = 0;
const query = (...args: Parameters<PGlite['query']>) =>
	Effect.tryPromise({ try: () => pg.query<Record<string, Json>>(...args), catch: dbError });
const exec = (text: string) => Effect.tryPromise({ try: () => pg.exec(text), catch: dbError });
const viewOf = (requestId: string, authority: Authority) =>
	Context.get(e, Approvals)
		.view(requestId, authority, () => Effect.succeed(true))
		.pipe(Effect.map(Option.getOrNull));
const bindings = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
const rows = (sql: string, params: Json[] = []) =>
	Effect.map(query(sql, params), (result) => result.rows);
const count = (table: string) =>
	Effect.map(rows(`SELECT count(*)::int n FROM ${table}`), (rows) => Number(rows[0]?.['n']));
const run = (
	authority: Authority,
	request: Pick<ActRequest, 'verb' | 'input'> & Partial<ActRequest>
) =>
	Context.get(e, Writes).act({
		collection: 'orders',
		mode: { _tag: 'Direct' },
		key: `key-${n}`,
		issuedAt: NOW,
		invocationId: `inv-${n++}`,
		bindings,
		authority,
		...request
	});
const pending = (outcome: Outcome) => {
	if (outcome.kind !== 'pendingApproval') throw new Error(JSON.stringify(outcome));
	return outcome.requestId;
};
const committed = (outcome: Outcome) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	const id = outcome.records.find((record) => record.collection === 'orders')?.id;
	if (id === undefined) throw new Error('Missing order');
	return id;
};
const decide = (
	requestId: string,
	authority: Authority,
	status: DecisionStatus = 'APPROVED',
	reason?: string
) =>
	Context.get(e, Approvals).process({
		requestId,
		authority,
		status,
		now: NOW,
		...(reason === undefined ? {} : { reason })
	});
const lineIds = Effect.map(rows('SELECT id::text id, label FROM lines ORDER BY label'), (rs) =>
	rs.map((r) => ({ id: String(r['id']), label: String(r['label']) }))
);
const history = (record: string) =>
	rows(
		'SELECT revision, op, cause, restored_from, request::text request, actor FROM bolt_history WHERE record = $1::uuid ORDER BY revision',
		[record]
	);
const titles = Effect.map(rows('SELECT title FROM sys_notification ORDER BY at, title'), (rs) =>
	rs.map((r) => String(r['title']))
);
const read = (authority: Authority, id: string) =>
	Effect.map(
		Context.get(e, Reads).run(
			[lowerRead(manifest, 'get', ['orders', id])],
			{ as: 'caller', authority },
			bindings
		),
		(answers) => answers[0]
	);
const install = (next: EngineManifest) =>
	Effect.gen(function* () {
		manifest = next;
		e = yield* acquireEngine(manifest, db);
	});
const author = Effect.fn('Test.author')(function* () {
	const authorities = new Authorities(manifest, 'test');
	const member = Effect.fn('Test.member')(function* (id: string) {
		const value = yield* authorities.member(db, id);
		if (value === null) throw new Error('Missing test actor');
		return value;
	});
	[sales, finance, lead, reader, ops, sales2] = yield* Effect.all(
		[
			member(salesId),
			member(financeId),
			member(leadId),
			member(readerId),
			member(opsId),
			member(sales2Id)
		],
		{ concurrency: 'unbounded' }
	);
});
const fixture = Layer.effectDiscard(
	Effect.gen(function* () {
		pg = yield* PgliteDb.open();
		db = PgliteDb.make(pg);
		manifest = source;
		n = 0;
		yield* applyPlan(db, plan(null, manifest), { accept: true });
		yield* exec(
			`INSERT INTO sys_user(id,name,team) VALUES ('${salesId}','Sales','sales'),('${financeId}','Finance','finance'),('${leadId}','Lead','lead'),('${readerId}','Reader','reader'),('${opsId}','Ops','ops'),('${sales2Id}','Sales Two','sales');INSERT INTO sys_user(id,name,admin) VALUES ('${admin.actor.kind === 'member' ? admin.actor.id : ''}','Admin',true)`
		);
		const raw = db;
		db = TenantDbService.typed({
			read: (statements) => Effect.suspend(() => (trips++, raw.read(statements))),
			transaction: (body, lock) => Effect.suspend(() => (trips++, raw.transaction(body, lock))),
			write: (statement, lock) => Effect.suspend(() => (trips++, raw.write(statement, lock)))
		});
		yield* install(manifest);
		yield* author();
	})
).pipe(Layer.provide(Pristine.layer));
/** An order with two lines, committed directly (revision 1). */
const seeded = Effect.gen(function* () {
	const order = committed(
		(yield* run(admin, {
			verb: 'create',
			input: {
				title: 'desk',
				lines: {
					create: [
						{ label: 'keep', amount: '5' },
						{ label: 'drop', amount: '7' }
					]
				}
			}
		})).outcome
	);
	const lines = yield* lineIds;
	return {
		order,
		keep: lines.find((l) => l.label === 'keep')!.id,
		drop: lines.find((l) => l.label === 'drop')!.id
	};
});

describe('the approval state machine', () => {
	it('is one table: terminal states never move, and each move names who may take it', () => {
		for (const terminal of ['Approved', 'Rejected', 'Withdrawn', 'Superseded'] as const)
			expect(MACHINE[terminal]).toEqual({});
		const all = new Set(['approver', 'requester', 'superseder'] as const);
		expect(movesFor('Pending', all).map((m) => m.move)).toEqual([
			'approve',
			'reject',
			'requestChanges',
			'withdraw',
			'supersede',
			'comment'
		]);
		expect(movesFor('ChangesRequested', all).map((m) => m.move)).toEqual([
			'reject',
			'resubmit',
			'withdraw',
			'comment'
		]);
		expect(transition({ state: 'Pending', step: 0 }, 2, 'approve', all, '')).toMatchObject({
			next: { state: 'Pending', step: 1 }
		});
		expect(transition({ state: 'Pending', step: 1 }, 2, 'approve', all, '')).toMatchObject({
			next: { state: 'Approved', step: 1 }
		});
		expect(
			transition({ state: 'ChangesRequested', step: 1 }, 2, 'resubmit', all, '')
		).toMatchObject({
			next: { state: 'Pending', step: 0 }
		});
		expect(transition({ state: 'Pending', step: 0 }, 1, 'requestChanges', all, '')).toMatchObject({
			refused: 'reason'
		});
		expect(transition({ state: 'Approved', step: 0 }, 1, 'reject', all, '')).toMatchObject({
			refused: 'invalidMove'
		});
		expect(
			transition({ state: 'Pending', step: 0 }, 1, 'approve', new Set(['requester'] as const), '')
		).toMatchObject({ refused: 'forbidden' });
	});
});

describe('provisional approval requests', () => {
	it.effect('single step: the change commits at once, the record is held, approval keeps it', () =>
		Effect.gen(function* () {
			const { order } = yield* seeded;
			const result = yield* run(sales, {
				verb: 'update',
				input: { target: order, set: { note: 'proposed' } }
			});
			const id = pending(result.outcome);
			expect(result.outcome).toMatchObject({
				records: [{ collection: 'orders', id: order, revision: 2 }]
			});
			expect(yield* rows('SELECT note, revision FROM orders')).toEqual([
				{ note: 'proposed', revision: 2 }
			]);
			expect(yield* history(order)).toMatchObject([
				{ revision: 1, request: null },
				{ revision: 2, cause: 'direct', request: id, actor: `member:${salesId}` }
			]);
			expect(yield* rows('SELECT status, step, steps FROM approval_request')).toEqual([
				{ status: 'ONGOING', step: 0, steps: 1 }
			]);
			expect(yield* read(finance, order)).toMatchObject({
				$approval: {
					requestId: id,
					state: 'Pending',
					step: 0,
					steps: 1,
					requestedBy: 'Sales',
					waitingOn: ['Finance']
				}
			});
			expect(yield* decide(id, finance)).toEqual({
				kind: 'decided',
				requestId: id,
				status: 'APPROVED'
			});
			expect(yield* rows('SELECT note, revision FROM orders')).toEqual([
				{ note: 'proposed', revision: 2 }
			]);
			expect(yield* read(finance, order)).not.toHaveProperty('$approval');
			const view = yield* viewOf(id, sales);
			expect(view?.log.map((entry) => [entry.move, entry.to])).toEqual([
				['request', 'ONGOING'],
				['approve', 'APPROVED']
			]);
			expect(view?.moves).toEqual([]);
			expect(yield* rows('SELECT status, closed_by FROM approval_request')).toEqual([
				{ status: 'APPROVED', closed_by: `member:${financeId}` }
			]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'multi step: a create with owned children is live at once and stands after the last step',
		() =>
			Effect.gen(function* () {
				const result = yield* run(sales, {
					verb: 'create',
					input: { title: 'new desk', lines: { create: [{ label: 'leg', amount: '5' }] } }
				});
				const id = pending(result.outcome);
				expect(yield* rows('SELECT title, total::text total FROM orders')).toEqual([
					{ title: 'new desk', total: '5' }
				]);
				expect(yield* count('lines')).toBe(1);
				const view = yield* viewOf(id, finance);
				expect(view?.records.map((r) => [r.collection, r.op]).sort()).toEqual([
					['lines', 'create'],
					['orders', 'create']
				]);
				expect(view?.moves.map((m) => m.status)).toEqual([
					'APPROVED',
					'REJECTED',
					'REQUEST_FOR_CHANGE',
					'COMMENT'
				]);
				expect(yield* decide(id, lead)).toMatchObject({ kind: 'refused', code: 'forbidden' });
				expect(yield* decide(id, finance)).toMatchObject({ kind: 'decided', status: 'ONGOING' });
				expect((yield* viewOf(id, lead))?.step).toBe(1);
				expect(yield* decide(id, lead)).toMatchObject({ kind: 'decided', status: 'APPROVED' });
				expect(yield* count('orders')).toBe(1);
				expect(yield* count('lines')).toBe(1);
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'children created, updated and deleted in the request are visible at once and stand on approval',
		() =>
			Effect.gen(function* () {
				const { order, keep, drop } = yield* seeded;
				const id = pending(
					(yield* run(sales, {
						verb: 'update',
						input: {
							target: order,
							set: {
								note: 'reworked',
								lines: {
									create: [{ label: 'added', amount: '1' }],
									update: [{ target: keep, set: { label: 'kept' } }],
									delete: [drop]
								}
							}
						}
					})).outcome
				);
				expect((yield* lineIds).map((l) => l.label)).toEqual(['added', 'kept']);
				expect(
					(yield* viewOf(id, finance))?.records.map((r) => `${r.collection}:${r.op}`).sort()
				).toEqual(['lines:create', 'lines:delete', 'lines:update', 'orders:update']);
				expect(yield* decide(id, finance)).toMatchObject({ kind: 'decided', status: 'APPROVED' });
				expect((yield* lineIds).map((l) => l.label)).toEqual(['added', 'kept']);
				expect(yield* rows('SELECT note, total::text total FROM orders')).toEqual([
					{ note: 'reworked', total: '6' }
				]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'reject restores root and children to the checkpoint as restored history in one statement',
		() =>
			Effect.gen(function* () {
				const { order, keep, drop } = yield* seeded;
				const id = pending(
					(yield* run(sales, {
						verb: 'update',
						input: {
							target: order,
							set: {
								note: 'reworked',
								lines: {
									create: [{ label: 'added', amount: '1' }],
									update: [{ target: keep, set: { label: 'kept' } }],
									delete: [drop]
								}
							}
						}
					})).outcome
				);
				const added = (yield* lineIds).find((l) => l.label === 'added')!.id;
				expect(yield* decide(id, finance, 'REJECTED', 'Not now')).toMatchObject({
					kind: 'decided',
					status: 'REJECTED'
				});
				expect(yield* rows('SELECT note, total::text total FROM orders')).toEqual([
					{ note: null, total: '12' }
				]);
				expect(yield* lineIds).toEqual([
					{ id: drop, label: 'drop' },
					{ id: keep, label: 'keep' }
				]);
				// the root and the updated child: restored from their checkpoint revision, by the decider, linked to the request
				expect((yield* history(order)).at(-1)).toMatchObject({
					cause: 'restored',
					restored_from: 1,
					request: id,
					actor: `member:${financeId}`
				});
				expect((yield* history(keep)).at(-1)).toMatchObject({
					op: 'update',
					cause: 'restored',
					restored_from: 1
				});
				// a deleted child re-created from its history at its next revision; a created child removed
				expect(yield* history(drop)).toMatchObject([
					{ revision: 1, op: 'create' },
					{ revision: 2, op: 'delete', request: id },
					{ revision: 3, op: 'create', cause: 'restored', restored_from: 1, request: id }
				]);
				expect((yield* history(added)).at(-1)).toMatchObject({
					op: 'delete',
					cause: 'restored',
					restored_from: 0
				});
				const view = yield* viewOf(id, sales);
				expect(view?.log.at(-1)).toMatchObject({
					move: 'reject',
					reason: 'Not now',
					from: 'ONGOING',
					to: 'REJECTED'
				});
				expect(
					view?.log
						.at(-1)
						?.rolledBack?.map((r) => r.action)
						.sort()
				).toEqual(['recreated', 'removed', 'restored', 'restored']);
				expect(yield* decide(id, finance, 'REJECTED')).toMatchObject({
					kind: 'refused',
					code: 'invalidInput',
					message: 'This request is Rejected; it no longer changes.'
				});
				expect(yield* count('lines')).toBe(2);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('a reject whose restore must skip a field still succeeds and reports it', () =>
		Effect.gen(function* () {
			const customer = (name: string) =>
				Effect.map(run(admin, { collection: 'customers', verb: 'create', input: { name } }), (r) =>
					r.outcome.kind === 'committed' ? r.outcome.records[0]!.id : ''
				);
			const [first, second] = [yield* customer('first'), yield* customer('second')];
			const order = committed(
				(yield* run(admin, { verb: 'create', input: { title: 'desk' } })).outcome
			);
			committed(
				(yield* run(admin, { verb: 'update', input: { target: order, set: { customer: first } } }))
					.outcome
			);
			const id = pending(
				(yield* run(sales, {
					verb: 'update',
					input: { target: order, set: { customer: second, note: 'moved' } }
				})).outcome
			);
			expect(
				(yield* run(admin, { collection: 'customers', verb: 'delete', input: { target: first } }))
					.outcome.kind
			).toBe('committed');
			expect(yield* decide(id, finance, 'REJECTED')).toMatchObject({
				kind: 'decided',
				status: 'REJECTED'
			});
			expect(yield* rows('SELECT note, customer::text customer FROM orders')).toEqual([
				{ note: null, customer: second }
			]);
			expect((yield* viewOf(id, sales))?.log.at(-1)?.skipped).toEqual([
				{ collection: 'orders', id: order, field: 'customer', reason: 'deletedTarget' }
			]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'request for change: a reason, the data stays, only the requester edits, resubmit returns to step 1',
		() =>
			Effect.gen(function* () {
				const id = pending(
					(yield* run(sales, { verb: 'create', input: { title: 'draft desk', note: 'first' } }))
						.outcome
				);
				const order = String((yield* rows('SELECT id::text id FROM orders'))[0]?.['id']);
				expect(yield* decide(id, finance)).toMatchObject({ status: 'ONGOING' });
				expect(yield* decide(id, lead, 'REQUEST_FOR_CHANGE')).toMatchObject({
					kind: 'refused',
					code: 'invalidInput',
					field: 'reason'
				});
				expect(yield* decide(id, lead, 'REQUEST_FOR_CHANGE', 'Clarify the note')).toMatchObject({
					kind: 'decided',
					status: 'CHANGES_REQUESTED'
				});
				expect(yield* rows('SELECT title, note FROM orders')).toEqual([
					{ title: 'draft desk', note: 'first' }
				]);
				expect(yield* read(ops, order)).toMatchObject({
					$approval: { state: 'ChangesRequested', waitingOn: ['Sales'] }
				});
				// the approvers, an outsider with direct grants and an administrator are refused; the requester edits
				for (const who of [finance, ops, admin])
					expect(
						(yield* run(who, {
							verb: 'update',
							input: { target: order, set: { note: 'outside' } }
						})).outcome
					).toMatchObject({
						kind: 'refused',
						code: 'locked',
						message: 'Under approval: Sales may change it.'
					});
				expect(yield* decide(id, lead)).toMatchObject({
					kind: 'refused',
					code: 'invalidInput',
					message: 'A request in ChangesRequested cannot approve.'
				});
				expect(
					(yield* run(sales, {
						verb: 'update',
						input: { target: order, set: { note: 'clarified' } }
					})).outcome
				).toMatchObject({ kind: 'committed' });
				expect(yield* decide(id, finance, 'RESUBMITTED')).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect((yield* viewOf(id, sales))?.moves.map((m) => m.status)).toEqual([
					'RESUBMITTED',
					'WITHDRAWN',
					'COMMENT'
				]);
				expect(yield* decide(id, sales, 'RESUBMITTED', 'Clarified')).toMatchObject({
					kind: 'decided',
					status: 'ONGOING'
				});
				const view = yield* viewOf(id, finance);
				expect(view?.step).toBe(0);
				expect(view?.log.map((entry) => [entry.move, entry.step, entry.reason])).toEqual([
					['request', 0, null],
					['approve', 0, null],
					['requestChanges', 1, 'Clarify the note'],
					['resubmit', 1, 'Clarified']
				]);
				expect(yield* decide(id, finance)).toMatchObject({ status: 'ONGOING' });
				expect(yield* decide(id, lead)).toMatchObject({ status: 'APPROVED' });
				expect(yield* rows('SELECT note FROM orders')).toEqual([{ note: 'clarified' }]);
				// the requester's edit belongs to the request in history
				expect((yield* history(order)).map((h) => h['request'])).toEqual([id, id]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'an approver may edit while reviewing; a later rejection rolls that edit back too',
		() =>
			Effect.gen(function* () {
				const { order } = yield* seeded;
				const id = pending(
					(yield* run(sales, {
						verb: 'update',
						input: { target: order, set: { note: 'proposed' } }
					})).outcome
				);
				expect(
					(yield* run(finance, {
						verb: 'update',
						input: { target: order, set: { note: 'reviewer' } }
					})).outcome
				).toMatchObject({ kind: 'committed' });
				expect((yield* history(order)).at(-1)).toMatchObject({
					request: id,
					actor: `member:${financeId}`
				});
				expect(yield* decide(id, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
				expect(yield* rows('SELECT note, revision FROM orders')).toEqual([
					{ note: null, revision: 4 }
				]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('withdraw rolls back like a rejection and belongs to the requester', () =>
		Effect.gen(function* () {
			const id = pending(
				(yield* run(sales, { verb: 'create', input: { title: 'withdrawn' } })).outcome
			);
			const order = String((yield* rows('SELECT id::text id FROM orders'))[0]?.['id']);
			expect(yield* decide(id, finance, 'WITHDRAWN')).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* decide(id, sales, 'WITHDRAWN')).toMatchObject({
				kind: 'decided',
				status: 'WITHDRAWN'
			});
			expect(yield* count('orders')).toBe(0);
			expect((yield* history(order)).at(-1)).toMatchObject({
				op: 'delete',
				cause: 'restored',
				restored_from: 0,
				request: id
			});
			expect(yield* decide(id, sales, 'WITHDRAWN')).toMatchObject({
				kind: 'refused',
				code: 'invalidInput'
			});
		}).pipe(Effect.provide(fixture))
	);

	it.effect('supersede needs a superseder and a reason, and the change stands', () =>
		Effect.gen(function* () {
			const id = pending(
				(yield* run(sales, { verb: 'create', input: { title: 'superseded' } })).outcome
			);
			expect(yield* decide(id, finance, 'SUPERSEDED', 'Needed')).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* decide(id, lead, 'SUPERSEDED')).toMatchObject({
				kind: 'refused',
				code: 'invalidInput'
			});
			expect(yield* decide(id, lead, 'SUPERSEDED', 'Needed')).toMatchObject({
				kind: 'decided',
				status: 'SUPERSEDED'
			});
			expect(yield* count('orders')).toBe(1);
			// an administrator supersedes too, but never edits around the lock
			const other = pending(
				(yield* run(sales, { verb: 'create', input: { title: 'admin' } })).outcome
			);
			const held = String(
				(yield* rows("SELECT id::text id FROM orders WHERE title = 'admin'"))[0]?.['id']
			);
			expect(
				(yield* run(admin, { verb: 'update', input: { target: held, set: { note: 'around' } } }))
					.outcome
			).toMatchObject({ kind: 'refused', code: 'locked' });
			expect(yield* decide(other, admin, 'SUPERSEDED', 'Override')).toMatchObject({
				status: 'SUPERSEDED'
			});
			expect(
				(yield* run(admin, { verb: 'update', input: { target: held, set: { note: 'after' } } }))
					.outcome.kind
			).toBe('committed');
		}).pipe(Effect.provide(fixture))
	);

	it.effect('the lock refuses outsiders on every write path, root and child', () =>
		Effect.gen(function* () {
			const { order, keep } = yield* seeded;
			const other = committed(
				(yield* run(admin, { verb: 'create', input: { title: 'free' } })).outcome
			);
			const id = pending(
				(yield* run(sales, { verb: 'update', input: { target: order, set: { note: 'held' } } }))
					.outcome
			);
			const locked = { kind: 'refused', code: 'locked', data: { requestId: id } };
			// act, a bulk update that includes the held record, an upsert, a nested child edit
			expect(
				(yield* run(ops, { verb: 'update', input: { target: order, set: { note: 'x' } } })).outcome
			).toMatchObject(locked);
			expect(
				(yield* run(ops, {
					verb: 'update',
					input: [
						{ target: other, set: { note: 'x' } },
						{ target: order, set: { note: 'x' } }
					]
				})).outcome
			).toMatchObject(locked);
			expect(
				(yield* run(ops, {
					verb: 'upsert',
					input: { id: order, title: 'desk', note: 'x' },
					onConflict: 'update'
				})).outcome
			).toMatchObject(locked);
			expect(
				(yield* run(ops, {
					verb: 'update',
					input: {
						target: order,
						set: { lines: { update: [{ target: keep, set: { label: 'x' } }] } }
					}
				})).outcome
			).toMatchObject(locked);
			// the child directly, and a new owned child created under the held root
			expect(
				(yield* run(ops, {
					collection: 'lines',
					verb: 'update',
					input: { target: keep, set: { label: 'x' } }
				})).outcome
			).toMatchObject(locked);
			expect(
				(yield* run(ops, {
					collection: 'lines',
					verb: 'create',
					input: { label: 'x', amount: '1', order }
				})).outcome
			).toMatchObject(locked);
			// an automation run, the agent's batch of acts, a second requester, the requester in Pending
			const automation: Authority = {
				...admin,
				actor: { kind: 'system', run: 'run-1', by: { automation: 'nightly' } }
			};
			expect(
				(yield* run(automation, { verb: 'update', input: { target: order, set: { note: 'x' } } }))
					.outcome
			).toMatchObject(locked);
			const batch = yield* Context.get(e, Callables).acts({
				name: 'agent.batch',
				acts: [
					{ collection: 'orders', verb: 'update', input: { target: order, set: { note: 'x' } } }
				],
				authority: ops,
				bindings,
				invocationId: 'agent-batch',
				key: 'agent-batch',
				issuedAt: NOW,
				from: 'Client'
			});
			expect(batch.outcome).toMatchObject(locked);
			for (const who of [sales2, sales])
				expect(
					(yield* run(who, { verb: 'update', input: { target: order, set: { note: 'second' } } }))
						.outcome
				).toMatchObject({ ...locked, message: 'Under approval: Finance may change it.' });
			// per-record restore
			const restored = yield* restoreRecord(
				{ manifest, db },
				(request) => Context.get(e, Writes).act(request),
				{ collection: 'orders', record: order, revision: 1 },
				{ authority: admin, bindings, key: 'restore', issuedAt: NOW, invocationId: 'restore' }
			);
			expect(restored.outcome).toMatchObject({ kind: 'refused', code: 'locked' });
			expect(yield* rows('SELECT note FROM orders WHERE id = $1', [order])).toEqual([
				{ note: 'held' }
			]);
			expect(yield* lineIds).toMatchObject([{ label: 'drop' }, { label: 'keep' }]);
			// the unheld record is untouched by the lock
			expect(
				(yield* run(ops, { verb: 'update', input: { target: other, set: { note: 'free' } } }))
					.outcome.kind
			).toBe('committed');
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'capabilities refuse editing under the lock with its reason; approvers keep theirs',
		() =>
			Effect.gen(function* () {
				const { order } = yield* seeded;
				pending(
					(yield* run(sales, { verb: 'update', input: { target: order, set: { note: 'held' } } }))
						.outcome
				);
				const caps = (authority: Authority) =>
					recordCapabilities(
						{ manifest, db, approval: approvalHook(manifest, db) },
						'orders',
						order,
						authority,
						bindings,
						() => Effect.succeed({ id: order, title: 'desk', note: 'held', status: 'draft' })
					);
				const outsider = yield* caps(ops);
				expect(outsider?.update).toMatchObject({ allowed: false, proposal: false });
				expect(outsider?.update.reasons).toContain('underApproval');
				expect(outsider?.fields['note']?.writable).toBe(false);
				expect((yield* caps(finance))?.update.reasons).not.toContain('underApproval');
			}).pipe(Effect.provide(fixture))
	);

	it.effect('every illegal transition is refused with a reason', () =>
		Effect.gen(function* () {
			const id = pending(
				(yield* run(sales, { verb: 'create', input: { title: 'rules' } })).outcome
			);
			expect(yield* decide(id, sales)).toMatchObject({
				kind: 'refused',
				code: 'forbidden',
				message: 'Only the approver may approve.'
			});
			expect(yield* decide(id, reader, 'COMMENT', 'Hi')).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* decide(id, finance, 'COMMENT')).toMatchObject({
				kind: 'refused',
				field: 'reason'
			});
			expect(yield* decide(id, sales, 'RESUBMITTED')).toMatchObject({
				kind: 'refused',
				code: 'invalidInput'
			});
			expect(yield* decide(id, finance)).toMatchObject({ status: 'ONGOING' });
			expect(yield* decide(id, finance)).toMatchObject({ kind: 'refused', code: 'forbidden' });
			expect(yield* decide(id, lead)).toMatchObject({ status: 'APPROVED' });
			for (const status of [
				'APPROVED',
				'REJECTED',
				'REQUEST_FOR_CHANGE',
				'RESUBMITTED',
				'WITHDRAWN',
				'SUPERSEDED',
				'COMMENT'
			] as const)
				expect(
					yield* decide(
						id,
						status === 'RESUBMITTED' || status === 'WITHDRAWN' ? sales : lead,
						status,
						'x'
					)
				).toMatchObject({
					kind: 'refused',
					code: 'invalidInput',
					message: 'This request is Approved; it no longer changes.'
				});
			expect(yield* decide('0199a000-0000-7000-8000-0000000000ff', finance)).toMatchObject({
				kind: 'refused',
				code: 'notFound'
			});
		}).pipe(Effect.provide(fixture))
	);

	it.effect('concurrent approvers on the same step: exactly one decides', () =>
		Effect.gen(function* () {
			const id = pending((yield* run(sales, { verb: 'create', input: { title: 'race' } })).outcome);
			const decisions = yield* Effect.all([decide(id, finance), decide(id, finance, 'REJECTED')], {
				concurrency: 'unbounded'
			});
			expect(decisions.filter((d) => d.kind === 'decided')).toHaveLength(1);
			expect(decisions.filter((d) => d.kind === 'conflict')).toHaveLength(1);
			expect((yield* viewOf(id, sales))?.log).toHaveLength(2);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'comments append to the log by requester and approvers without moving the request',
		() =>
			Effect.gen(function* () {
				const id = pending(
					(yield* run(sales, { verb: 'create', input: { title: 'talk' } })).outcome
				);
				expect(yield* decide(id, finance, 'COMMENT', 'Which supplier?')).toMatchObject({
					kind: 'decided',
					status: 'ONGOING'
				});
				expect(yield* decide(id, sales, 'COMMENT', 'Acme')).toMatchObject({ status: 'ONGOING' });
				const view = yield* viewOf(id, finance);
				expect(
					view?.log.slice(1).map((entry) => [entry.move, entry.by.name, entry.reason, entry.to])
				).toEqual([
					['comment', 'Finance', 'Which supplier?', 'ONGOING'],
					['comment', 'Sales', 'Acme', 'ONGOING']
				]);
				expect(view?.step).toBe(0);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('every lifecycle event notifies through the collection notification rules', () =>
		Effect.gen(function* () {
			const first = pending(
				(yield* run(sales, { verb: 'create', input: { title: 'one' } })).outcome
			);
			expect(yield* titles).toEqual(['approvalStarted', 'approvalStepRequested', 'committed']);
			yield* exec('DELETE FROM sys_notification');
			yield* decide(first, finance);
			expect(yield* titles).toEqual(['approvalStepApproved', 'approvalStepRequested']);
			yield* exec('DELETE FROM sys_notification');
			yield* decide(first, lead, 'COMMENT', 'Looks fine');
			yield* decide(first, lead, 'REQUEST_FOR_CHANGE', 'Fix');
			yield* decide(first, sales, 'RESUBMITTED');
			expect(yield* titles).toEqual([
				'approvalChangesRequested',
				'approvalCommented',
				'approvalResubmitted',
				'approvalStepRequested'
			]);
			yield* exec('DELETE FROM sys_notification');
			yield* decide(first, finance);
			yield* decide(first, lead);
			expect(yield* titles).toEqual([
				'approvalCompleted',
				'approvalStepApproved',
				'approvalStepApproved',
				'approvalStepRequested'
			]);
			const [second, third, fourth] = [
				pending((yield* run(sales, { verb: 'create', input: { title: 'two' } })).outcome),
				pending((yield* run(sales, { verb: 'create', input: { title: 'three' } })).outcome),
				pending((yield* run(sales, { verb: 'create', input: { title: 'four' } })).outcome)
			];
			yield* exec('DELETE FROM sys_notification');
			yield* decide(second, finance, 'REJECTED');
			yield* decide(third, sales, 'WITHDRAWN');
			yield* decide(fourth, lead, 'SUPERSEDED', 'Urgent');
			expect(yield* titles).toEqual(['approvalSuperseded', 'approvalWithdrawn', 'rejected']);
			// the requester and the step's approvers receive them as members
			expect(
				yield* rows("SELECT DISTINCT member FROM sys_notification WHERE title = 'rejected'")
			).toEqual([{ member: salesId }]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect('retry answers the same request; a constraint failure opens none', () =>
		Effect.gen(function* () {
			const request = {
				verb: 'create' as const,
				input: { title: 'desk' },
				key: 'retry',
				invocationId: 'same'
			};
			const first = yield* run(sales, request);
			const second = yield* run(sales, { ...request, retry: true });
			expect(second.outcome).toEqual(first.outcome);
			expect(yield* count('bolt_approvals')).toBe(1);
			expect(yield* count('orders')).toBe(1);
			expect(
				(yield* run(sales2, { verb: 'create', input: { title: 'desk' } })).outcome
			).toMatchObject({ kind: 'refused', code: 'unique' });
			expect(yield* count('bolt_approvals')).toBe(1);
		}).pipe(Effect.provide(fixture))
	);

	it.effect('direct grants commit without a request; no grant and no route stays denied', () =>
		Effect.gen(function* () {
			const direct = compileAuthority(
				manifest,
				{ actor: sales.actor, policies: ['sales', 'direct'], admin: false },
				'union'
			);
			expect(
				(yield* run(direct, { verb: 'create', input: { title: 'direct' } })).outcome.kind
			).toBe('committed');
			expect(
				(yield* run(reader, { verb: 'create', input: { title: 'denied' } })).outcome
			).toMatchObject({ kind: 'refused', code: 'forbidden' });
			expect(yield* count('bolt_approvals')).toBe(0);
			yield* install({
				...manifest,
				policies: {
					...manifest.policies,
					sales: {
						description: 'Sales',
						grants: {
							orders: {
								read: true,
								approval: { create: [{ ...route, match: { record: { title: { eq: 'review' } } } }] }
							}
						}
					}
				}
			});
			yield* author();
			expect(
				(yield* run(sales, { verb: 'create', input: { title: 'other' } })).outcome
			).toMatchObject({ kind: 'refused', code: 'forbidden' });
		}).pipe(Effect.provide(fixture))
	);

	it.effect('a reviewer whose source team moved, or a revoked preview, decides nothing', () =>
		Effect.gen(function* () {
			const id = pending(
				(yield* run(sales, { verb: 'create', input: { title: 'moved' } })).outcome
			);
			yield* query('UPDATE sys_user SET admin=true,revision=revision+1 WHERE id=$1', [readerId]);
			const authorities = new Authorities(manifest, 'preview');
			const boss = yield* authorities.member(db, readerId);
			if (boss === null) throw new Error('Missing administrator');
			const previewed = (yield* previewAs(boss, authorities, db, { team: 'finance' })).authority;
			yield* query('UPDATE sys_user SET admin=false,revision=revision+1 WHERE id=$1', [readerId]);
			expect(yield* decide(id, previewed)).toMatchObject({ kind: 'refused', code: 'forbidden' });
			yield* exec(`UPDATE sys_user SET team='reader',revision=revision+1 WHERE id='${financeId}'`);
			expect(yield* decide(id, finance)).toMatchObject({ kind: 'refused', code: 'forbidden' });
			expect(yield* rows('SELECT state FROM bolt_approvals')).toEqual([{ state: 'Pending' }]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'history before a request is its checkpoint; the request list finds every held record',
		() =>
			Effect.gen(function* () {
				const { order, keep } = yield* seeded;
				const id = pending(
					(yield* run(sales, {
						verb: 'update',
						input: {
							target: order,
							set: { note: 'proposed', lines: { update: [{ target: keep, set: { label: 'k2' } }] } }
						}
					})).outcome
				);
				const before = yield* readHistory(
					db,
					manifest,
					{
						kind: 'history',
						collection: 'orders',
						id: order,
						at: { _tag: 'Before', before: id },
						full: true
					},
					{ as: 'caller', authority: admin },
					bindings
				);
				expect(before).toMatchObject({ id: order, revision: 1, note: null });
				for (const [collection, record] of [
					['orders', order],
					['lines', keep]
				] as const)
					expect(
						(yield* Context.get(e, Approvals).list({ collection, records: [record] }, finance, () =>
							Effect.succeed(false)
						)).map((view) => view.id)
					).toEqual([id]);
				expect(
					yield* Context.get(e, Approvals).list(
						{ collection: 'orders', records: [order] },
						reader,
						() => Effect.succeed(false)
					)
				).toEqual([]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('an action whose acts route opens one request holding all its writes', () =>
		Effect.gen(function* () {
			const left = committed(
				(yield* run(admin, { verb: 'create', input: { title: 'left' } })).outcome
			);
			const right = committed(
				(yield* run(admin, { verb: 'create', input: { title: 'right' } })).outcome
			);
			const result = yield* Context.get(e, Callables).acts({
				name: 'orders.batch',
				acts: [
					{ collection: 'orders', verb: 'update', input: { target: left, set: { note: 'one' } } },
					{ collection: 'orders', verb: 'update', input: { target: right, set: { note: 'two' } } }
				],
				authority: sales,
				bindings,
				invocationId: 'batch-invocation',
				key: 'batch',
				issuedAt: NOW,
				from: 'Client'
			});
			const id = pending(result.outcome);
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'one' },
				{ note: 'two' }
			]);
			expect(yield* count('bolt_approvals')).toBe(1);
			expect(yield* decide(id, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: null },
				{ note: null }
			]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'finished requests are kept with their logs, a new request is a new row, and pruning keeps them',
		() =>
			Effect.gen(function* () {
				const { order } = yield* seeded;
				const first = pending(
					(yield* run(sales, { verb: 'update', input: { target: order, set: { note: 'one' } } }))
						.outcome
				);
				yield* decide(first, finance, 'REQUEST_FOR_CHANGE', 'Why?');
				yield* decide(first, sales, 'RESUBMITTED', 'Because');
				yield* decide(first, finance, 'REJECTED', 'No');
				// resubmit continued the same request: one row, its log grown linearly
				expect(yield* count('bolt_approvals')).toBe(1);
				const second = pending(
					(yield* run(sales, { verb: 'update', input: { target: order, set: { note: 'two' } } }))
						.outcome
				);
				expect(second).not.toBe(first);
				expect(yield* decide(second, finance)).toMatchObject({ status: 'APPROVED' });
				for (const note of ['3', '4', '5'])
					committed(
						(yield* run(admin, { verb: 'update', input: { target: order, set: { note } } })).outcome
					);
				yield* pruneHistory(db, 1);
				const all = yield* Context.get(e, Approvals).list(
					{ collection: 'orders', records: [order], all: true },
					sales,
					() => Effect.succeed(true)
				);
				expect(all.map((v) => [v.id, v.status])).toEqual([
					[second, 'APPROVED'],
					[first, 'REJECTED']
				]);
				expect(all[1]?.log.map((entry) => entry.move)).toEqual([
					'request',
					'requestChanges',
					'resubmit',
					'reject'
				]);
				expect(all[1]?.log.at(-1)?.rolledBack).toEqual([
					{ collection: 'orders', id: order, action: 'restored' }
				]);
				expect(all[1]?.records).toEqual([{ collection: 'orders', id: order, op: 'update' }]);
				expect(
					yield* rows("SELECT state, records->0->>'before' before FROM bolt_approvals ORDER BY seq")
				).toHaveLength(2);
				expect(yield* rows('SELECT status FROM approval_request ORDER BY status')).toEqual([
					{ status: 'APPROVED' },
					{ status: 'REJECTED' }
				]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('erasure removes the requests holding an anonymised or removed record', () =>
		Effect.gen(function* () {
			for (const remove of [false, true]) {
				const order = committed(
					(yield* run(admin, {
						verb: 'create',
						input: { title: `erase-${remove}`, note: 'personal' }
					})).outcome
				);
				const request = pending(
					(yield* run(sales, {
						verb: 'update',
						input: { target: order, set: { note: 'private' } }
					})).outcome
				);
				expect(yield* decide(request, finance)).toMatchObject({ status: 'APPROVED' });
				expect(
					(yield* run(admin, {
						verb: 'erase',
						input: { target: order, ...(remove ? {} : { set: { note: null } }) }
					})).outcome.kind
				).toBe('committed');
				expect(yield* viewOf(request, finance)).toBeNull();
				expect(yield* count('bolt_approvals')).toBe(0);
				expect(yield* count('approval_request')).toBe(0);
				expect(yield* count('requestor')).toBe(0);
				expect(
					yield* rows(`SELECT count(*)::int n FROM sys_notification WHERE once LIKE '${request}:%'`)
				).toEqual([{ n: 0 }]);
			}
		}).pipe(Effect.provide(fixture))
	);
});

const created = (outcome: Outcome, collection: string) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	const id = outcome.records.find((record) => record.collection === collection)?.id;
	if (id === undefined) throw new Error(`Missing ${collection}`);
	return id;
};

describe('the approval lock costs no round trip of its own', () => {
	const tripsOf = <A, E>(effect: Effect.Effect<A, E>) =>
		Effect.gen(function* () {
			const before = trips;
			const value = yield* effect;
			return { value, trips: trips - before };
		});
	it.effect(
		'a routed write, held or not, and a read of a held row cost what a direct one does',
		() =>
			Effect.gen(function* () {
				const { order } = yield* seeded;
				const free = committed(
					(yield* run(admin, { verb: 'create', input: { title: 'chair' } })).outcome
				);
				const direct = yield* tripsOf(
					run(ops, { verb: 'update', input: { target: free, set: { note: 'direct' } } })
				);
				expect(direct.value.outcome).toMatchObject({ kind: 'committed' });
				const plain = yield* tripsOf(read(ops, free));
				expect(plain.value).not.toHaveProperty('$approval');
				// not held: the write opens its request in its one statement
				const opened = yield* tripsOf(
					run(sales, { verb: 'update', input: { target: order, set: { note: 'proposed' } } })
				);
				const id = pending(opened.value.outcome);
				expect(opened.trips).toBe(direct.trips);
				// held, Pending: the approver's direct edit, and the reads that carry `$approval`
				const reviewed = yield* tripsOf(
					run(finance, { verb: 'update', input: { target: order, set: { note: 'reviewed' } } })
				);
				expect(reviewed.value.outcome).toMatchObject({ kind: 'committed' });
				expect(reviewed.trips).toBe(direct.trips);
				const heldRead = yield* tripsOf(read(ops, order));
				expect(heldRead.value).toMatchObject({
					$approval: { requestId: id, state: 'Pending', waitingOn: ['Finance'] }
				});
				expect(heldRead.trips).toBe(plain.trips);
				const list = yield* tripsOf(
					Context.get(e, Reads).run(
						[lowerRead(manifest, 'read', ['orders', { all: true, select: { title: true } }])],
						{ as: 'caller', authority: ops },
						bindings
					)
				);
				expect(list.trips).toBe(plain.trips);
				expect(list.value[0]).toMatchObject({
					rows: expect.arrayContaining([
						{ id: free, title: 'chair' },
						{ id: order, title: 'desk', $approval: expect.objectContaining({ requestId: id }) }
					])
				});
				// held, ChangesRequested: the requester's routed edit joins the request in its one statement
				expect(yield* decide(id, finance, 'REQUEST_FOR_CHANGE', 'Clarify')).toMatchObject({
					status: 'CHANGES_REQUESTED'
				});
				const joined = yield* tripsOf(
					run(sales, { verb: 'update', input: { target: order, set: { note: 'clarified' } } })
				);
				expect(joined.value.outcome).toMatchObject({ kind: 'committed' });
				expect(joined.trips).toBe(direct.trips);
				expect((yield* history(order)).at(-1)).toMatchObject({
					request: id,
					actor: `member:${salesId}`
				});
				expect(yield* count('bolt_approvals')).toBe(1);
				// and the lock still refuses an outsider, from the same statement
				expect(
					(yield* run(ops, { verb: 'update', input: { target: order, set: { note: 'outside' } } }))
						.outcome
				).toMatchObject({ kind: 'refused', code: 'locked' });
			}).pipe(Effect.provide(fixture))
	);
});

describe('the lock is row-level, whichever collection or path writes the held row', () => {
	it.effect(
		'writes initiated from another collection are refused whole, with nothing applied',
		() =>
			Effect.gen(function* () {
				const customer = created(
					(yield* run(admin, { collection: 'customers', verb: 'create', input: { name: 'c' } }))
						.outcome,
					'customers'
				);
				const account = created(
					(yield* run(admin, { collection: 'accounts', verb: 'create', input: { name: 'a' } }))
						.outcome,
					'accounts'
				);
				const tag = created(
					(yield* run(admin, { collection: 'tags', verb: 'create', input: { name: 't' } })).outcome,
					'tags'
				);
				const order = committed(
					(yield* run(admin, {
						verb: 'create',
						input: {
							title: 'held',
							customer,
							account,
							lines: { create: [{ label: 'l', amount: '1' }] }
						}
					})).outcome
				);
				const other = committed(
					(yield* run(admin, { verb: 'create', input: { title: 'other' } })).outcome
				);
				const line = (yield* lineIds)[0]!.id;
				const id = pending(
					(yield* run(sales, {
						verb: 'update',
						input: { target: order, set: { note: 'held', tags: { link: [tag] } } }
					})).outcome
				);
				const locked = { kind: 'refused', code: 'locked', data: { requestId: id } };
				const snapshot = () =>
					Effect.all([
						rows(
							'SELECT title, note, customer::text c, account::text a FROM orders ORDER BY title'
						),
						rows('SELECT id::text id, label FROM lines'),
						rows('SELECT "order"::text o FROM tags'),
						rows('SELECT name FROM customers'),
						rows('SELECT name FROM accounts')
					]);
				const before = yield* snapshot();
				// a batch named under another collection: an unlocked create plus the held order
				expect(
					(yield* Context.get(e, Callables).acts({
						name: 'customers.batch',
						acts: [
							{ collection: 'customers', verb: 'create', input: { name: 'new' } },
							{ collection: 'orders', verb: 'update', input: { target: order, set: { note: 'x' } } }
						],
						authority: ops,
						bindings,
						invocationId: 'cross-batch',
						key: 'cross-batch',
						issuedAt: NOW,
						from: 'Client'
					})).outcome
				).toMatchObject(locked);
				// a cascade delete into the held order, a set-null of its link, re-linking its tag from another order
				for (const [request, why] of [
					[{ collection: 'accounts', verb: 'delete', input: { target: account } }, 'cascade'],
					[{ collection: 'customers', verb: 'delete', input: { target: customer } }, 'setNull'],
					[{ verb: 'update', input: { target: other, set: { tags: { link: [tag] } } } }, 'relink'],
					[
						{
							collection: 'lines',
							verb: 'upsert',
							input: { id: line, label: 'x', amount: '1' },
							onConflict: 'update'
						},
						'upsert'
					]
				] as const)
					expect((yield* run(ops, request)).outcome, why).toMatchObject(locked);
				// per-record restore of the held child
				const restored = yield* restoreRecord(
					{ manifest, db },
					(request) => Context.get(e, Writes).act(request),
					{ collection: 'lines', record: line, revision: 1 },
					{
						authority: admin,
						bindings,
						key: 'restore-line',
						issuedAt: NOW,
						invocationId: 'restore-line'
					}
				);
				expect(restored.outcome).toMatchObject({ kind: 'refused', code: 'locked' });
				expect(yield* snapshot()).toEqual(before);
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'a derived roll-up on the held parent from an allowed write elsewhere is not an edit',
		() =>
			Effect.gen(function* () {
				const { order } = yield* seeded;
				const id = pending(
					(yield* run(sales, { verb: 'update', input: { target: order, set: { note: 'held' } } }))
						.outcome
				);
				expect(
					(yield* run(ops, {
						collection: 'payments',
						verb: 'create',
						input: { amount: '4', order }
					})).outcome.kind
				).toBe('committed');
				expect(yield* rows('SELECT paid::text paid, note FROM orders')).toEqual([
					{ paid: '4', note: 'held' }
				]);
				// the roll-up is not held or rolled back: rollback restores own stored fields only
				expect(yield* decide(id, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
				expect(yield* rows('SELECT paid::text paid, note FROM orders')).toEqual([
					{ paid: '4', note: null }
				]);
			}).pipe(Effect.provide(fixture))
	);
});

/** A release under open requests: the schema re-planned from what is applied, the engine rebuilt on the new source. */
const release = (next: EngineManifest) =>
	Effect.gen(function* () {
		yield* applyPlan(db, plan(yield* readApplied(db), next), { accept: true });
		yield* install(next);
		yield* author();
	});
/** Three held orders (note 'orig' → 'new', one line relabelled), one per decision. */
const three = Effect.gen(function* () {
	const out: { order: string; request: string }[] = [];
	for (const title of ['a', 'b', 'c']) {
		const order = committed(
			(yield* run(admin, {
				verb: 'create',
				input: { title, note: 'orig', lines: { create: [{ label: `${title}-line`, amount: '1' }] } }
			})).outcome
		);
		const line = String(
			(yield* rows('SELECT id::text id FROM lines WHERE label = $1', [`${title}-line`]))[0]?.['id']
		);
		out.push({
			order,
			request: pending(
				(yield* run(sales, {
					verb: 'update',
					input: {
						target: order,
						set: {
							note: 'new',
							lines: { update: [{ target: line, set: { label: `${title}-new` } }] }
						}
					}
				})).outcome
			)
		});
	}
	return out;
});
const withoutKey = <V>(o: { readonly [k: string]: V }, key: string) =>
	Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe('a release changes the declaration under open requests', () => {
	it.effect(
		'a removed field the request changed: rollback skips and reports it; approve and withdraw stand',
		() =>
			Effect.gen(function* () {
				const [a, b, c] = yield* three;
				const model = manifest.models['orders']!;
				const spec = manifest.collections['orders']!;
				yield* release({
					...manifest,
					models: {
						...manifest.models,
						orders: { ...model, fields: withoutKey(model.fields, 'note') }
					},
					collections: {
						...manifest.collections,
						orders: {
							...spec,
							create: {
								input: {
									...spec.create!.input,
									columns: ['title', 'status', 'customer', 'account']
								}
							},
							update: { input: { ...spec.update!.input, columns: ['title', 'status', 'customer'] } }
						}
					},
					policies: {
						...manifest.policies,
						reviewer: {
							description: 'Review',
							grants: { orders: { read: true }, lines: { read: true } }
						}
					}
				});
				expect(yield* decide(a!.request, finance, 'REJECTED')).toMatchObject({
					status: 'REJECTED'
				});
				const log = (yield* viewOf(a!.request, sales))?.log.at(-1);
				expect(log?.skipped).toEqual([
					{ collection: 'orders', id: a!.order, field: 'note', reason: 'definitionChanged' }
				]);
				expect(yield* rows("SELECT label FROM lines WHERE label LIKE 'a-%'")).toEqual([
					{ label: 'a-line' }
				]);
				expect(yield* decide(b!.request, finance)).toMatchObject({ status: 'APPROVED' });
				expect(yield* decide(c!.request, sales, 'WITHDRAWN')).toMatchObject({
					status: 'WITHDRAWN'
				});
				expect(yield* rows("SELECT label FROM lines WHERE label LIKE 'c-%'")).toEqual([
					{ label: 'c-line' }
				]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect("an added field: rollback restores the request's fields and leaves the new one", () =>
		Effect.gen(function* () {
			const [a, b, c] = yield* three;
			const model = manifest.models['orders']!;
			yield* release({
				...manifest,
				models: {
					...manifest.models,
					orders: { ...model, fields: { ...model.fields, memo: { kind: 'text', optional: true } } }
				}
			});
			expect(yield* decide(a!.request, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
			expect((yield* viewOf(a!.request, sales))?.log.at(-1)?.skipped).toEqual([]);
			expect(yield* rows('SELECT note, memo FROM orders WHERE id = $1', [a!.order])).toEqual([
				{ note: 'orig', memo: null }
			]);
			expect(yield* decide(b!.request, finance)).toMatchObject({ status: 'APPROVED' });
			expect(yield* decide(c!.request, sales, 'WITHDRAWN')).toMatchObject({ status: 'WITHDRAWN' });
			expect(yield* rows('SELECT note FROM orders WHERE id = $1', [c!.order])).toEqual([
				{ note: 'orig' }
			]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'a removed approval route: the snapshot still decides, `$approval` and the lock still hold',
		() =>
			Effect.gen(function* () {
				const [a, b, c] = yield* three;
				yield* release({
					...manifest,
					policies: {
						...manifest.policies,
						sales: {
							description: 'Sales',
							grants: { orders: { read: true }, customers: { read: true } }
						}
					}
				});
				expect(yield* read(ops, a!.order)).toMatchObject({ $approval: { requestId: a!.request } });
				expect(
					(yield* run(ops, { verb: 'update', input: { target: a!.order, set: { note: 'x' } } }))
						.outcome
				).toMatchObject({ kind: 'refused', code: 'locked' });
				expect(yield* decide(a!.request, finance, 'REJECTED')).toMatchObject({
					status: 'REJECTED'
				});
				expect(yield* rows('SELECT note FROM orders WHERE id = $1', [a!.order])).toEqual([
					{ note: 'orig' }
				]);
				expect(yield* decide(b!.request, finance)).toMatchObject({ status: 'APPROVED' });
				expect(yield* decide(c!.request, sales, 'WITHDRAWN')).toMatchObject({
					status: 'WITHDRAWN'
				});
				expect(yield* read(ops, b!.order)).not.toHaveProperty('$approval');
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'a removed child relation: its rows are skipped and reported, the root still rolls back',
		() =>
			Effect.gen(function* () {
				const [a, b, c] = yield* three;
				const model = manifest.models['orders']!;
				const spec = manifest.collections['orders']!;
				const keep = (o: { readonly [k: string]: unknown }) =>
					withoutKey(withoutKey(o, 'total'), 'big_lines');
				yield* release({
					...manifest,
					models: {
						...withoutKey(manifest.models, 'lines'),
						orders: { ...model, fields: keep(model.fields) as typeof model.fields }
					},
					relationships: withoutKey(manifest.relationships, 'lines.order'),
					collections: {
						...withoutKey(manifest.collections, 'lines'),
						orders: {
							...spec,
							create: { input: { ...spec.create!.input, with: {} } },
							update: {
								input: { ...spec.update!.input, with: { tags: spec.update!.input.with!['tags']! } }
							}
						}
					},
					policies: {
						...manifest.policies,
						reviewer: {
							description: 'Review',
							grants: { orders: { read: true, update: { fields: ['note'] } } }
						},
						direct: {
							description: 'Direct',
							grants: withoutKey(manifest.policies['direct']!.grants, 'lines')
						}
					}
				});
				expect(yield* decide(a!.request, finance, 'REJECTED')).toMatchObject({
					status: 'REJECTED'
				});
				const skipped = (yield* viewOf(a!.request, sales))?.log.at(-1)?.skipped ?? [];
				expect(skipped).toContainEqual(
					expect.objectContaining({ collection: 'lines', field: '*', reason: 'collectionRemoved' })
				);
				// the removed roll-ups are reported too, never restored
				expect(skipped.filter((x) => x.collection === 'orders').map((x) => x.reason)).not.toContain(
					'noGrant'
				);
				expect(yield* rows('SELECT note FROM orders WHERE id = $1', [a!.order])).toEqual([
					{ note: 'orig' }
				]);
				expect(yield* decide(b!.request, finance)).toMatchObject({ status: 'APPROVED' });
				expect(yield* decide(c!.request, sales, 'WITHDRAWN')).toMatchObject({
					status: 'WITHDRAWN'
				});
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'a record a release removed: decisions refuse, an administrator closes the request',
		() =>
			Effect.gen(function* () {
				const [a] = yield* three;
				// a release that dropped the row (its table rebuilt without it): the request's record is gone
				yield* exec(
					`DELETE FROM lines WHERE "order" = '${a!.order}'; DELETE FROM orders WHERE id = '${a!.order}'`
				);
				for (const [who, status] of [
					[finance, 'APPROVED'],
					[finance, 'REJECTED'],
					[sales, 'WITHDRAWN']
				] as const)
					expect(yield* decide(a!.request, who, status)).toMatchObject({
						kind: 'refused',
						code: 'sourceChanged',
						message:
							'The collection changed: its record is no longer declared; an administrator closes this request.'
					});
				expect((yield* viewOf(a!.request, admin))?.moves.map((m) => m.status)).toEqual(['CLOSED']);
				expect(yield* decide(a!.request, finance, 'CLOSED')).toMatchObject({ code: 'forbidden' });
				expect(yield* decide(a!.request, admin, 'CLOSED')).toMatchObject({
					kind: 'decided',
					status: 'WITHDRAWN'
				});
				expect((yield* viewOf(a!.request, sales))?.log.at(-1)).toMatchObject({
					move: 'close',
					reason: 'source changed',
					to: 'WITHDRAWN'
				});
			}).pipe(Effect.provide(fixture))
	);

	it.effect('close is refused while the source still exists', () =>
		Effect.gen(function* () {
			const [a] = yield* three;
			expect(yield* decide(a!.request, admin, 'CLOSED')).toMatchObject({
				kind: 'refused',
				code: 'sourceChanged'
			});
		}).pipe(Effect.provide(fixture))
	);
});
