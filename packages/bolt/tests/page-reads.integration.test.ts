// The unified page query wire: declared queries, index search, record/list projections and text ids; history stays explicit.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority } from '../src/engine/contracts.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { QReply, WireError } from '../src/protocol/schema.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import type { WireRead } from '../src/protocol/wire.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			orders: {
				description: 'An order',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					doc: { kind: 'json', optional: true },
					color: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
					code: { kind: 'seq', pattern: 'O-{0000}' }
				},
				search: {
					text: ['code', 'title'],
					indexes: {
						hue: {
							description: 'Hue',
							dim: 3,
							metric: 'l2',
							field: 'color',
							input: {
								r: { kind: 'decimal', scale: 2 },
								window: { kind: 'custom', of: 'probe_window', optional: true }
							},
							candidates: 2,
							rerank: true
						}
					}
				}
			}
		},
		relationships: {},
		collections: {
			orders: {
				read: { fields: 'all' },
				create: { input: { columns: ['title', 'doc', 'color'] } },
				update: { input: { columns: ['title'] } },
				queries: {
					titled: {
						description: 'Titles',
						input: { prefix: { kind: 'text' } },
						output: { kind: 'json' }
					}
				}
			}
		},
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				grants: {
					orders: { read: true, create: true, update: true, history: true, queries: ['titled'] }
				}
			}
		},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {
			probe_window: {
				description: 'A synthetic probe window',
				shape: {
					kind: 'object',
					fields: { samples: { kind: 'list', of: { kind: 'number' }, min: 1, max: 2 } }
				},
				check: true
			}
		},
		agent: { skills: {} },
		apps: {}
	})
);

const guest =
	program(`export default { custom_field: { probe_window: { check: (window) => window.samples.some((value) => value < 0) ? 'Probe samples cannot be negative.' : undefined } }, collection: { orders: { bodies: {
	queries: { titled: function* (input, ctx) { return (yield* ctx.query('orders', { all: true, orderBy: 'title' })).rows.map((r) => r.title).filter((t) => t.startsWith(input.prefix)); } },
	indexes: { hue: {
		probe: (q) => ({ vector: [q.r.toNumber(), 0, 0] }),
		// the exact score: nearest to 0.5 on the first channel, whatever the probe
		rerank: (q, row) => Math.abs(row.color[0] - (0.5 + q.r.toNumber())),
	} },
} } } };`);

