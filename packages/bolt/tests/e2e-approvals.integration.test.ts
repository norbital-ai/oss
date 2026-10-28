// End to end through HTTP and live views: a routed write commits at once and is held by its approval request.
import { expect, layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from 'effect';
import { Approvals, Live } from '../src/engine/services.ts';
import type { LiveView } from '../src/engine/services.ts';
import { json, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';
import { ActReply, type Frame } from '../src/protocol/schema.ts';
import { TestWorkspace, type WorkspaceServices } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';

const manifest: EngineManifest = {
	needs: [],
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

// one workspace per file; each test writes its own orders
const workspace = Layer.unwrap(
	program(
		`export default { policy: { sales_approval: { grants: { orders: {
	create: { check: function* (rows, ctx) { const row = rows.findIndex((r) => r.title === 'refuse'); return row >= 0 ? ctx.deny('This title is refused.', { row, field: 'title' }) : ctx.approve((flow) => flow.step('Finance', { teams: ['finance'] })); } },
	update: { check: function* (changes, ctx) { return ctx.approve((flow) => flow.step('Finance', { teams: ['finance'] })); } }
} } } } };`
	).pipe(Effect.map((guest) => TestWorkspace.layer({ manifest, guest })))
);
const setup = Effect.gen(function* () {
	const context = yield* Effect.context<TestWorkspace | WorkspaceServices>();
	const t = yield* TestWorkspace,
		live = yield* Live,
		approvals = yield* Approvals,
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
		route,
		sales,
		finance,
		held,
		target,
		decide,
		post,
		settled,
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

layer(workspace, { excludeTestServices: true })('an approval flow in the policy grant', (it) => {
	// first: the finance inbox holds no other test's request yet
	it.effect('a rejection and an erase each purge their request from open inboxes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, approvals, sales, finance, held, target, post, settled, inboxView } =
					yield* setup;
				const admin = () => t.as(t.admin).authority;
				const id = created(
					(yield* post(admin, 'orders.create', [{ title: 'Erase fixture' }])).reply.outcome
				);
				const own = yield* inboxView(sales()),
					reviewer = yield* inboxView(finance());
				try {
					const rejected = request(
						(yield* post(sales, 'orders.create', [{ title: 'reject' }])).reply.outcome
					);
					const rejectedId = yield* target(rejected);
					const erased = request(
						(yield* post(sales, 'orders.update', [{ target: id, set: { note: 'Prospective' } }]))
							.reply.outcome
					);
					yield* settled;
					expect(reviewer.value()).toMatchObject({ requests: [{}, {}] });
					expect(
						(yield* post(finance, 'approvals.decide', {
							requestId: rejected,
							decision: 'reject',
							reason: 'Not accepted.'
						})).status
					).toBe(200);
					yield* settled;
					expect(reviewer.value()).toMatchObject({ requests: [{ id: erased }] });
					expect(yield* held(rejectedId)).toBeUndefined();
					expect(yield* post(sales, 'orders.erase', { target: id })).toMatchObject({
						status: 403,
						reply: { outcome: { kind: 'refused', code: 'forbidden' } }
					});
					expect(yield* post(admin, 'orders.erase', { target: id })).toMatchObject({
						status: 200
					});
					yield* settled;
					expect(own.value()).toEqual({ rows: [], unread: 0, requests: [] });
					expect(reviewer.value()).toEqual({ rows: [], unread: 0, requests: [] });
					expect(yield* held(id)).toBeUndefined();
					expect(
						Option.getOrNull(yield* approvals.view(erased, sales(), () => Effect.succeed(false)))
					).toBeNull();
				} finally {
					for (const view of [own, reviewer]) yield* Fiber.interrupt(view.fiber);
				}
			})
		)
	);

	it.effect('records a pure approval callback refusal even when no write callback runs', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, sales, post } = yield* setup;
				const outcomes = t.db.value(Schema.Number, {
					text: 'SELECT count(*)::int FROM bolt_idem_outcome',
					params: []
				});
				const before = yield* outcomes;
				expect(
					(yield* post(sales, 'orders.create', [{ title: 'refuse' }])).reply.outcome
				).toMatchObject({ kind: 'refused', code: 'refused', message: 'This title is refused.' });
				expect(yield* outcomes).toBe(before + 1);
			})
		)
	);

	it.effect(
		'GET /__bolt/approval lists the request to its approver; kit reads keep `$approval` as the wire carries it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, sales, finance, target, post, route } = yield* setup;
					const requestId = request(
						(yield* post(sales, 'orders.create', [{ title: 'listed' }])).reply.outcome
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
					expect(yield* listed('')).toContain(requestId);
					expect(yield* listed(`?model=orders&record=${id}&all=1`)).toEqual([requestId]);
					const $approval = {
						requestId,
						state: 'Pending',
						step: 0,
						steps: [{ name: 'Finance', teams: ['finance'], users: [] }],
						requestedBy: expect.any(String)
					};
					const reader = t.as(t.member(['finance']));
					const listedRow = <R extends object>(rows: readonly R[] | undefined) =>
						(rows ?? []).filter((row) => Reflect.get(row, 'title') === 'listed');
					expect(listedRow((yield* reader.query({ orders: {} })).orders.rows)).toEqual([
						expect.objectContaining({ title: 'listed', $approval })
					]);
					// the same layer map built at runtime: checked host-side, answered as JSON rows
					const dynamic = dynamicRead({ orders: { fields: ['title'] } });
					expect(listedRow((yield* reader.query(dynamic)).orders?.rows)).toEqual([
						{ id: expect.any(String), title: 'listed', $approval }
					]);
				})
			)
	);

	it.effect('history.preview lists the change; history.restore commits it as a restored revision', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, held, post } = yield* setup;
				const admin = () => t.as(t.admin).authority;
				const id = created(
					(yield* post(admin, 'orders.create', [{ title: 'desk', note: 'a' }])).reply.outcome
				);
				ok((yield* post(admin, 'orders.update', [{ target: id, set: { note: 'b' } }])).reply.outcome);
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
