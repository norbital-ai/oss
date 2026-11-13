// End to end through HTTP and live views: a routed write commits at once and is held by its approval request.
import { expect, layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from 'effect';
import { Approvals, Live } from '../src/engine/services.ts';
import type { LiveView } from '../src/engine/services.ts';
import { json, route_fixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';
import { ActReply, type Frame } from '../src/protocol/schema.ts';
import {
	NativeReadRow,
	TestWorkspace,
	type WorkspaceServices
} from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'An order',
			record_label: 'record.title',
			fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		orders: {
			outputs: { default: { orders: { fields: 'all' } } },
			create: { columns: { orders: ['title', 'note'] } },
			update: { columns: { orders: ['title', 'note'] } }
		}
	},
	policies: {
		sales: {
			description: 'Sales',
			grants: {
				orders: {
					outputs: { default: {} },
					update: { columns: { orders: ['title'] } }
				}
			}
		},
		sales_approval: {
			description: 'Sales approval',
			grants: {
				orders: {
					outputs: { default: {} },
					create: { verdict: true },
					update: { columns: { orders: ['title', 'note'] }, verdict: true }
				}
			}
		},
		finance: { description: 'Finance', grants: { orders: { outputs: { default: {} } } } }
	},
	integrations: {},
	teams: { sales: { policies: ['sales', 'sales_approval'] }, finance: { policies: ['finance'] }, ops: { policies: [] } },
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const OrderPage = Schema.Struct({
	orders: Schema.Struct({
		rows: Schema.Array(
			Schema.StructWithRest(
				Schema.Struct({ ...NativeReadRow.schema.fields, title: Schema.String }),
				NativeReadRow.records
			)
		)
	})
});

// one workspace per file; each test writes its own orders
const workspace = Layer.unwrap(
	program(
		`export default { policy: { sales_approval: { grants: { orders: {
	create: { verdict: function* (changes, ctx) { const row = changes.findIndex((change) => change.after.title === 'refuse'); return row >= 0 ? yield* ctx.refuse('This title is refused.', { row, field: 'title' }) : ctx.approve({ steps: [{ name: 'Finance', teams: ['finance'] }] }); } },
	update: { verdict: function* (changes, ctx) { return ctx.approve({ steps: [{ name: 'Finance', teams: ['finance'] }] }); } }
} } } } };`
	).pipe(Effect.map((guest) => TestWorkspace.layer({ manifest, guest })))
);
const setup = Effect.gen(function* () {
	const context = yield* Effect.context<TestWorkspace | WorkspaceServices>();
	const t = yield* TestWorkspace,
		live = yield* Live,
		approvals = yield* Approvals,
		route = yield* route_fixture(context);
	const rep = t.member(['sales', 'sales_approval']),
		fin = t.member(['finance']);
	yield* t.db.write({
		text: 'UPDATE sys_user SET team=CASE WHEN id=$1 THEN $3 ELSE $4 END WHERE id IN ($1,$2)',
		params: [rep.id, fin.id, 'sales', 'finance']
	});
	const authorities = new Authorities(manifest, 'e2e');
	const salesAuthority = yield* authorities.member(t.db, 'bootstrap', rep.id),
		financeAuthority = yield* authorities.member(t.db, 'bootstrap', fin.id);
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
	const current = (id: string) => t.db.value(Schema.Struct({ id: Schema.String, revision: Schema.Int }), {
		text: "SELECT jsonb_build_object('id',id,'revision',revision) FROM orders WHERE id=$1::uuid",
		params: [id]
	});
	const decide = (request_id: string, decision: 'approve' | 'reject' | 'request_changes') =>
		approvals.decide({
			request_id,
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
					body: JSON.stringify({
						...(['orders.create', 'orders.update', 'orders.erase'].includes(callable)
							? { acts: { [callable]: input } }
							: { callable, input }),
						issued_at: t.clock.now()
					})
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
		current,
		decide,
		post,
		settled,
		inboxView
	};
});
const request = (outcome: Outcome) => {
	if (outcome.kind !== 'pending_approval') throw new Error(JSON.stringify(outcome));
	return outcome.request_id;
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
	it.effect('a rejection closes its request in both inboxes; an erase purges its request', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, approvals, sales, finance, held, target, current, post, settled, inboxView } =
					yield* setup;
				const adminAuthority = (yield* t.as(t.admin)).authority;
				const admin = () => adminAuthority;
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
						(yield* post(sales, 'orders.update', [{ target: yield* current(id), set: { note: 'Prospective' } }]))
							.reply.outcome
					);
					yield* settled;
					expect(reviewer.value()).toMatchObject({ requests: [{}, {}] });
					expect(
						(yield* post(finance, 'approvals.decide', {
							request_id: rejected,
							decision: 'reject',
							reason: 'Not accepted.'
						})).status
					).toBe(200);
					yield* settled;
					// the decided request stays listed for whoever decided it, closed
					expect(reviewer.value()).toMatchObject({
						requests: [
							{ id: erased, status: 'Pending' },
							{ id: rejected, status: 'Rejected', moves: [] }
						]
					});
					expect(yield* held(rejectedId)).toBeUndefined();
					expect(yield* post(sales, 'orders.erase', { target: yield* current(id) })).toMatchObject({
						status: 403,
						reply: { outcome: { kind: 'refused', code: 'forbidden' } }
					});
					expect(yield* post(admin, 'orders.erase', { target: yield* current(id) })).toMatchObject({
						status: 200
					});
					yield* settled;
					// the erase purges its request; the rejected one remains, and its requester was told why
					expect(own.value()).toMatchObject({
						rows: [{ title: expect.stringMatching(/^Rejected/), body: 'Not accepted.' }],
						unread: 1,
						requests: [{ id: rejected, status: 'Rejected' }]
					});
					expect(reviewer.value()).toMatchObject({
						rows: [],
						requests: [{ id: rejected, status: 'Rejected' }]
					});
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
					const request_id = request(
						(yield* post(sales, 'orders.create', [{ title: 'listed' }])).reply.outcome
					);
					const id = yield* target(request_id);
					const listed = (query: string) =>
						Effect.gen(function* () {
							const body = yield* json(
								yield* route.handle(finance(), new Request(`http://cell/__bolt/approval${query}`))
							);
							return Schema.decodeUnknownSync(
								Schema.Struct({ value: Schema.Array(Schema.Struct({ id: Schema.String })) })
							)(body).value.map((v) => v.id);
						});
					expect(yield* listed('')).toContain(request_id);
					expect(yield* listed(`?model=orders&record=${id}&all=1`)).toEqual([request_id]);
					const $approval = {
						request_id,
						state: 'Pending',
						step: 0,
						steps: [{ name: 'Finance', teams: ['finance'], users: [] }],
						requested_by: expect.any(String)
					};
					const reader = yield* t.as(t.member(['finance']));
					const listedRows = (answer: typeof OrderPage.Type) =>
						answer.orders.rows.filter((row) => row.title === 'listed');
					expect(
						yield* reader.query({ orders: {} }).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(OrderPage)),
							Effect.map(listedRows)
						)
					).toEqual([
						expect.objectContaining({ title: 'listed', $approval })
					]);
					// the same layer map built at runtime: checked host-side, answered as JSON rows
					const dynamic = dynamic_read({ orders: { fields: ['title'] } });
					expect(
						yield* reader.query(dynamic).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(OrderPage)),
							Effect.map(listedRows)
						)
					).toEqual([
						{ id: expect.any(String), title: 'listed', $approval }
					]);
				})
			)
	);

	it.effect(
		'history.preview lists the change; history.restore commits it as a restored revision',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, held, current, post } = yield* setup;
					const adminAuthority = (yield* t.as(t.admin)).authority;
				const admin = () => adminAuthority;
					const id = created(
						(yield* post(admin, 'orders.create', [{ title: 'desk', note: 'a' }])).reply.outcome
					);
					ok(
						(yield* post(admin, 'orders.update', [{ target: yield* current(id), set: { note: 'b' } }])).reply
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
