// End to end through HTTP and live views: a routed write commits at once and is held by its approval request.
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from 'effect';
import { Approvals, Live, Reads } from '../src/engine/services.ts';
import type { LiveView } from '../src/engine/services.ts';
import { json, routeFixture } from './support/route-fixture.ts';
import { patched } from '../src/page/bolt.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { lowerRead } from '../src/engine/query/engine.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';
import { ActReply, type Frame } from '../src/protocol/schema.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'An order',
			label: 'title',
			fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		orders: {
			read: { orders: { fields: 'all' } },
			create: { columns: { orders: ['title', 'note'] } },
			update: { columns: { orders: ['title', 'note'] } }
		}
	},
	policies: {
		sales: {
			description: 'Sales',
			grants: {
				orders: {
					read: true,
					update: { columns: { orders: ['title'] } }
				}
			}
		},
		sales_approval: {
			description: 'Sales approval',
			grants: {
				orders: {
					read: true,
					create: { check: true },
					update: { columns: { orders: ['title', 'note'] }, check: true }
				}
			}
		},
		finance: { description: 'Finance', grants: { orders: { read: true } } }
	},
	integrations: {},
	teams: { sales: ['sales', 'sales_approval'], finance: ['finance'], ops: [] },
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};

const setup = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			guest: yield* program(
				`export default { policy: { sales_approval: { grants: { orders: {
	create: { check: function* (rows, ctx) { const row = rows.findIndex((r) => r.title === 'refuse'); return row >= 0 ? ctx.deny('This title is refused.', { row, field: 'title' }) : ctx.approve((flow) => flow.step('Finance', { teams: ['finance'] })); } },
	update: { check: function* (changes, ctx) { return ctx.approve((flow) => flow.step('Finance', { teams: ['finance'] })); } }
} } } } };`
			)
		})
	);
	const t = Context.get(context, TestWorkspace),
		live = Context.get(context, Live),
		approvals = Context.get(context, Approvals),
		reads = Context.get(context, Reads),
		route = yield* routeFixture(context);
	const rep = t.member(['sales', 'sales_approval']),
		fin = t.member(['finance']);
	yield* t.db.write({
		text: 'UPDATE sys_user SET team=CASE WHEN id=$1 THEN $3 ELSE $4 END WHERE id IN ($1,$2)',
		params: [rep.id, fin.id, 'sales', 'finance']
	});
	const authorities = new Authorities(manifest, 'e2e');
	const salesAuthority = yield* authorities.member(t.db, rep.id),
		financeAuthority = yield* authorities.member(t.db, fin.id);
	if (salesAuthority === null || financeAuthority === null)
		throw new Error('Missing test affiliation');
	const sales = () => salesAuthority,
		finance = () => financeAuthority;
	const held = (id: string) =>
		t.db
			.read([{ text: 'SELECT title, note FROM orders WHERE id::text = $1', params: [id] }])
			.pipe(Effect.map(([result]) => result?.rows[0]));
	const target = (id: string) =>
		t.db.value(Schema.String, {
			text: 'SELECT record_id FROM approval_request WHERE id=$1',
			params: [id]
		});
	const decide = (requestId: string, decision: 'approve' | 'reject' | 'requestChanges') =>
		approvals.decide({
			requestId,
			decision,
			...(decision === 'approve' ? {} : { reason: 'Please revise.' }),
			authority: finance(),
			now: t.clock.now()
		});
	const post = (who: () => Authority, callable: string, input: Json) =>
		Effect.gen(function* () {
			const response = yield* route.handle(
				who(),
				new Request('http://cell/__bolt/act', {
					method: 'POST',
					headers: { 'Idempotency-Key': crypto.randomUUID() },
					body: JSON.stringify({ callable, input, issuedAt: t.clock.now() })
				})
			);
			return {
				status: response.status,
				reply: yield* Schema.decodeUnknownEffect(ActReply)(yield* json(response))
			};
		});
	const flushes: (() => Effect.Effect<void>)[] = [];
	const settled = Effect.gen(function* () {
		yield* live.settled;
		for (const flush of flushes) yield* flush();
	});
	const connect = (authority: Authority, view: string, read: LiveView) =>
		Effect.gen(function* () {
			const frames: Frame[] = [],
				received = yield* Queue.unbounded<Frame>(),
				hello = yield* Deferred.make<string>();
			const fiber = yield* live.connect(authority).pipe(
				Stream.runForEach((frame) =>
					Effect.gen(function* () {
						frames.push(frame);
						yield* Queue.offer(received, frame);
						if (frame.t === 'hello') yield* Deferred.succeed(hello, frame.conn);
					})
				),
				Effect.forkScoped
			);
			const conn = yield* Deferred.await(hello);
			yield* live.register(conn, view, read);
			while (!frames.some((frame) => frame.t === 'answer' && frame.view === view))
				yield* Queue.take(received);
			const flush = () =>
				Effect.gen(function* () {
					const v = yield* live.v;
					while (!frames.some((frame) => 'v' in frame && frame.v >= v)) yield* Queue.take(received);
				});
			flushes.push(flush);
			return { frames, fiber };
		});
	const committedView = () =>
		Effect.gen(function* () {
			const { frames } = yield* connect(sales(), 'v', {
				read: lowerRead(t.manifest, 'query', [{ orders: { fields: ['title'] } }])
			});
			return () =>
				settled.pipe(
					Effect.map(() =>
						frames.reduce<{ v: number; value: Json | undefined }>(
							(last, frame) =>
								frame.t === 'answer'
									? { v: frame.v, value: frame.value }
									: frame.t === 'patch'
										? { v: frame.v, value: patched(last.value, frame.ops) }
										: last,
							{ v: 0, value: undefined }
						)
					)
				);
		});
	const inboxView = (authority: Authority) =>
		Effect.gen(function* () {
			if (authority.actor.kind !== 'member') throw new Error('Expected a member.');
			const { frames, fiber } = yield* connect(authority, 'inbox', {
				read: {
					kind: 'inbox',
					model: 'sys_notification',
					member: authority.actor.id,
					requests: true
				}
			});
			return {
				fiber,
				value: () => {
					const frame = frames.findLast((frame) => frame.t === 'answer' && frame.view === 'inbox');
					return frame?.t === 'answer' ? frame.value : undefined;
				}
			};
		});
	return {
		t,
		live,
		approvals,
		reads,
		route,
		sales,
		finance,
		held,
		target,
		decide,
		post,
		settled,
		committedView,
		inboxView
	};
});
const request = (outcome: Outcome) => {
	if (outcome.kind !== 'pendingApproval') throw new Error(JSON.stringify(outcome));
	return outcome.requestId;
};
const ok = (outcome: Outcome) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	return outcome;
};
const created = (outcome: Outcome) => {
	if (outcome.kind !== 'committed' || outcome.records[0] === undefined)
		throw new Error('Expected a stored order.');
	return outcome.records[0].id;
};

