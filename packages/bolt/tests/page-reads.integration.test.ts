// The unified page query wire: read requests, index search, record/list projections and text ids; history stays explicit.
import { expect, layer } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority } from '../src/engine/contracts.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { QReply, WireError } from '../src/protocol/schema.ts';
import { act_reply, json, route_fixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import type { WireRead } from '../src/protocol/wire.ts';
import { TestWorkspace, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			orders: {
				description: 'An order',
				record_label: 'record.title',
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
		exposures: {
			orders: {
				outputs: {
					default: { orders: { fields: 'all' } },
					summary: { orders: { fields: ['title'] } }
				},
				create: { columns: { orders: ['title', 'doc', 'color'] } },
				update: { columns: { orders: ['title'] } }
			}
		},
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				grants: {
					orders: { outputs: { default: { history: true } }, create: true, update: true }
				}
			},
			reader: {
				description: 'Current rows',
				grants: { orders: { outputs: { default: true } } }
			},
			historian: {
				description: 'History of alpha orders',
				grants: {
					orders: {
						outputs: {
							default: { history: true, scopes: { orders: { title: { like: 'alpha%' } } } }
						}
					}
				}
			},
			named_historian: {
				description: 'History through the summary output',
				grants: { orders: { outputs: { summary: { history: true } } } }
			}
		},
		teams: {},
		automations: {},
		mcp: {},
		custom_fields: {
			probe_window: {
				description: 'A synthetic probe window',
				shape: {
					kind: 'object',
					fields: { samples: { kind: 'number', many: true, min_items: 1, max_items: 2 } }
				},
				check: true
			}
		},
		agent: { skills: {} },
		apps: {}
	})
);

const guest =
	program(`export default { custom_field: { probe_window: { check: (window) => window.samples.some((value) => value < 0) ? 'Probe samples cannot be negative.' : undefined } }, model: { orders: { bodies: {
	indexes: { hue: {
		probe: (q) => ({ vector: [q.r.to_number(), 0, 0] }),
		// the exact score: nearest to 0.5 on the first channel, whatever the probe
		rerank: (q, row) => Math.abs(row.color[0] - (0.5 + q.r.to_number())),
	} },
} } } };`);

