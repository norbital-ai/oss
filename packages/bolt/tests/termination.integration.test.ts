// P38 on PGlite: every run ends (rule 12: a loop on a cheap facility call ends `crossingBudget`), a drain interrupts
// what it waits on (rule 71a: aborting the generation disposes a guest stuck on a facility that never answers, and the
// run is re-queued as a lost lease), and engine loops prove progress (rule 25a: `bolt.embed` stops `noProgress` when its
// guarded write stores 0 rows; a revision guard writes a row whose `updated_at` has microseconds). Plus the source gate:
// no optimistic guard compares a `*_at` column with a value bound from JS.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Result,
	Schema,
	Scope,
	Stream
} from 'effect';
import { Ai, WebRead } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Runs } from '../src/engine/services.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { TestWorkspace, type Kit } from '../src/test/index.ts';
import { loadPack } from '../src/engine/write/pack.ts';
import { randomUUID } from 'node:crypto';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			docs: {
				description: 'A doc',
				label: 'title',
				fields: { title: { kind: 'text' } },
				search: { text: ['title'], semantic: { fields: ['title'], model: 'small', dim: 3 } }
			}
		},
		relationships: {},
		collections: { docs: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } } },
		policies: {
			p: {
				description: 'P',
				grants: { docs: { read: true, create: true } },
				automations: ['loop', 'hang', 'pair', 'relay']
			}
		},
		automations: {
			loop: { description: 'Reads forever', runAs: ['p'] },
			hang: { description: 'Waits on a call nobody answers', runAs: ['p'] },
			pair: { description: 'Two reads at once', runAs: ['p'] },
			relay: { description: 'A fast branch beside a slow one', runAs: ['p'] }
		},
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
const guest = program(`import { Effect } from 'effect'; export default { automation: {
	loop: { body: function* (_, ctx) { for (;;) yield* ctx.web.read('https://a.test'); } },
	hang: { body: function* (_, ctx) { yield* ctx.web.read('https://never.test'); return 'unreachable'; } },
	pair: { body: function* (_, ctx) { yield* Effect.all([ctx.web.read('https://a.test'), ctx.web.read('https://b.test')], { concurrency: 'unbounded' }); } },
	relay: { body: function* (_, ctx) { yield* Effect.all([ctx.web.read('https://slow.test'), Effect.gen(function* () { yield* ctx.web.read('https://fast.test'); yield* ctx.web.read('https://next.test'); })], { concurrency: 'unbounded' }); } },
} };`);
const sql = (t: Pick<Kit, 'db'>, text: string) =>
	t.db.rows(Schema.Record(Schema.String, Schema.Json), { text, params: [] });
const queue = (
	automation: string
) => `INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
	VALUES (gen_random_uuid()::text, '${automation}', '{}'::jsonb, '2000-01-01T00:00:00Z', 'start', 0)`;
const page = (url: string) => ({ url, title: null, text: '' });
const aiLayer = (embed: Ai['Service']['embed']) =>
	Layer.succeed(Ai, {
		ask: () => Port.unavailable('ai'),
		maxChoices: undefined,
		models: [],
		catalog: Port.unavailable('ai'),
		infer: () => Stream.fail(Port.failure('ai')(new Error('unused'))),
		embed
	});