describe('an approval flow in the policy grant', () => {
	it.live('records a pure approval callback refusal even when no write callback runs', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, sales, post } = yield* setup;
				expect(
					(yield* post(sales, 'orders.create', [{ title: 'refuse' }])).reply.outcome
				).toMatchObject({ kind: 'refused', code: 'refused', message: 'This title is refused.' });
				expect(
					yield* t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_idem_outcome',
						params: []
					})
				).toBe(1);
			})
		)
	);
	it.live(
		'a create commits at once, held by its request until the configured approver approves',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, sales, held, target, decide, post } = yield* setup;
					const requestId = request(
						(yield* post(sales, 'orders.create', [{ title: 'desk' }])).reply.outcome
					);
					const id = yield* target(requestId);
					expect(yield* held(id)).toEqual({ title: 'desk', note: null });
					expect(
						(yield* post(
							() => t.as(t.member(['sales'], { teams: ['ops'], teamPath: ['ops'] })).authority,
							'orders.update',
							[{ target: id, set: { title: 'x' } }]
						)).reply.outcome
					).toMatchObject({ kind: 'refused', code: 'locked', data: { requestId } });
					expect(yield* decide(requestId, 'approve')).toMatchObject({ kind: 'decided' });
					expect(yield* held(id)).toEqual({ title: 'desk', note: null });
				})
			)
	);

	it.live('GET /__bolt/approval lists the request to its approver, with or without filters', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { sales, finance, target, post, route } = yield* setup;
				const requestId = request(
					(yield* post(sales, 'orders.create', [{ title: 'desk' }])).reply.outcome
				);
				const id = yield* target(requestId);
				const listed = (query: string) =>
					Effect.gen(function* () {
						const body = yield* json(
							yield* route.handle(finance(), new Request(`http://cell/__bolt/approval${query}`))
						);
						return Schema.decodeUnknownSync(
							Schema.Struct({ value: Schema.Array(Schema.Struct({ id: Schema.String })) })
						)(body).value.map((v) => v.id);
					});
				expect(yield* listed('')).toEqual([requestId]);
				expect(yield* listed(`?model=orders&record=${id}&all=1`)).toEqual([requestId]);
			})
		)
	);

	it.live(
		'a denied update matching the source route commits provisionally; a granted one directly; rejection rolls back',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, sales, held, decide, post } = yield* setup;
					const id = created(
						(yield* post(() => t.as(t.admin).authority, 'orders.create', [
							{
								title: 'desk',
								note: 'a'
							}
						])).reply.outcome
					);
					expect(
						(yield* post(sales, 'orders.update', [{ target: id, set: { title: 'chair' } }])).reply
							.outcome
					).toMatchObject({ kind: 'committed' });
					const requestId = request(
						(yield* post(sales, 'orders.update', [{ target: id, set: { note: 'b' } }])).reply
							.outcome
					);
					expect(yield* held(id)).toEqual({ title: 'chair', note: 'b' });
					expect(yield* decide(requestId, 'reject')).toMatchObject({ kind: 'decided' });
					expect(yield* held(id)).toEqual({ title: 'chair', note: 'a' });
				})
			)
	);

	it.live('test-kit reads keep `$approval` as the wire carries it, with or without a select', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, sales, post } = yield* setup;
				const requestId = request(
					(yield* post(sales, 'orders.create', [{ title: 'desk' }])).reply.outcome
				);
				const $approval = {
					requestId,
					state: 'Pending',
					step: 0,
					steps: [{ name: 'Finance', teams: ['finance'], users: [] }],
					requestedBy: expect.any(String)
				};
				const reader = t.as(t.member(['finance']));
				expect((yield* reader.query({ orders: {} })).orders.rows).toEqual([
					expect.objectContaining({ title: 'desk', $approval })
				]);
				// the same layer map built at runtime: checked host-side, answered as JSON rows
				const dynamic = dynamicRead({ orders: { fields: ['title'] } });
				const picked = (yield* reader.query(dynamic)).orders?.rows;
				expect(picked).toEqual([{ id: expect.any(String), title: 'desk', $approval }]);
			})
		)
	);
});