const setup = () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context);
		const rep = t.as(t.member(['rep'])).authority,
			ids: string[] = [];
		const act = (callable: string, input: Json) =>
			actReply(route, rep, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		for (const [title, r] of [
			['alpha', 0.1],
			['alder', 0.45],
			['beta', 0.9],
			['bravo', 0.6]
		] as const) {
			const o = yield* act('orders.create', { title, doc: { lines: [title] }, color: [r, 0, 0] });
			if (o.kind !== 'committed' || o.records[0] === undefined) throw new Error(JSON.stringify(o));
			ids.push(o.records[0].id);
		}
		const first = ids[0];
		if (first === undefined) throw new Error('first order missing');
		yield* act('orders.update', { target: first, set: { title: 'alpha 2' } });
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('ada', 'ada@x.test', 'Ada', 'staff')`,
			params: []
		});
		const q = (reads: readonly WireRead[], who: Authority = rep) =>
			Effect.gen(function* () {
				const response = yield* route.handle(
					who,
					new Request('http://cell/__bolt/q', { method: 'POST', body: JSON.stringify({ reads }) })
				);
				const body = yield* Schema.decodeUnknownEffect(Schema.Union([QReply, WireError]))(
					yield* json(response)
				);
				return { status: response.status, body };
			});
		const id = (n: number) => {
			const value = ids[n];
			if (value === undefined) throw new Error('order id missing');
			return value;
		};
		return { t, q, id };
	});
const answers = (body: typeof QReply.Type | typeof WireError.Type) => {
	if ('error' in body) throw new Error(body.error.message);
	return body.answers;
};
const Titles = Schema.Array(Schema.Struct({ title: Schema.String }));

describe('/q page reads', () => {
	it.live('serves a collection query by name as the caller', () =>
		Effect.gen(function* () {
			const { q } = yield* setup();
			const r = yield* q([{ m: 'query', a: ['orders.titled', { prefix: 'al' }] }]);
			expect(r.status).toBe(200);
			expect(answers(r.body)).toEqual([['alder', 'alpha 2']]);
		})
	);

	it.live('a query with invalid input is a 400 naming the problem, not a 500', () =>
		Effect.gen(function* () {
			const { q } = yield* setup();
			const r = yield* q([{ m: 'query', a: ['orders.titled', {}] }]);
			expect(r.status).toBe(400);
			expect('error' in r.body ? r.body.error : undefined).toMatchObject({
				code: 'invalidInput',
				message: expect.stringContaining('prefix')
			});
		})
	);

	it.live(
		'serves an indexed query: probe through the index, rerank by the exact score, nearest first',
		() =>
			Effect.gen(function* () {
				const { q } = yield* setup();
				const missing = yield* q([
					{ m: 'query', a: ['orders', { search: { hue: {} }, limit: 1 }] }
				]);
				expect(missing.status).toBe(400);
				expect('error' in missing.body ? missing.body.error.message : undefined).toContain('r:');
				const malformed = yield* q([
					{
						m: 'query',
						a: ['orders', { search: { hue: { r: 0, window: { samples: [] } } }, limit: 1 }]
					}
				]);
				expect(malformed.status).toBe(400);
				expect('error' in malformed.body ? malformed.body.error.message : undefined).toContain(
					'samples'
				);
				const refused = yield* q([
					{
						m: 'query',
						a: ['orders', { search: { hue: { r: 0, window: { samples: [-1] } } }, limit: 1 }]
					}
				]);
				expect(refused.status).toBe(400);
				expect('error' in refused.body ? refused.body.error.message : undefined).toContain(
					'Probe samples cannot be negative.'
				);
				const r = yield* q([
					{
						m: 'query',
						a: [
							'orders',
							{
								search: { hue: { r: 0, window: { samples: [1] } } },
								limit: 1,
								select: { title: true }
							}
						]
					}
				]);
				expect(r.status, JSON.stringify(r.body)).toBe(200);
				// the index pages 2 candidates nearest r=0 (alpha 2, alder); the rerank keeps the one nearest 0.5
				expect(
					(yield* Schema.decodeUnknownEffect(
						Schema.Struct({ rows: Titles, next: Schema.NullOr(Schema.String) })
					)(answers(r.body)[0])).rows.map((x) => x.title)
				).toEqual(['alder']);
			})
	);

	it.live('answers a browser history with no `at` or a null `at`', () =>
		Effect.gen(function* () {
			const { q, id } = yield* setup();
			for (const a of [
				['orders', id(0)],
				['orders', id(0), null]
			]) {
				const r = yield* q([{ m: 'history', a }]);
				expect(r.status).toBe(200);
				expect(
					(yield* Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ revision: Schema.Number }))
					)(answers(r.body)[0])).map((x) => x.revision)
				).toEqual([1, 2]);
			}
		})
	);

	it.live(
		'a record query carries json, file and custom fields; a list read leaves them out (X-33)',
		() =>
			Effect.gen(function* () {
				const { q, id } = yield* setup();
				const r = yield* q([
					{ m: 'query', a: ['orders', { id: id(1) }] },
					{ m: 'query', a: ['orders', { where: { id: { eq: id(1) } }, limit: 1 }] }
				]);
				expect(r.status).toBe(200);
				expect(answers(r.body)[0]).toMatchObject({ title: 'alder', doc: { lines: ['alder'] } });
				expect(
					(yield* Schema.decodeUnknownEffect(Schema.Struct({ rows: Schema.Array(Schema.Json) }))(
						answers(r.body)[1]
					)).rows[0]
				).not.toHaveProperty('doc');
				// two record queries of one shape merge into one statement and keep the same projection
				const two = yield* q([
					{ m: 'query', a: ['orders', { id: id(1) }] },
					{ m: 'query', a: ['orders', { id: id(2) }] }
				]);
				expect(
					(yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ doc: Schema.Json })))(
						answers(two.body)
					)).map((x) => x.doc)
				).toEqual([{ lines: ['alder'] }, { lines: ['beta'] }]);
			})
	);

	it.live('text search matches a patterned seq', () =>
		Effect.gen(function* () {
			const { q } = yield* setup();
			const r = yield* q([
				{
					m: 'query',
					a: ['orders', { search: '0002', limit: 5, select: { title: true, code: true } }]
				}
			]);
			expect(r.status).toBe(200);
			expect(
				(yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						rows: Schema.Array(Schema.Struct({ title: Schema.String, code: Schema.String }))
					})
				)(answers(r.body)[0])).rows.map((x) => [x.code, x.title])
			).toEqual([['O-0002', 'alder']]);
		})
	);

	it.live('reads sys_user by its text id, filtered and by record query', () =>
		Effect.gen(function* () {
			const { t, q } = yield* setup();
			const admin = t.as(t.admin).authority;
			const r = yield* q(
				[
					{
						m: 'query',
						a: ['sys_user', { where: { id: { eq: 'ada' } }, limit: 1, select: { name: true } }]
					},
					{ m: 'query', a: ['sys_user', { id: 'ada' }] },
					{ m: 'query', a: ['sys_user', { where: { id: { in: ['ada', 'nobody'] } }, limit: 5 }] }
				],
				admin
			);
			expect(r.status).toBe(200);
			expect(
				(yield* Schema.decodeUnknownEffect(
					Schema.Struct({ rows: Schema.Array(Schema.Struct({ name: Schema.String })) })
				)(answers(r.body)[0])).rows.map((x) => x.name)
			).toEqual(['Ada']);
			expect(answers(r.body)[1]).toMatchObject({ id: 'ada', name: 'Ada' });
			expect(
				(yield* Schema.decodeUnknownEffect(Schema.Struct({ rows: Schema.Array(Schema.Json) }))(
					answers(r.body)[2]
				)).rows
			).toHaveLength(1);
		})
	);
});
