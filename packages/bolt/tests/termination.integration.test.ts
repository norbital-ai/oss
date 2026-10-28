// P38 on PGlite: every run ends (a host call that ignores its signal ends at its wall, rule 72), a drain interrupts
// what it waits on (rule 71a: aborting the generation disposes a guest stuck on a facility that never answers, and the
// run is re-queued as a lost lease), and engine loops prove progress (rule 25a: `bolt.embed` stops `noProgress` when its
// guarded write stores 0 rows; a revision guard writes a row whose `updated_at` has microseconds). The crossing budget
// itself is guest.test's.
import { describe, expect, it, layer } from '@effect/vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Result,
	Schema,
	Scope,
	Stream
} from 'effect';
import { TestClock } from 'effect/testing';
import { Ai, WebRead } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Runs } from '../src/engine/services.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { program } from '../src/test/guest.ts';
import { TestDb } from '../src/test/database.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { TestWorkspace, type Kit } from '../src/test/index.ts';
import { loadPack, sourceOf } from '../src/engine/write/pack.ts';
import { randomUUID } from 'node:crypto';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
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
		exposures: {
			docs: { read: { docs: { fields: 'all' } }, create: { columns: { docs: ['title'] } } }
		},
		policies: {
			p: {
				description: 'P',
				grants: { docs: { read: true, create: true } },
				automations: ['hang', 'pair', 'relay']
			}
		},
		automations: {
			hang: { description: 'Waits on a call nobody answers', runAs: ['p'] },
			pair: { description: 'Two reads at once', runAs: ['p'] },
			relay: { description: 'A fast branch beside a slow one', runAs: ['p'] }
		},
		integrations: {},
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
const ai = (embed: Ai['Service']['embed']): Ai['Service'] => ({
	ask: () => Port.unavailable('ai'),
	maxChoices: undefined,
	models: [],
	catalog: Port.unavailable('ai'),
	infer: () => Stream.fail(Port.failure('ai')(new Error('unused'))),
	embed
});

// One workspace for the runs whose read port answers by URL: each test arms what its reads wait on. The seed case
// precedes the embed case, which clears the docs it leaves.
let inflight = 0,
	peak = 0,
	both: Deferred.Deferred<void> | undefined,
	next: Deferred.Deferred<void> | undefined;
const shared = Layer.unwrap(
	Effect.map(guest, (program) =>
		TestWorkspace.layer({
			manifest,
			guest: program,
			ports: Layer.succeed(WebRead, {
				read: (url) =>
					Effect.gen(function* () {
						if (both !== undefined && (url.includes('a.test') || url.includes('b.test'))) {
							// each read waits until both are in flight: one after the other never gets there
							peak = Math.max(peak, ++inflight);
							if (inflight === 2) yield* Deferred.succeed(both, undefined);
							yield* Deferred.await(both);
							inflight--;
						}
						if (next !== undefined && url.includes('slow')) yield* Deferred.await(next);
						if (next !== undefined && url.includes('next')) yield* Deferred.succeed(next, undefined);
						return page(url);
					})
			})
		})
	)
);

layer(shared, { excludeTestServices: true })('P38: facility calls in a body', (it) => {
	it.effect('calls a body issues together run together at the host, not one after the other', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			both = yield* Deferred.make<void>();
			yield* t.db.write({ text: queue('pair'), params: [] });
			yield* t.runDue();
			expect(yield* sql(t, `SELECT state FROM sys_run WHERE automation = 'pair'`)).toEqual([
				{ state: 'succeeded' }
			]);
			expect(peak).toBe(2);
		})
	);

	it.effect(
		'a branch whose call answered goes on while a sibling still waits: batches land as they finish',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				next = yield* Deferred.make<void>();
				yield* t.db.write({ text: queue('relay'), params: [] });
				yield* t.runDue();
				expect(yield* sql(t, `SELECT state FROM sys_run WHERE automation = 'relay'`)).toEqual([
					{ state: 'succeeded' }
				]);
			})
	);

	it.effect('a seed pack loaded into a semantic model queues the embed pass', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			expect(
				yield* loadPack(
					t.db,
					manifest,
					sourceOf({
						dir: '',
						meta: { format: 1, name: 'base', hash: 'semantic', start: [], assets: [], rows: { docs: 1 } },
						rows: { docs: [{ id: randomUUID(), title: 'seeded' }] }
					}),
					'2026-09-27T00:00:00.000Z'
				)
			).toBe(true);
			expect(
				yield* sql(t, `SELECT automation, state FROM sys_run WHERE automation = 'bolt.embed'`)
			).toEqual([{ automation: 'bolt.embed', state: 'queued' }]);
		})
	);

	it.effect(
		'bolt.embed stops noProgress on a pass whose guarded write stores 0 rows; a microsecond updated_at embeds once (rule 25a)',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				yield* t.db.write({ text: 'DELETE FROM docs', params: [] });
				yield* t.db.write({ text: `INSERT INTO docs (id, title) VALUES ('${randomUUID()}', 'desk')`, params: [] });
				const queued = `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed'`;
				const before = yield* sql(t, queued);
				let passes = 0;
				const raced = yield* embedRun.pipe(
					Effect.provideService(
						Ai,
						ai((texts) =>
							Effect.gen(function* () {
								passes++;
								yield* t.db.write({ text: 'UPDATE docs SET revision = revision + 1', params: [] });
								return texts.map(() => [1, 0, 0]);
							}).pipe(Effect.mapError(Port.failure('ai')))
						)
					)
				);
				expect(yield* Effect.flip(raced({}, { id: randomUUID(), starter: null }))).toMatchObject({
					code: 'noProgress',
					phase: 'commit'
				});
				expect(passes).toBe(1);
				expect(yield* sql(t, queued)).toEqual(before);
				yield* t.db.write({
					text: `UPDATE docs SET updated_at = '2026-09-25T10:00:00.123456Z'`,
					params: []
				});
				const run = yield* embedRun.pipe(
					Effect.provideService(
						Ai,
						ai((texts) => Effect.succeed(texts.map(() => [1, 0, 0])))
					)
				);
				expect(yield* run({}, { id: randomUUID(), starter: null })).toEqual({ embedded: 1 });
				expect(yield* run({}, { id: randomUUID(), starter: null })).toEqual({ embedded: 0 });
			})
	);
});

describe('P38: every run ends, drains interrupt, loops prove progress', () => {
	it.effect('a host call that ignores its signal still ends at its wall (rule 72)', () =>
		Effect.gen(function* () {
			let signal: AbortSignal | undefined;
			const call = yield* Effect.forkChild(
				Port.attempt('web.read', (current) => {
					signal = current;
					return new Promise<never>(() => {});
				}).pipe(Port.call('web.read', LIMITS.callMs.other), Effect.flip)
			);
			yield* TestClock.adjust(LIMITS.callMs.other);
			expect(yield* Fiber.join(call)).toEqual(
				new FacilityFailure({
					kind: 'timeout',
					message: `web.read did not answer within ${LIMITS.callMs.other} ms`
				})
			);
			expect(signal?.aborted).toBe(true);
		})
	);

	it.live(
		'aborting the generation interrupts a guest stuck on a facility that never answers; the run is re-queued (rule 71a)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const dbContext = yield* Layer.build(TestDb.layer(manifest)),
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

});