describe('a per-record restore over /__bolt/act (rule 17)', () => {
	it.live(
		'history.preview lists the change; history.restore commits it as a restored revision',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, held, post } = yield* setup;
					const admin = () => t.as(t.admin).authority;
					const id = created(
						(yield* post(admin, 'orders.create', [{ title: 'desk', note: 'a' }])).reply.outcome
					);
					ok(
						(yield* post(admin, 'orders.update', [{ target: id, set: { note: 'b' } }])).reply
							.outcome
					);
					const target = { model: 'orders', record: id, revision: 1 };
					expect((yield* post(admin, 'history.preview', target)).reply.outcome).toMatchObject({
						kind: 'committed',
						output: {
							live: 2,
							changes: [{ field: 'note', current: 'b', restored: 'a', approval: false }],
							skipped: []
						}
					});
					ok((yield* post(admin, 'history.restore', target)).reply.outcome);
					expect(yield* held(id)).toEqual({ title: 'desk', note: 'a' });
					expect(
						yield* t.db.value(Schema.Number, {
							text: "SELECT restored_from FROM bolt_history WHERE record = $1::uuid AND cause = 'restored'",
							params: [id]
						})
					).toBe(1);
				})
			)
	);
});

describe('decisions over /__bolt/act reach the live lane (rules 46, 47, 66)', () => {
	it.live(
		'native inbox requests refresh across sessions; the held record is live from the start',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, reads, sales, finance, held, target, post, settled, inboxView } = yield* setup;
					const own = yield* inboxView(sales()),
						reviewer = yield* inboxView(finance());
					const stranger = yield* inboxView(
						t.as(t.member([], { teams: ['ops'], teamPath: ['ops'] })).authority
					);
					try {
						expect(reviewer.value()).toEqual({ rows: [], unread: 0, requests: [] });
						const requestor = sales().actor;
						if (requestor.kind !== 'member') throw new Error('Expected a member.');
						expect(
							yield* reads
								.run(
									[
										{
											kind: 'inbox',
											model: 'sys_notification',
											member: requestor.id,
											requests: true
										}
									],
									{ as: 'caller', authority: finance() },
									{ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }
								)
								.pipe(Effect.flip)
						).toMatchObject({ code: 'forbidden' });
						const submitted = yield* post(sales, 'orders.create', [{ title: 'desk' }]);
						const requestId = request(submitted.reply.outcome);
						yield* settled;
						expect(own.value()).toMatchObject({
							requests: [{ id: requestId, mine: true, canDecide: false }]
						});
						expect(reviewer.value()).toMatchObject({
							requests: [{ id: requestId, mine: false, canDecide: true }]
						});
						expect(stranger.value()).toEqual({ rows: [], unread: 0, requests: [] });
						expect(yield* held(yield* target(requestId))).toEqual({ title: 'desk', note: null });
						expect(
							(yield* t.db.read([
								{ text: 'SELECT count(*)::int AS n FROM sys_notification', params: [] }
							]))[0]?.rows
						).toEqual([{ n: 0 }]);
						expect(
							yield* post(finance, 'approvals.decide', { requestId, decision: 'approve' })
						).toMatchObject({ status: 200 });
						yield* settled;
						expect(own.value()).toEqual({ rows: [], unread: 0, requests: [] });
						expect(reviewer.value()).toEqual({ rows: [], unread: 0, requests: [] });
						expect(yield* held(yield* target(requestId))).toEqual({ title: 'desk', note: null });
					} finally {
						for (const view of [own, reviewer, stranger]) yield* Fiber.interrupt(view.fiber);
					}
				})
			)
	);

	it.live('rejection refreshes open inboxes and rolls the provisional create back', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { sales, finance, held, target, post, settled, inboxView } = yield* setup;
				const own = yield* inboxView(sales()),
					reviewer = yield* inboxView(finance());
				try {
					const submitted = yield* post(sales, 'orders.create', [{ title: 'reject' }]);
					const requestId = request(submitted.reply.outcome),
						id = yield* target(requestId);
					yield* settled;
					expect(reviewer.value()).toMatchObject({ requests: [{ id: requestId }] });
					expect(yield* held(id)).toEqual({ title: 'reject', note: null });
					expect(
						(yield* post(finance, 'approvals.decide', {
							requestId,
							decision: 'reject',
							reason: 'Not accepted.'
						})).status
					).toBe(200);
					yield* settled;
					expect(own.value()).toEqual({ rows: [], unread: 0, requests: [] });
					expect(reviewer.value()).toEqual({ rows: [], unread: 0, requests: [] });
					expect(yield* held(id)).toBeUndefined();
				} finally {
					for (const view of [own, reviewer]) yield* Fiber.interrupt(view.fiber);
				}
			})
		)
	);

	it.live('erasing a proposed update purges its request from already-open inboxes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, approvals, sales, finance, held, post, settled, inboxView } = yield* setup;
				const created = (yield* post(() => t.as(t.admin).authority, 'orders.create', [
					{
						title: 'Erase fixture'
					}
				])).reply.outcome;
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Expected a stored order.');
				const id = created.records[0].id,
					own = yield* inboxView(sales()),
					reviewer = yield* inboxView(finance());
				try {
					const submitted = yield* post(sales, 'orders.update', [
						{
							target: id,
							set: { note: 'Prospective value' }
						}
					]);
					const requestId = request(submitted.reply.outcome);
					yield* settled;
					expect(reviewer.value()).toMatchObject({ requests: [{ id: requestId }] });
					expect(yield* post(sales, 'orders.erase', { target: id })).toMatchObject({
						status: 403,
						reply: { outcome: { kind: 'refused', code: 'forbidden' } }
					});
					expect(
						yield* post(() => t.as(t.admin).authority, 'orders.erase', { target: id })
					).toMatchObject({ status: 200 });
					yield* settled;
					expect(own.value()).toEqual({ rows: [], unread: 0, requests: [] });
					expect(reviewer.value()).toEqual({ rows: [], unread: 0, requests: [] });
					expect(yield* held(id)).toBeUndefined();
					expect(
						Option.getOrNull(yield* approvals.view(requestId, sales(), () => Effect.succeed(false)))
					).toBeNull();
				} finally {
					yield* Fiber.interrupt(own.fiber);
					yield* Fiber.interrupt(reviewer.fiber);
				}
			})
		)
	);

	it.live(
		'a routed create is 202; the live view sees the held row at once; the lock refuses an outsider',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, sales, finance, target, post, committedView } = yield* setup;
					const last = yield* committedView();
					const held = yield* post(sales, 'orders.create', [{ title: 'desk' }]);
					expect(held.status).toBe(202);
					const requestId = request(held.reply.outcome);
					const id = yield* target(requestId);
					const ops = () =>
						t.as(t.member(['sales'], { teams: ['ops'], teamPath: ['ops'] })).authority;
					const refused = yield* post(ops, 'orders.update', [{ target: id, set: { title: 'x' } }]);
					expect(refused).toMatchObject({
						reply: { outcome: { kind: 'refused', code: 'locked' } }
					});
					expect((yield* last()).value).toMatchObject({ orders: { rows: [{ title: 'desk' }] } });
					const decided = yield* post(finance, 'approvals.decide', {
						requestId,
						decision: 'approve'
					});
					expect(decided).toMatchObject({
						status: 200,
						reply: { outcome: { kind: 'committed', output: { requestId, status: 'Approved' } } }
					});
					const frame = yield* last();
					expect(frame.value).toMatchObject({ orders: { rows: [{ title: 'desk' }] } });
					expect(frame.v).toBe(decided.reply.v);
				})
			)
	);

	it.live('rejection rolls back once; a requester resubmits requested changes by saving', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, sales, finance, held, post, committedView } = yield* setup;
				const id = created(
					(yield* post(() => t.as(t.admin).authority, 'orders.create', [
						{
							title: 'desk',
							note: 'a'
						}
					])).reply.outcome
				);
				const last = yield* committedView();
				const requestId = request(
					(yield* post(sales, 'orders.update', [{ target: id, set: { note: 'b' } }])).reply.outcome
				);
				expect((yield* last()).value).toMatchObject({ orders: { rows: [{ title: 'desk' }] } });
				expect(
					(yield* post(finance, 'approvals.decide', {
						requestId,
						decision: 'reject',
						reason: 'Not accepted.'
					})).reply.outcome
				).toMatchObject({ output: { status: 'Rejected' } });
				expect((yield* last()).value).toMatchObject({ orders: { rows: [{ title: 'desk' }] } });
				expect(
					(yield* post(finance, 'approvals.decide', { requestId, decision: 'approve' })).reply
						.outcome
				).toMatchObject({ kind: 'refused', code: 'invalidInput' });
				expect(yield* held(id)).toEqual({ title: 'desk', note: 'a' });
				const rep = sales();
				const again = request(
					(yield* post(() => rep, 'orders.update', [{ target: id, set: { note: 'c' } }])).reply
						.outcome
				);
				expect(
					(yield* post(() => rep, 'approvals.decide', {
						requestId: again,
						decision: 'reject',
						reason: 'Not accepted.'
					})).reply.outcome
				).toMatchObject({ code: 'forbidden' });
				expect(
					(yield* post(finance, 'approvals.decide', {
						requestId: again,
						decision: 'requestChanges',
						reason: 'Revise the note.'
					})).reply.outcome
				).toMatchObject({ output: { status: 'ChangesRequested' } });
				expect(
					(yield* post(() => rep, 'orders.update', [{ target: id, set: { note: 'revised' } }]))
						.reply.outcome
				).toMatchObject({ kind: 'pendingApproval', requestId: again });
				expect(
					(yield* post(finance, 'approvals.decide', { requestId: again, decision: 'approve' }))
						.reply.outcome
				).toMatchObject({ output: { status: 'Approved' } });
				expect(yield* held(id)).toEqual({ title: 'desk', note: 'revised' });
			})
		)
	);

	it.live(
		'a final decision is one statement, refused a second time, and queues no approval follow-up',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, sales, decide, post } = yield* setup;
					const requestId = request(
						(yield* post(sales, 'orders.create', [{ title: 'desk' }])).reply.outcome
					);
					expect(yield* decide(requestId, 'approve')).toMatchObject({ kind: 'decided' });
					expect(yield* decide(requestId, 'approve')).toMatchObject({
						kind: 'refused',
						code: 'invalidInput'
					});
					expect(
						present(
							(yield* t.db.read([
								{
									text: `SELECT automation, state FROM sys_run WHERE cause = 'approval'`,
									params: []
								}
							]))[0]
						).rows
					).toEqual([]);
				})
			)
	);
});