// every test reads the same rows: seeded once per file
const ids: string[] = [];
const fixture = () =>
	Effect.gen(function* () {
		const context = yield* Effect.context<TestWorkspace | WorkspaceServices>();
		const t = Context.get(context, TestWorkspace),
			route = yield* route_fixture(context);
		const rep = (yield* t.as(t.member(['rep']))).authority;
		const act = (callable: string, input: Json) =>
			act_reply(route, rep, { acts: { [callable]: input }, issued_at: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
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
		return { t, act, q, id };
	});
const seeded = Layer.effectDiscard(
	Effect.scoped(
		Effect.gen(function* () {
			const { t, act } = yield* fixture();
			for (const [title, r] of [
				['alpha', 0.1],
				['alder', 0.45],
				['beta', 0.9],
				['bravo', 0.6]
			] as const) {
				const o = yield* act('orders.create', [
					{ title, doc: { lines: [title] }, color: [r, 0, 0] }
				]);
				if (o.kind !== 'committed' || o.records[0] === undefined)
					throw new Error(JSON.stringify(o));
				ids.push(o.records[0].id);
			}
			const first = ids[0];
			if (first === undefined) throw new Error('first order missing');
			yield* act('orders.update', [{ target: { id: first, revision: 1 }, set: { title: 'alpha 2' } }]);
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('ada', 'ada@x.test', 'Ada', 'staff')`,
				params: []
			});
		})
	)
).pipe(
	Layer.provideMerge(
		Layer.unwrap(Effect.map(guest, (guest) => TestWorkspace.layer({ manifest, guest })))
	)
);
const setup = fixture;
const answers = (body: typeof QReply.Type | typeof WireError.Type) => {
	if ('error' in body) throw new Error(body.error.message);
	return body.answers;
};
const Titles = Schema.Array(Schema.Struct({ title: Schema.String }));

layer(seeded, { excludeTestServices: true })('/q page reads', (it) => {
	it.effect(
		'serves a read request as the caller; the page derives what a declared query computed',
		() =>
			Effect.gen(function* () {
				const { q } = yield* setup();
				const r = yield* q([
					{ m: 'query', a: [{ orders: { fields: ['title'], order_by: 'title' } }] }
				]);
				expect(r.status).toBe(200);
				const [answer] = answers(r.body);
				const { orders } = Schema.decodeUnknownSync(
					Schema.Struct({ orders: Schema.Struct({ rows: Titles, next: Schema.Null }) })
				)(answer);
				// a pure helper on the page's side (a former `orders.titled`)
				expect(orders.rows.map((o) => o.title).filter((t) => t.startsWith('al'))).toEqual([
					'alder',
					'alpha 2'
				]);
			})
	);

	it.effect('a read request with an unknown option is a 400 naming it, not a 500', () =>
		Effect.gen(function* () {
			const { q } = yield* setup();
			const r = yield* q([{ m: 'query', a: [{ orders: { prefix: 'al' } }] }]);
			expect(r.status).toBe(400);
			expect('error' in r.body ? r.body.error.message : undefined).toContain('prefix');
		})
	);

	it.effect(
		'serves an indexed search: probe through the index, rerank by the exact score, nearest first',
		() =>
			Effect.gen(function* () {
				const { q } = yield* setup();
				const search = (hue: Json, fields?: readonly string[]) =>
					q([
						{
							m: 'query',
							a: [
								{
									orders: {
										search: { hue },
										limit: 1,
										...(fields === undefined ? {} : { fields: [...fields] })
									}
								}
							]
						}
					]);
				const missing = yield* search({});
				expect(missing.status).toBe(400);
				expect('error' in missing.body ? missing.body.error.message : undefined).toContain('r:');
				const malformed = yield* search({ r: 0, window: { samples: [] } });
				expect(malformed.status).toBe(400);
				expect('error' in malformed.body ? malformed.body.error.message : undefined).toContain(
					'samples'
				);
				const refused = yield* search({ r: 0, window: { samples: [-1] } });
				expect(refused.status).toBe(400);
				expect('error' in refused.body ? refused.body.error.message : undefined).toContain(
					'Probe samples cannot be negative.'
				);
				const r = yield* search({ r: 0, window: { samples: [1] } }, ['title']);
				expect(r.status, JSON.stringify(r.body)).toBe(200);
				// the index pages 2 candidates nearest r=0 (alpha 2, alder); the rerank keeps the one nearest 0.5
				expect(
					(yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							orders: Schema.Struct({ rows: Titles, next: Schema.NullOr(Schema.String) })
						})
					)(answers(r.body)[0])).orders.rows.map((x) => x.title)
				).toEqual(['alder']);
			})
	);

	it.effect('answers browser history without a point or with declared options', () =>
		Effect.gen(function* () {
			const { q, id } = yield* setup();
			for (const a of [
				['orders', id(0)],
				['orders', id(0), {}]
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

	it.effect('refuses retired history points outside the tagged options object', () =>
		Effect.gen(function* () {
			const { q, id } = yield* setup();
			const retired: readonly Json[] = [null, 1, { revision: 1 }, { at: 1 }, { at: '2026-01-01T00:00:00Z' }];
			for (const options of retired) {
				const reply = yield* q([{ m: 'history', a: ['orders', id(0), options] }]);
				expect(reply.status).toBe(400);
			}
			const revision = yield* q([{ m: 'history', a: ['orders', id(0), { at: { revision: 1 } }] }]);
			expect(revision.status).toBe(200);
			expect(Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ revision: Schema.Number })))(answers(revision.body)[0]).map((row) => row.revision)).toEqual([1]);
		})
	);

	it.effect('history stays inside the output grant even beside a broader current-row grant', () =>
		Effect.gen(function* () {
			const { t, q, id } = yield* setup();
			const reader = (yield* t.as(t.member(['reader']))).authority;
			const combined = (yield* t.as(t.member(['reader', 'historian']))).authority;
			const named = (yield* t.as(t.member(['reader', 'named_historian']))).authority;
			const revisionRows = Schema.Array(Schema.Struct({ revision: Schema.Number }));
			const history = (index: number, authority: Authority) =>
				q([{ m: 'history', a: ['orders', id(index)] }], authority).pipe(
					Effect.map((reply) => Schema.decodeUnknownSync(revisionRows)(answers(reply.body)[0]))
				);
			expect(yield* history(0, reader)).toEqual([]);
			expect((yield* history(0, combined)).map((row) => row.revision)).toEqual([1, 2]);
			expect(yield* history(2, combined)).toEqual([]);
			expect(yield* history(0, named)).toEqual([]);
			const summary = yield* q(
				[{ m: 'history', a: ['orders', id(0), { output: 'summary' }] }],
				named
			);
			expect(Schema.decodeUnknownSync(revisionRows)(answers(summary.body)[0])).toHaveLength(2);
		})
	);

	it.effect(
		'named heavy fields carry json, as a read naming no fields does; several requests share one /q',
		() =>
			Effect.gen(function* () {
				const { q, id } = yield* setup();
				const one = (n: number, fields?: readonly string[]): WireRead => ({
					m: 'query',
					a: [
						{
							orders: {
								where: { id: { eq: id(n) } },
								...(fields === undefined ? {} : { fields: [...fields] })
							}
						}
					]
				});
				const Rows = Schema.Struct({ orders: Schema.Struct({ rows: Schema.Array(Schema.Json) }) });
				const r = yield* q([one(1, ['title', 'doc']), one(1)]);
				expect(r.status).toBe(200);
				const [named, plain] = answers(r.body);
				expect((yield* Schema.decodeUnknownEffect(Rows)(named)).orders.rows[0]).toMatchObject({
					title: 'alder',
					doc: { lines: ['alder'] }
				});
				// no fields reads every field the layer exposes, heavy ones included (decision 8)
				expect((yield* Schema.decodeUnknownEffect(Rows)(plain)).orders.rows[0]).toMatchObject({
					title: 'alder',
					doc: { lines: ['alder'] }
				});
				// a model is one root per request: two records of one shape are two requests in one crossing
				const two = yield* q([one(1, ['doc']), one(2, ['doc'])]);
				expect(
					(yield* Schema.decodeUnknownEffect(
						Schema.Array(
							Schema.Struct({
								orders: Schema.Struct({ rows: Schema.Array(Schema.Struct({ doc: Schema.Json })) })
							})
						)
					)(answers(two.body))).map((x) => x.orders.rows[0]?.doc)
				).toEqual([{ lines: ['alder'] }, { lines: ['beta'] }]);
			})
	);

	it.effect('text search matches a patterned seq', () =>
		Effect.gen(function* () {
			const { q } = yield* setup();
			const r = yield* q([
				{ m: 'query', a: [{ orders: { search: '0002', limit: 5, fields: ['title', 'code'] } }] }
			]);
			expect(r.status).toBe(200);
			expect(
				(yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						orders: Schema.Struct({
							rows: Schema.Array(Schema.Struct({ title: Schema.String, code: Schema.String }))
						})
					})
				)(answers(r.body)[0])).orders.rows.map((x) => [x.code, x.title])
			).toEqual([['O-0002', 'alder']]);
		})
	);

	it.effect('reads sys_user by its text id, one and several', () =>
		Effect.gen(function* () {
			const { t, q } = yield* setup();
			const admin = (yield* t.as(t.admin)).authority;
			const r = yield* q(
				[
					{ m: 'query', a: [{ sys_user: { where: { id: { eq: 'ada' } }, fields: ['name'] } }] },
					{ m: 'query', a: [{ sys_user: { where: { id: { in: ['ada', 'nobody'] } }, limit: 5 } }] }
				],
				admin
			);
			expect(r.status).toBe(200);
			const Users = Schema.Struct({
				sys_user: Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
			});
			const [one, several] = answers(r.body);
			expect((yield* Schema.decodeUnknownEffect(Users)(one)).sys_user.rows).toEqual([
				expect.objectContaining({ id: 'ada', name: 'Ada' })
			]);
			expect((yield* Schema.decodeUnknownEffect(Users)(several)).sys_user.rows).toHaveLength(1);
		})
	);
});