describe('P38: every run ends, drains interrupt, loops prove progress', () => {
	it.live(
		'a run looping on a cheap facility call ends with crossingBudget at its 10,001st call (rule 12)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let calls = 0;
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* guest,
							ports: Layer.succeed(WebRead, {
								read: (url) => Effect.sync(() => (calls++, page(url)))
							})
						})
					);
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({ text: queue('loop'), params: [] });
					yield* t.runDue();
					expect(
						yield* sql(
							t,
							`SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'loop'`
						)
					).toEqual([{ state: 'failed', code: 'crossingBudget' }]);
					expect(calls).toBe(10_000);
				})
			),
		60_000
	);

	it.live(
		'a seed pack loaded into a semantic collection queues the embed pass (a pack writes past the acts that would)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const t = Context.get(
						yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest })),
						TestWorkspace
					);
					expect(
						yield* loadPack(
							t.db,
							manifest,
							{
								dir: '',
								meta: {
									format: 1,
									name: 'base',
									hash: 'semantic',
									start: [],
									assets: [],
									rows: { docs: 1 }
								},
								rows: { docs: [{ id: randomUUID(), title: 'seeded' }] }
							},
							'2026-09-27T00:00:00.000Z'
						)
					).toBe(true);
					expect(
						yield* sql(t, `SELECT automation, state FROM sys_run WHERE automation = 'bolt.embed'`)
					).toEqual([{ automation: 'bolt.embed', state: 'queued' }]);
				})
			)
	);

	it.live(
		'facility calls a body issues together run together at the host, not one after the other',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let inflight = 0,
						peak = 0;
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* guest,
							ports: Layer.succeed(WebRead, {
								read: (url) =>
									Effect.gen(function* () {
										peak = Math.max(peak, ++inflight);
										yield* Effect.sleep(20);
										inflight--;
										return page(url);
									})
							})
						})
					);
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({ text: queue('pair'), params: [] });
					yield* t.runDue();
					expect(yield* sql(t, `SELECT state FROM sys_run WHERE automation = 'pair'`)).toEqual([
						{ state: 'succeeded' }
					]);
					expect(peak).toBe(2);
				})
			)
	);

	it.live(
		'a branch whose call answered goes on while a sibling still waits: batches land as they finish, not in lockstep',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const next = yield* Deferred.make<void>();
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* guest,
							ports: Layer.succeed(WebRead, {
								read: (url) =>
									Effect.gen(function* () {
										if (url.includes('slow')) yield* Deferred.await(next);
										if (url.includes('next')) yield* Deferred.succeed(next, undefined);
										return page(url);
									})
							})
						})
					);
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({ text: queue('relay'), params: [] });
					yield* t.runDue();
					expect(yield* sql(t, `SELECT state FROM sys_run WHERE automation = 'relay'`)).toEqual([
						{ state: 'succeeded' }
					]);
				})
			)
	);

	it.live(
		'aborting the generation interrupts a guest stuck on a facility that never answers; the run is re-queued (rule 71a)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const dbContext = yield* Layer.build(PgliteDb.layer()),
						generation = yield* Effect.acquireRelease(Scope.make(), (scope) =>
							Scope.close(scope, Exit.void)
						);
					const startedCall = yield* Deferred.make<void>();
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* guest,
							db: Layer.succeedContext(dbContext),
							ports: Layer.succeed(WebRead, {
								read: () =>
									Deferred.succeed(startedCall, undefined).pipe(Effect.andThen(Effect.never))
							})
						})
					).pipe(Scope.provide(generation));
					const t = Context.get(context, TestWorkspace),
						runs = Context.get(context, Runs);
					yield* t.db.write({ text: queue('hang'), params: [] });
					yield* Effect.forkIn(runs.tick.pipe(Effect.provide(context)), generation);
					yield* Deferred.await(startedCall);
					const started = yield* Clock.currentTimeMillis;
					yield* Scope.close(generation, Exit.void);
					expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
					expect(yield* sql(t, `SELECT state, error->>'code' AS code FROM sys_run`)).toEqual([
						{ state: 'running', code: 'interrupted' }
					]);
					yield* runs.boot.pipe(Effect.provide(context));
					expect(yield* sql(t, `SELECT state, leases FROM sys_run`)).toEqual([
						{ state: 'queued', leases: 1 }
					]);
				})
			)
	);

	it.live(
		'a host call that ignores its signal still ends at its wall; the run does not hang (rule 72)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let signal: AbortSignal | undefined;
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* guest,
							ports: Layer.succeed(WebRead, {
								read: () =>
									Effect.tryPromise({
										try: (current) => {
											signal = current;
											return new Promise<ReturnType<typeof page>>(() => {});
										},
										catch: Port.failure('web')
									})
							})
						})
					);
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({ text: queue('hang'), params: [] });
					const started = yield* Clock.currentTimeMillis;
					yield* t.runDue();
					expect((yield* Clock.currentTimeMillis) - started).toBeGreaterThanOrEqual(
						LIMITS.callMs.web
					);
					expect(
						yield* sql(t, `SELECT state, error FROM sys_run WHERE automation = 'hang'`)
					).toEqual([
						{
							state: 'failed',
							error: {
								code: 'guestError',
								message: `web.read did not answer within ${LIMITS.callMs.web} ms`
							}
						}
					]);
					expect(signal?.aborted).toBe(true);
				})
			),
		30_000
	);

	it.live(
		'bolt.embed stops noProgress after one pass whose guarded write stores 0 rows, and queues nothing (rule 25a)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(TestWorkspace.layer({ manifest })),
						t = Context.get(context, TestWorkspace),
						route = yield* routeFixture(context);
					yield* actReply(route, t.as(t.admin).authority, {
						callable: 'docs.create',
						input: { title: 'desk' },
						issuedAt: t.clock.now()
					});
					const before = yield* sql(
						t,
						`SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed'`
					);
					let passes = 0;
					const port = aiLayer((texts) =>
						Effect.gen(function* () {
							passes++;
							yield* t.db.write({ text: 'UPDATE docs SET revision = revision + 1', params: [] });
							return texts.map(() => [1, 0, 0]);
						}).pipe(Effect.mapError(Port.failure('ai')))
					);
					const ai = Context.get(yield* Layer.build(port), Ai),
						run = yield* embedRun.pipe(Effect.provideService(Ai, ai), Effect.provide(context));
					expect(
						yield* Effect.flip(
							run({}, { id: randomUUID(), starter: null }).pipe(Effect.provide(context))
						)
					).toMatchObject({ code: 'noProgress', phase: 'commit' });
					expect(passes).toBe(1);
					expect(
						yield* sql(t, `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed'`)
					).toEqual(before);
				})
			)
	);

	it.live(
		'a revision guard writes a row whose updated_at has microseconds exactly once (rule 25a)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(TestWorkspace.layer({ manifest })),
						t = Context.get(context, TestWorkspace),
						route = yield* routeFixture(context);
					yield* actReply(route, t.as(t.admin).authority, {
						callable: 'docs.create',
						input: { title: 'desk' },
						issuedAt: t.clock.now()
					});
					yield* t.db.write({
						text: `UPDATE docs SET updated_at = '2026-09-25T10:00:00.123456Z'`,
						params: []
					});
					const ai = Context.get(
							yield* Layer.build(aiLayer((texts) => Effect.succeed(texts.map(() => [1, 0, 0])))),
							Ai
						),
						run = yield* embedRun.pipe(Effect.provideService(Ai, ai), Effect.provide(context));
					expect(
						yield* run({}, { id: randomUUID(), starter: null }).pipe(Effect.provide(context))
					).toEqual({ embedded: 1 });
					expect(
						yield* run({}, { id: randomUUID(), starter: null }).pipe(Effect.provide(context))
					).toEqual({ embedded: 0 });
				})
			)
	);

	it('no optimistic guard in the engine compares a *_at column with a value bound from JS (rule 25a)', () => {
		const roots = ['../src', '../../bolt-server/src', '../../ui/src'].map((r) =>
			join(import.meta.dirname, r)
		);
		const files = (dir: string): string[] =>
			readdirSync(dir).flatMap((f) =>
				statSync(join(dir, f)).isDirectory()
					? files(join(dir, f))
					: /\.(ts|svelte)$/.test(f)
						? [join(dir, f)]
						: []
			);
		// `WHERE|AND|OR <col>_at = | IS NOT DISTINCT FROM <$n | ${…} | v.x>`: compare `revision`, or both sides `::text`
		const guard =
			/\b(?:WHERE|AND|OR)\s+[\w."]*_at"?\s*(?:=|IS NOT DISTINCT FROM)\s*(?:\$\d|\$\{|[a-z]\.)/i;
		const hits = roots.flatMap(files).flatMap((f) =>
			readFileSync(f, 'utf8')
				.split('\n')
				.flatMap((line, i) => (guard.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []))
		);
		expect(hits).toEqual([]);
	});
});
