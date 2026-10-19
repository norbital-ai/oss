// P3 gaps: native semantic embeddings, the erase live lane, and caller-minted start ids.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Queue, Result, Schema, Stream } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Outcome } from '../src/engine/contracts.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { lowerRead } from '../src/engine/query/engine.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Live, Reads, Writes } from '../src/engine/services.ts';
import { ActReply, WireError } from '../src/protocol/schema.ts';
import { uuidv7, uuidv7Within, type Frame } from '../src/protocol/wire.ts';
import { respondSystem1, TestWorkspace, type Kit } from '../src/test/index.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			docs: {
				description: 'A doc',
				label: 'title',
				fields: { title: { kind: 'text' }, body: { kind: 'text', optional: true } },
				search: { text: ['title'], semantic: { fields: ['title'], model: 'small', dim: 3 } }
			}
		},
		relationships: {},
		collections: {
			docs: {
				read: { fields: 'all' },
				create: { input: { columns: ['title', 'body'] } },
				update: { input: { columns: ['title', 'body'] } }
			}
		},
		policies: {
			p: {
				description: 'P',
				grants: { docs: { read: true, create: true, update: true } },
				automations: ['tidy']
			}
		},
		automations: { tidy: { description: 'Tidy', runAs: ['p'] } },
		integrations: {},
		pipelines: {},
		teams: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
const created = (outcome: Outcome) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	return required(outcome.records[0]).id;
};
const sql = (t: Kit, text: string, ...params: string[]) =>
	t.db.rows(Schema.Record(Schema.String, Schema.Json), { text, params });
const embedded = (t: Kit, id: string) =>
	t.db.value(Schema.NullOr(Schema.String), {
		text: 'SELECT bolt_embedding::text AS e FROM docs WHERE id::text = $1',
		params: [id]
	});
const queued = (t: Kit) =>
	t.db.value(Schema.Number, {
		text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed' AND state = 'queued'`,
		params: []
	});
const Titles = Schema.Array(
	Schema.Struct({ title: Schema.String, $distance: Schema.optionalKey(Schema.Number) })
);
const setup = (embed?: Ai['Service']['embed']) =>
	Effect.gen(function* () {
		const ports =
			embed === undefined
				? {}
				: {
						ports: Layer.succeed(Ai, {
							ask: respondSystem1,
							maxChoices: undefined,
							models: ['default'],
							catalog: Port.unavailable('ai.catalog'),
							infer: () => Stream.fail(Port.failure('ai')(new Error('unused'))),
							embed
						})
					};
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, ...ports }));
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context),
			authority = t.as(t.admin).authority;
		const act = (callable: string, input: Json) =>
			actReply(route, authority, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		const read = (
			member: string,
			args: readonly Json[],
			bindings = { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }
		) =>
			Context.get(context, Reads)
				.run([lowerRead(manifest, member, args)], { as: 'workspace' }, bindings)
				.pipe(Effect.map((answers) => required(answers[0])));
		const run = Effect.gen(function* () {
			const handler = yield* embedRun.pipe(Effect.provide(context));
			return yield* handler({}, { id: crypto.randomUUID(), starter: null }).pipe(
				Effect.provide(context)
			);
		});
		return { context, t, route, act, read, run };
	});

describe('search.semantic embeddings (rule 16)', () => {
	it.live(
		'a create queues bolt.embed in its statement; the run embeds after commit; only a source-field change makes it stale again',
		() =>
			Effect.gen(function* () {
				const calls: string[][] = [];
				const embed: Ai['Service']['embed'] = (inputs, model) =>
					Schema.decodeUnknownEffect(Schema.Array(Schema.String))(inputs).pipe(
						Effect.mapError(Port.failure('embeddings')),
						Effect.map((texts) => {
							calls.push([model, ...texts]);
							return texts.map((text) => [text.length, 0, 1]);
						})
					);
				const { t, act, run } = yield* setup(embed);
				t.count.reset();
				const id = created(yield* act('docs.create', { title: 'desk', body: 'oak' }));
				expect(t.count.writes).toBe(1);
				expect(yield* queued(t)).toBe(1);
				expect(
					t.fakes.deadlines.announced.map(({ scope, at }) => ({ scope, at: Date.parse(at) })).at(-1)
				).toEqual({ scope: 'test', at: Date.parse(t.clock.now()) });
				expect(yield* run).toEqual({ embedded: 1 });
				expect(calls).toEqual([['small', 'desk']]);
				expect(yield* embedded(t, id)).toBe('[4,0,1]');
				yield* act('docs.update', { target: id, set: { body: 'pine' } });
				expect(yield* embedded(t, id)).toBe('[4,0,1]');
				expect(yield* queued(t)).toBe(1);
				yield* act('docs.update', { target: id, set: { title: 'chair' } });
				expect(yield* embedded(t, id)).toBeNull();
				expect(yield* queued(t)).toBe(2);
				expect(JSON.stringify(yield* sql(t, 'SELECT changes FROM bolt_history'))).not.toContain(
					'bolt_embedding'
				);
			})
	);

	it.live(
		'without an embeddings port the queued run fails unavailable and the vector stays missing',
		() =>
			Effect.gen(function* () {
				const { t, act } = yield* setup();
				const id = created(yield* act('docs.create', { title: 'desk' }));
				yield* t.runDue();
				expect(
					yield* sql(
						t,
						`SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'bolt.embed'`
					)
				).toEqual([{ state: 'failed', code: 'unavailable' }]);
				expect(yield* embedded(t, id)).toBeNull();
			})
	);
});

describe('semantic similarity over search.semantic (L-BOLT-123)', () => {
	it.live(
		'similar({ to: text | { record } }) ranks by the embedding; /semantic fuses it with the lexical hit',
		() =>
			Effect.gen(function* () {
				const near: { [text: string]: number[] } = {
					desk: [1, 0, 0],
					table: [1, 0, 0],
					chair: [0.9, 0.1, 0],
					lamp: [0, 0, 1]
				};
				const embed: Ai['Service']['embed'] = (inputs) =>
					Schema.decodeUnknownEffect(Schema.Array(Schema.String))(inputs).pipe(
						Effect.mapError(Port.failure('embeddings')),
						Effect.map((texts) => texts.map((text) => near[text] ?? [0, 1, 0]))
					);
				const { t, act, read, run } = yield* setup(embed);
				const desk = created(yield* act('docs.create', { title: 'desk' }));
				for (const title of ['chair', 'lamp']) yield* act('docs.create', { title });
				yield* run;
				const byText = yield* Schema.decodeUnknownEffect(Titles)(
					yield* read('similar', ['docs', { to: 'table', limit: 2 }])
				);
				expect(byText.map((row) => row.title)).toEqual(['desk', 'chair']);
				expect(typeof required(byText[0]).$distance).toBe('number');
				expect(
					(yield* Schema.decodeUnknownEffect(Titles)(
						yield* read('similar', ['docs', { to: { record: { id: desk } }, limit: 5 }])
					)).map((row) => row.title)
				).toEqual(['chair', 'lamp']);
				const hybrid = yield* Schema.decodeUnknownEffect(Schema.Struct({ rows: Titles }))(
					yield* read('read', ['docs', { search: '/semantic lamp', limit: 10 }])
				);
				expect(hybrid.rows.map((row) => row.title)[0]).toBe('lamp');
				expect(hybrid.rows).toHaveLength(3);
				expect(() => lowerRead(t.manifest, 'similar', ['docs', { to: '', limit: 1 }])).toThrow(
					/to: text/
				);
			})
	);

	it.live(
		'the run and the probe both ask for the declared width, and a host that ignores it fails here, not in pgvector',
		() =>
			Effect.gen(function* () {
				const asked: number[] = [];
				const embed: Ai['Service']['embed'] = (inputs, _model, dimensions) =>
					Effect.sync(() => {
						if (dimensions === undefined) throw new Error('embedding dimensions missing');
						asked.push(dimensions);
						return inputs.map(() =>
							Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0))
						);
					});
				const native: Ai['Service']['embed'] = (inputs) =>
					Effect.succeed(inputs.map(() => [1, 0, 0, 1]));
				const workspace = (port: Ai['Service']['embed']) =>
					Effect.gen(function* () {
						const fixture = yield* setup(port);
						yield* fixture.act('docs.create', { title: 'desk' });
						return fixture;
					});
				const probe = (fixture: Effect.Success<ReturnType<typeof workspace>>) =>
					fixture.read('similar', ['docs', { to: 'table', limit: 2 }], {
						now: '2026-01-01T00:00:00.000Z',
						today: '2026-01-01',
						tz: 'UTC',
						params: {}
					});
				const off = yield* workspace(native);
				expect((yield* off.run.pipe(Effect.flip)).message).toMatch(
					/'small' answered a 4-wide vector, not the 3 it was asked for/
				);
				expect(yield* probe(off).pipe(Effect.flip)).toMatchObject({
					code: 'badAnswer',
					phase: 'facility',
					message: 'The embedding width differs from its declared dimension.'
				});
				const fixture = yield* workspace(embed);
				yield* fixture.run;
				expect(
					required((yield* Schema.decodeUnknownEffect(Titles)(yield* probe(fixture)))[0]).title
				).toBe('desk');
				expect(asked).toEqual([3, 3]);
			})
	);
});

describe('erase and the live lane (rules 38e, 50, 66)', () => {
	it.live('an erase re-answers the views that showed the row and queues no triggered run', () =>
		Effect.gen(function* () {
			const { context, t, act } = yield* setup();
			const id = created(yield* act('docs.create', { title: 'desk' }));
			const admin = t.as(t.admin).authority,
				live = Context.get(context, Live),
				queue = yield* Queue.unbounded<Frame>();
			yield* live.connect(admin).pipe(
				Stream.runForEach((frame) => Queue.offer(queue, frame)),
				Effect.provide(context),
				Effect.forkScoped
			);
			const hello = yield* Queue.take(queue);
			if (hello.t !== 'hello') throw new Error('live connection did not begin with hello');
			yield* live
				.register(hello.conn, 'v', {
					read: lowerRead(manifest, 'read', ['docs', { all: true, select: { title: true } }])
				})
				.pipe(Effect.provide(context));
			expect(yield* Queue.take(queue)).toMatchObject({ t: 'answer', view: 'v' });
			const r = yield* Context.get(context, Writes)
				.act({
					collection: 'docs',
					verb: 'erase',
					input: { target: id },
					mode: { _tag: 'Direct' },
					key: 'e1',
					issuedAt: t.clock.now(),
					authority: admin,
					bindings: {
						now: t.clock.now(),
						today: t.clock.now().slice(0, 10),
						tz: 'UTC',
						params: {}
					},
					invocationId: 'e1'
				})
				.pipe(Effect.provide(context));
			expect(r.outcome.kind).toBe('committed');
			yield* live.settled.pipe(Effect.provide(context));
			expect(yield* Queue.take(queue)).toEqual({
				t: 'patch',
				view: 'v',
				v: r.v,
				ops: [{ op: 'remove', id }]
			});
		})
	);
});

describe('start over /__bolt/act (rules 24, 31)', () => {
	it.live(
		'takes a uuidv7 minted within 24 h; a v4 or a stale id is invalidInput; a resend is the same run',
		() =>
			Effect.gen(function* () {
				const { t, route } = yield* setup();
				const rep = t.as(t.member(['p'])).authority;
				const start = (id: string) =>
					Effect.gen(function* () {
						const response = yield* route.handle(
							rep,
							new Request('http://cell/__bolt/act', {
								method: 'POST',
								headers: { 'Idempotency-Key': id },
								body: JSON.stringify({
									callable: 'start',
									input: { automation: 'tidy', input: {}, id },
									issuedAt: t.clock.now()
								})
							})
						);
						return {
							status: response.status,
							reply: yield* Schema.decodeUnknownEffect(Schema.Union([ActReply, WireError]))(
								yield* json(response)
							)
						};
					});
				const now = Date.parse(t.clock.now()),
					id = uuidv7(now);
				expect(uuidv7Within(id, now)).toBe(true);
				expect(uuidv7Within(uuidv7(now - 25 * 3_600_000), now)).toBe(false);
				expect(yield* start(crypto.randomUUID())).toMatchObject({
					status: 400,
					reply: { outcome: { code: 'invalidInput', field: 'id' } }
				});
				expect(yield* start(uuidv7(now - 25 * 3_600_000))).toMatchObject({ status: 400 });
				expect(yield* start(id)).toMatchObject({
					status: 200,
					reply: { outcome: { kind: 'committed', output: { id, automation: 'tidy', ids: [id] } } }
				});
				expect(yield* start(id)).toMatchObject({ status: 200 });
				expect(
					yield* sql(t, `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'tidy'`)
				).toEqual([{ n: 1 }]);
			})
	);
});
