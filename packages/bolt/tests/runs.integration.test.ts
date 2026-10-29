// The runs area on PGlite (rules 48–56a, 70): the one queue, the deadlines port, buckets, model effects written in the
// causing statement and run as its writer, re-queues, attempts, webhooks, visibility, restart recovery (a dropped run reruns from the start).
// One engine per mechanism group; each test's phases share it. Crons: runs-fire. Observed revisions: callables.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from '@effect/vitest';
import {
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Predicate,
	Result,
	Schema,
	Scope
} from 'effect';
import { TestClock } from 'effect/testing';
import type { Json } from '../src/decl/values.ts';
import type { Holder } from '../src/engine/access/authority.ts';
import type { Invocation, Rows, Outcome as WriteOutcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { type EngineError } from '../src/engine/errors.ts';
import { BoltError, CODES } from '../src/protocol/errors.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { EngineLive, type EngineHost, type EngineServices } from '../src/engine/host.ts';
import { bareHost } from './effect-engine.ts';
import {
	Callables,
	Guest,
	Identity,
	RunHandlers,
	Runs,
	Writes,
	type CrossCall,
	type GuestShape,
	type IdentityShape,
	type RunHandler,
	type RunsShape,
	type WritesShape
} from '../src/engine/services.ts';
import { DeadlinePort, Keys } from '../src/engine/ports.ts';
import { keysPort } from '../src/node/keys.ts';
import { Secrets, type SecretsShape } from '../src/engine/secrets.ts';
import { RunsLive } from '../src/engine/runs/index.ts';
import { parseCallable } from '../src/engine/callables/index.ts';
import { Outcome } from '../src/protocol/schema.ts';
import { canonical } from '@norbital-ai/store';
import type { Verb } from '../src/engine/write/act.ts';
const base: EngineManifest = {
	needs: [],
	workspace: {
		tz: 'UTC',
		locale: 'en',
		secrets: { HOOK: { label: 'Webhook bearer' } }
	},
	models: {
		quotes: {
			description: 'A quote',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' }
			}
		}
	},
	relationships: {},
	exposures: {
		quotes: {
			read: { quotes: { fields: 'all' } },
			outputs: { titles: { quotes: { fields: ['title'] } } },
			create: { columns: { quotes: ['title', 'status'] } },
			update: { columns: { quotes: ['title', 'status'] } },
			delete: {},
			effect: { created: true, updated: true, deleted: true }
		}
	},
	integrations: {},
	teams: { ops: ['ops'], branch: { parent: 'ops', policies: [] }, nobody: [] },
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	policies: {
		ops: {
			description: 'Ops',
			grants: { quotes: { read: true, create: true, update: true, delete: true } },
			automations: ['classify']
		},
		// a writer that reads the `titles` output only: its effects see the rows it wrote as that output
		clerk: {
			description: 'Write quotes, read their titles',
			grants: {
				quotes: {
					outputs: { titles: true },
					create: true,
					update: true,
					delete: true
				}
			}
		},
		limited: {
			description: 'Read quote titles and start a manual review',
			grants: { quotes: { outputs: { titles: true } } },
			automations: ['review']
		},
		writer: {
			description: 'Write quotes; starts nothing',
			grants: { quotes: { read: true, create: true } }
		},
		starter: { description: 'Starts a retitle', grants: {}, automations: ['retitle'] },
		// the requestor's own quotes: in a run the requestor is the system identity, which owns none
		own: {
			description: "Retitle the requestor's quotes",
			grants: {
				quotes: {
					read: { quotes: { where: { created_by: { eq: { var: 'requestor.id' } } } } },
					update: true
				}
			}
		}
	},
	automations: {
		review: {
			description: 'Review authored rows',
			input: {
				model: { kind: 'text' },
				rows: {
					kind: 'list',
					of: {
						kind: 'object',
						fields: {
							id: { kind: 'text' },
							title: { kind: 'text' },
							status: { kind: 'text' },
							note: { kind: 'text' }
						}
					}
				}
			},
			policies: ['limited']
		},
		pair: { description: 'Two independent reviews', policies: ['ops'], concurrency: { max: 2 } },
		classify: { description: 'Re-queues itself while work is left', policies: ['ops'] },
		flaky: {
			description: 'Fails transiently twice',
			policies: ['ops'],
			retry: { attempts: 3, backoff: '1min' }
		},
		retitle: {
			description: "Retitle the requestor's quote",
			input: { quote: { kind: 'text' } },
			policies: ['own']
		},
		hook: {
			description: 'A webhook',
			on: { webhook: '/in', verify: { scheme: 'bearer', secret: 'HOOK' } },
			policies: ['ops']
		}
	}
};
const T0 = Date.parse('2026-09-25T09:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
type Body = (
	input: Json,
	ctx: {
		attempt: string;
		act(
			callable: string,
			input: Json,
			options?: Extract<
				CrossCall,
				{
					_tag: 'act';
				}
			>['options']
		): Effect.Effect<Json, BoltError>;
		schedule(
			name: string,
			input: Json,
			options?: {
				at?:
					| string
					| {
							var: string;
					  };
				key?: string;
			}
		): Effect.Effect<Json, BoltError>;
		notify(notices: Json): Effect.Effect<Json, BoltError>;
	}
) => Effect.Effect<Json | void, EngineError>;
/** The fake guest shares the decoded crossing contract with the isolate runner. */
function fakeGuest(
	manifest: EngineManifest,
	bodies: {
		[name: string]: Body;
	},
	calls: Invocation[]
): GuestShape {
	return {
		invokeProgram: () =>
			Effect.die(new Error('This fixture does not execute supplied guest programs.')),
		invoke: (inv, bridge) =>
			Effect.gen(function* () {
				calls.push(inv);
				const cross = Effect.fn('TestGuest.cross')(function* (call: CrossCall) {
					const [answer] = yield* bridge.cross([call]);
					if (answer === undefined)
						return yield* Effect.fail(
							BoltError.make('badAnswer', 'guest', 'Missing crossing answer')
						);
					if (!answer.ok) {
						const error = answer.error;
						const code = Schema.decodeUnknownResult(Schema.Literals(CODES))(
							'code' in error ? error.code : error.kind
						);
						return yield* Effect.fail(
							BoltError.make(
								Result.isSuccess(code) ? code.success : 'guestError',
								'guest',
								'message' in error
									? error.message
									: 'reason' in error
										? error.reason
										: 'A facility call failed'
							)
						);
					}
					return answer.value;
				});
				const body = bodies[inv.target];
				if (body === undefined)
					return {
						kind: 'failed' as const,
						error: BoltError.make('missingBody', 'guest', inv.target)
					};
				return yield* body(inv.input, {
					attempt: inv.id,
					act: (name, input, options) =>
						Effect.gen(function* () {
							const parsed = parseCallable(name, manifest);
							if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
							const callable = parsed.success;
							const value = yield* cross({
								_tag: 'act',
								callable,
								input,
								...(options === undefined ? {} : { options })
							});
							const outcome = yield* Schema.decodeUnknownEffect(Outcome)(value).pipe(
								Effect.mapError(() => BoltError.make('badAnswer', 'guest', 'Malformed act result'))
							);
							if (outcome.kind !== 'committed')
								return yield* Effect.fail(
									BoltError.make(
										outcome.kind === 'refused'
											? outcome.code
											: outcome.kind === 'conflict'
												? 'conflict'
												: 'unknown',
										'guest',
										outcome.kind === 'refused' ? outcome.message : outcome.kind
									)
								);
							return value;
						}),
					schedule: (automation, input, options = {}) =>
						cross({ _tag: 'schedule', automation, input, ...options }),
					notify: (notices) => cross({ _tag: 'notify', notices })
				}).pipe(
					Effect.map((output) => ({ kind: 'ok' as const, output: output ?? null })),
					Effect.catch((error) =>
						Effect.succeed({
							kind: 'failed' as const,
							error:
								error._tag === 'BoltError'
									? error
									: BoltError.make('guestError', 'guest', error.message, error)
						})
					)
				);
			})
	};
}
type World = {
	/** The engine graph, for routes served over it. */
	context: Context.Context<EngineServices | EngineHost>;
	e: {
		act: WritesShape['act'];
		authority: IdentityShape['authority'];
	};
	r: RunsShape;
	db: TenantDbShape;
	secrets: SecretsShape;
	statements: {
		at: number;
		text: string;
		params: readonly Json[];
	}[];
	calls: Invocation[];
	wakes: number[];
	clock: {
		ms: number;
	};
	act(model: string, verb: Verb, input: Json): Effect.Effect<WriteOutcome, EngineError>;
	until(ms: number): Effect.Effect<void, EngineError>;
	sql(text: string, params?: Json[]): Effect.Effect<Rows['rows'], EngineError>;
};
// One engine for the file over a forwarding database: each test acquires its own database at the checkpoint and its own
// runs service and fake guest; only the engine graph (layers, caches) is shared.
const shared = {
	inner: undefined as TenantDbShape | undefined,
	clock: { ms: T0 },
	statements: [] as { at: number; text: string; params: readonly Json[] }[],
	next: null as number | null
};
const current = () => {
	if (shared.inner === undefined) throw new Error('no test database');
	return shared.inner;
};
const sharedDb = TenantDb.typed({
	read: (batch) =>
		Effect.suspend(() => {
			shared.statements.push(
				...batch.map((x) => ({ at: shared.clock.ms, text: x.text, params: x.params }))
			);
			return current().read(batch);
		}),
	write: (statement, lock) =>
		Effect.suspend(() => {
			shared.statements.push({
				at: shared.clock.ms,
				text: statement.text,
				params: statement.params
			});
			return current().write(statement, lock);
		}),
	// Keep every native batch statement visible, including audit receipts and acknowledgements.
	transaction: (batch) =>
		Effect.suspend(() => {
			shared.statements.push(
				...batch.statements.map((x) => ({ at: shared.clock.ms, text: x.text, params: x.params }))
			);
			return current().transaction(batch);
		}),
	session: () => Effect.suspend(() => current().session())
});
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const engineOnce = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const deadlines: DeadlinePort['Service'] = {
				announce: (_, at) =>
					Effect.sync(() => {
						shared.next = Math.min(shared.next ?? Infinity, Date.parse(at));
					}),
				settle: (_, at) =>
					Effect.sync(() => {
						shared.next = at === null ? null : Date.parse(at);
					}),
				teardown: () =>
					Effect.sync(() => {
						shared.next = null;
					})
			};
			const host = Layer.mergeAll(
				bareHost(sharedDb),
				Keys.fromAbi(keysPort(new Uint8Array(32).fill(7))),
				Layer.succeed(DeadlinePort, deadlines)
			);
			// the engine reads its database while it builds: a checkpoint database for the build alone
			return yield* Effect.scoped(
				Effect.gen(function* () {
					shared.inner = PgliteDb.make(yield* TestDb.open(base));
					// queue fixtures isolate recovery retries: the engine builds on the live clock
					return yield* TestClock.withLive(
						Layer.build(EngineLive(base).pipe(Layer.provideMerge(host))).pipe(
							Scope.provide(fileScope)
						)
					);
				})
			);
		})
	)
);
const world = Effect.fn('TestRuns.world')(function* (
	manifest: EngineManifest,
	bodies: {
		[name: string]: Body;
	} = {},
	extra: {
		platform?: {
			readonly [name: string]: RunHandler;
		};
	} = {}
) {
	const context = yield* engineOnce;
	const inner = PgliteDb.make(yield* TestDb.open(manifest));
	shared.inner = inner;
	const clock = shared.clock,
		statements = shared.statements,
		db = sharedDb;
	clock.ms = T0;
	shared.next = null;
	yield* TestClock.setTime(T0);
	const calls: Invocation[] = [];
	const runContext = yield* Layer.build(
		RunsLive.pipe(
			Layer.provide(
				Layer.succeedContext(Context.add(context, Guest, fakeGuest(manifest, bodies, calls)))
			),
			Layer.provide(ConfigProvider.layer(Context.get(context, Secrets).config))
		)
	);
	const r = Context.get(runContext, Runs),
		writes = Context.get(context, Writes),
		identity = Context.get(context, Identity);
	const e = { act: writes.act, authority: identity.authority };
	if (extra.platform !== undefined)
		yield* Context.get(context, RunHandlers).register(extra.platform);
	const admin: Holder = {
		actor: {
			kind: 'member',
			id: randomUUID(),
			email: null,
			phone: null,
			external: false,
			teams: [],
			teamPath: [],
			admin: true,
			party: null
		},
		policies: [],
		admin: true
	};
	const wakes: number[] = [];
	yield* r.boot();
	statements.length = 0;
	return {
		context,
		e,
		r,
		db,
		secrets: Context.get(context, Secrets),
		statements,
		calls,
		wakes,
		clock,
		act: (model: string, verb: Verb, input: Json) =>
			Effect.gen(function* () {
				return (yield* e.act({
					model,
					verb,
					input,
					mode: { _tag: 'Direct' },
					key: randomUUID(),
					issuedAt: iso(clock.ms),
					authority: yield* e.authority(admin),
					bindings: {
						now: iso(clock.ms),
						today: iso(clock.ms).slice(0, 10),
						tz: 'UTC'
					},
					invocationId: randomUUID()
				})).outcome;
			}),
		until: (end: number) =>
			Effect.gen(function* () {
				while (shared.next !== null && shared.next <= end) {
					clock.ms = Math.max(clock.ms, shared.next);
					shared.next = null;
					wakes.push(clock.ms);
					yield* TestClock.setTime(clock.ms);
					yield* r.tick;
				}
				clock.ms = end;
				yield* TestClock.setTime(end);
			}),
		sql: (text: string, params: Json[] = []) =>
			Effect.map(inner.read([{ text, params }]), (rows) => rows[0]?.rows ?? [])
	} satisfies World;
});
const setNow = (w: World, ms: number) =>
	Effect.gen(function* () {
		w.clock.ms = ms;
		yield* TestClock.setTime(ms);
	});
const queue = (w: World, id: string, automation: string, due: number) =>
	w.db.write({
		text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
		VALUES ($1, $2, '{"conversation":"c","waits":0}'::jsonb, $3::timestamptz, 'schedule', 0)`,
		params: [id, automation, iso(due)]
	});
const member = (policies: string[]): Holder => ({
	actor: {
		kind: 'member',
		id: randomUUID(),
		email: null,
		phone: null,
		external: false,
		teams: [],
		teamPath: [],
		admin: false,
		party: null
	},
	policies,
	admin: false
});

describe('lost leases (rules 52a, 70)', () => {
	it.effect('a dropped run reruns from the start at most 3 times, then fails lostLease', () =>
		Effect.gen(function* () {
			let starts = 0,
				entered = yield* Deferred.make<void>();
			const w = yield* world(base, {
				classify: () =>
					Effect.gen(function* () {
						starts++;
						yield* Deferred.succeed(entered, undefined);
						return yield* Effect.never;
					})
			});
			yield* queue(w, 'dropped', 'classify', T0);
			for (let drop = 1; drop <= 4; drop++) {
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				entered = yield* Deferred.make<void>();
				// the process drops the run: its fiber ends, and the next boot finds it still running
				yield* Fiber.interrupt(ticking);
				yield* w.r.boot();
				expect(starts).toBe(drop);
			}
			expect(
				yield* w.sql(
					`SELECT state, attempts, leases, error->>'code' AS code FROM sys_run WHERE id = 'dropped'`
				)
			).toEqual([{ state: 'failed', attempts: 4, leases: 4, code: 'lostLease' }]);
		})
	);
});

/** The ids an effect body received: its rows', or its changes' `after` images'. */
const EffectImages = Schema.Array(
	Schema.Union([
		Schema.Struct({ after: Schema.Struct({ id: Schema.String }) }),
		Schema.Struct({ id: Schema.String })
	])
);
const effectIds = (input: Json): string[] =>
	Schema.decodeUnknownSync(EffectImages)(input).map((x) => ('after' in x ? x.after.id : x.id));
describe('model effects and starts (rules 49, 50, 51)', () => {
	it.effect(
		'each committed verb queues one effect run as its writer, due at its commit, its rows the writer’s view output; its schedule needs no start grant and records the effect as its trigger; a write that changes nothing queues none; a manual start keeps its rows',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, {
					'quotes.effect.created': (input) => Effect.succeed(input),
					'quotes.effect.updated': (input) => Effect.succeed(input),
					// code schedules without a start grant: the clerk may not start `classify`, its effect may
					'quotes.effect.deleted': (_, ctx) => ctx.schedule('classify', {}),
					classify: () => Effect.void,
					review: (input) => Effect.succeed(input)
				});
				// a manual start: its authored rows reach the body intact
				const manual: Json = {
					model: 'quotes',
					rows: [
						{ id: 'supplied-row', title: 'Authored title', status: 'sent', note: 'Authored data' }
					]
				};
				const run = randomUUID();
				expect(
					yield* Context.get(w.context, Callables).start({
						automation: 'review',
						runs: [{ id: run, input: manual }],
						authority: yield* w.e.authority(member(['limited'])),
						bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC' }
					})
				).toMatchObject({ kind: 'committed' });
				expect(w.calls).toEqual([]);
				expect(yield* w.sql('SELECT state, cause FROM sys_run WHERE id = $1', [run])).toEqual([
					{ state: 'queued', cause: 'start' }
				]);
				yield* w.until(T0);
				expect(w.calls.map((call) => ({ target: call.target, input: call.input }))).toEqual([
					{ target: 'review', input: manual }
				]);

				// the clerk writes; each effect runs as the clerk, due at its exact commit
				const clerk = member(['clerk']);
				const as = (verb: Verb, input: Json) =>
					Effect.gen(function* () {
						return (yield* w.e.act({
							model: 'quotes',
							mode: { _tag: 'Direct' },
							verb,
							input,
							key: randomUUID(),
							issuedAt: iso(w.clock.ms),
							authority: yield* w.e.authority(clerk),
							bindings: { now: iso(w.clock.ms), today: '2026-09-25', tz: 'UTC' },
							invocationId: randomUUID()
						})).outcome;
					});
				const at = T0 + 6 * 60000;
				yield* setNow(w, at + 17000);
				const created = yield* as('create', [{ title: 'a' }, { title: 'c' }]);
				if (created.kind !== 'committed' || created.records[1] === undefined)
					throw new Error('Missing quotes');
				const first = created.records[0]?.id ?? '',
					second = created.records[1].id;
				yield* setNow(w, at + 23000);
				yield* as('update', [{ target: first, set: { title: 'b' } }]);
				yield* as('update', [{ target: first, set: { title: 'b' } }]); // nothing changes: no run
				yield* as('delete', [{ target: first }]);
				const woken = w.wakes.length;
				yield* w.until(at + 60000);
				expect([...new Set(w.wakes.slice(woken))]).toEqual([at + 23000]);
				const effects = w.calls.filter((c) => c.kind === 'effect');
				expect(effects.map((c) => c.target).sort()).toEqual([
					'quotes.effect.created',
					'quotes.effect.deleted',
					'quotes.effect.updated'
				]);
				const input = (verb: string) =>
					effects.find((c) => c.target === `quotes.effect.${verb}`)?.input;
				// one bulk run per committed batch, each image only the fields the clerk's `titles` output reads
				expect(input('created')).toEqual(
					[
						{ id: first, revision: 1, title: 'a' },
						{ id: second, revision: 1, title: 'c' }
					].sort((x, y) => String(x.id).localeCompare(String(y.id)))
				);
				expect(input('updated')).toEqual([
					{
						before: { id: first, revision: 1, title: 'a' },
						after: { id: first, revision: 2, title: 'b' }
					}
				]);
				expect(input('deleted')).toEqual([{ id: first, revision: 2, title: 'b' }]);
				expect(effects.every((c) => canonical(c.ctx.actor) === canonical(clerk.actor))).toBe(true);
				expect(
					yield* w.sql(
						`SELECT automation, state, cause, depth, actor, starter->'policies' AS policies FROM sys_run WHERE cause = 'effect' ORDER BY due_at, automation`
					)
				).toEqual(
					['quotes.effect.created', 'quotes.effect.deleted', 'quotes.effect.updated'].map(
						(automation) => ({
							automation,
							state: 'succeeded',
							cause: 'effect',
							depth: 0,
							actor: `member:${clerk.actor.kind === 'member' ? clerk.actor.id : ''}`,
							policies: ['clerk']
						})
					)
				);
				// the scheduled run is the system holding `ops`; its trigger is the effect after the clerk's delete
				const classify = w.calls.find((c) => c.target === 'classify');
				expect(classify?.ctx.actor).toEqual({
					kind: 'system',
					run: classify?.run,
					by: { automation: 'classify' }
				});
				expect(classify?.ctx.run?.trigger).toEqual({
					kind: 'system',
					cause: 'effect',
					model: 'quotes',
					verb: 'deleted',
					records: [first]
				});
				expect(
					yield* w.sql(`SELECT state, cause FROM sys_run WHERE automation = 'classify'`)
				).toEqual([{ state: 'succeeded', cause: 'schedule' }]);
			})
	);
	it.effect(
		'an effect retries a transient failure; one whose writes run their own effects stops at the chain depth with a failed run; an automation run’s write runs its effect as that run',
		() =>
			Effect.gen(function* () {
				let failures = 1;
				const w = yield* world(base, {
					'quotes.effect.created': (input, ctx) =>
						Effect.gen(function* () {
							if (failures-- > 0)
								return yield* Effect.fail(BoltError.make('upstream', 'guest', '502'));
							for (const id of effectIds(input))
								yield* ctx.act('quotes.update', [{ target: id, set: { title: 'loop 0' } }]);
						}),
					'quotes.effect.updated': (input, ctx) =>
						Effect.gen(function* () {
							for (const id of effectIds(input))
								yield* ctx.act('quotes.update', [
									{ target: id, set: { title: `loop ${randomUUID()}` } }
								]);
						}),
					classify: (_, ctx) => ctx.act('quotes.create', [{ title: 'by a run' }])
				});
				yield* w.act('quotes', 'create', [{ title: 'start' }]);
				yield* w.until(T0 + 10 * 60000);
				expect(
					yield* w.sql(
						`SELECT attempts, state FROM sys_run WHERE automation = 'quotes.effect.created'`
					)
				).toEqual([{ attempts: 2, state: 'succeeded' }]);
				const chain = yield* w.sql(
					`SELECT depth, state, error->>'code' AS code FROM sys_run WHERE automation = 'quotes.effect.updated' ORDER BY depth`
				);
				expect(chain.map((r) => r['depth'])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
				expect(chain.slice(0, 8).every((r) => r['state'] === 'succeeded')).toBe(true);
				expect(chain[8]).toEqual({ depth: 9, state: 'failed', code: 'depth' });

				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('classify-run', 'classify', '{}', $1::timestamptz, 'start', 0)`,
					params: [iso(w.clock.ms)]
				});
				yield* w.r.boot();
				yield* w.until(w.clock.ms + 60000);
				expect(
					yield* w.sql(
						`SELECT depth, actor, starter->'actor'->'by' AS by, starter->'policies' AS policies FROM sys_run WHERE automation = 'quotes.effect.created' AND actor = 'system:classify-run'`
					)
				).toEqual([
					{
						depth: 1,
						actor: 'system:classify-run',
						by: { automation: 'classify' },
						policies: ['ops']
					}
				]);
			})
	);
});

describe('a run is the system holding its policies; its trigger records who started it', () => {
	it.effect(
		'an effect-scheduled, a manual and an unattributed run record their trigger; none lends the run its starter, so a requestor-scoped grant matches nothing; code schedules without a start grant',
		() =>
			Effect.gen(function* () {
				const quote = (input: Json) =>
					Schema.decodeUnknownSync(Schema.Struct({ quote: Schema.String }))(input).quote;
				const w = yield* world(base, {
					// the writer holds no start grant: its effect's code schedules all the same
					'quotes.effect.created': (input, ctx) =>
						Effect.forEach(effectIds(input), (id) => ctx.schedule('retitle', { quote: id })),
					'quotes.effect.updated': () => Effect.void,
					retitle: (input, ctx) =>
						ctx.act('quotes.update', [{ target: quote(input), set: { title: 'retitled' } }])
				});
				const writer = member(['writer']),
					starter = member(['starter']);
				const bindings = { now: iso(T0), today: '2026-09-25', tz: 'UTC' };
				const created = yield* w.e.act({
					model: 'quotes',
					mode: { _tag: 'Direct' },
					verb: 'create',
					input: [{ title: 'mine' }],
					key: randomUUID(),
					issuedAt: iso(T0),
					authority: yield* w.e.authority(writer),
					bindings,
					invocationId: randomUUID()
				});
				if (created.outcome.kind !== 'committed') throw new Error('Missing quote');
				const id = created.outcome.records[0]?.id ?? '';
				yield* w.until(T0 + 60000);
				const start = (holder: Holder, run: string) =>
					Effect.gen(function* () {
						return yield* Context.get(w.context, Callables).start({
							automation: 'retitle',
							runs: [{ id: run, input: { quote: id } }],
							authority: yield* w.e.authority(holder),
							bindings,
							agent: { conversation: 'c1' }
						});
					});
				// a manual start needs the grant on the starter's policy
				expect(yield* start(writer, randomUUID())).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				const manual = randomUUID();
				expect(yield* start(starter, manual)).toMatchObject({ kind: 'committed' });
				// a run queued before triggers were recorded reads as an unattributed schedule
				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('orphan', 'retitle', $1::jsonb, $2::timestamptz, 'schedule', 0)`,
					params: [{ quote: id }, iso(T0)]
				});
				yield* w.r.boot();
				yield* w.until(T0 + 2 * 60000);
				const runs = w.calls.filter((c) => c.target === 'retitle');
				// every run is the system identity, whoever triggered it
				expect(runs.map((c) => c.ctx.actor.kind)).toEqual(['system', 'system', 'system']);
				expect(runs.map((c) => c.ctx.run?.trigger)).toEqual([
					{ kind: 'system', cause: 'effect', model: 'quotes', verb: 'created', records: [id] },
					{ kind: 'person', actor: starter.actor, agent: { conversation: 'c1' } },
					{ kind: 'system', cause: 'schedule' }
				]);
				expect(
					yield* w.sql(
						`SELECT cause, state, error->>'code' AS code, trigger->>'kind' AS kind FROM sys_run WHERE automation = 'retitle' ORDER BY cause DESC, id = 'orphan'`
					)
				).toEqual([
					{ cause: 'start', state: 'failed', code: 'notFound', kind: 'person' },
					{ cause: 'schedule', state: 'failed', code: 'notFound', kind: 'system' },
					{ cause: 'schedule', state: 'failed', code: 'notFound', kind: null }
				]);
				expect(yield* w.sql('SELECT title FROM quotes')).toEqual([{ title: 'mine' }]);
			})
	);
});

describe('re-queues, attempts and notices (rules 21, 54, 55, 70)', () => {
	it.effect(
		'a same-key re-queue replaces and its chain ends; only a Transient failure retries the same run from the start, a bug never; a notice resolves its holders once across retries, and one to no one is refused or reported',
		() =>
			Effect.gen(function* () {
				let left = 1,
					refused: unknown;
				const w = yield* world(base, {
					classify: (_, ctx) =>
						Effect.gen(function* () {
							if (left === 1) {
								refused = yield* ctx.notify({ to: [], title: 'nowhere' }).pipe(
									Effect.as('sent'),
									Effect.catch((error) => Effect.succeed(error.code))
								);
								yield* ctx.notify({ to: [{ team: 'nobody' }], title: 'unheard' });
							}
							if (left-- <= 0) return;
							for (let i = 0; i < 2; i++)
								yield* ctx.schedule(
									'classify',
									{},
									{ at: { var: 'now + minutes(1)' }, key: 'classify_retry' }
								);
						}),
					flaky: (input, ctx) =>
						Effect.gen(function* () {
							if (Predicate.hasProperty(input, 'bug'))
								return yield* Effect.fail(BoltError.make('guestError', 'guest', 'bug'));
							yield* ctx.act('quotes.create', [{ title: 'once' }]);
							yield* ctx.notify({
								to: [{ policy: 'ops' }, { team: 'ops' }, { user: 'holder' }],
								title: 'For ops',
								once: 'source-policy-notice'
							});
							if (!ctx.attempt.endsWith(':3'))
								return yield* Effect.fail(BoltError.make('upstream', 'guest', '502'));
							return 'done';
						})
				});
				yield* w.db.write({
					// holder resolution itself is source-access's; here the notice is sent once across retries
					text: `INSERT INTO sys_user(id,name,team,active,kind) VALUES ('holder','Holder','ops',true,'staff')`,
					params: []
				});
				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('bug', 'flaky', '{"bug":true}', $1::timestamptz, 'schedule', 0)`,
					params: [iso(T0)]
				});
				// a seed pack's `start` runs, queued as its load queues them
				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT gen_random_uuid(), a, '{}', $1::timestamptz, 'start', 0 FROM unnest(ARRAY['classify', 'flaky']) a`,
					params: [iso(T0)]
				});
				yield* w.r.boot();
				// flaky's retries back off 1 then 2 minutes (jittered) and classify re-queues by the minute: ten minutes hold them all
				yield* w.until(T0 + 10 * 60000);
				// classify's re-queues land on their exact minute (flaky's retries are jittered backoffs)
				expect(
					yield* w.sql(
						`SELECT state, due_at::text AS due FROM sys_run WHERE automation = 'classify' ORDER BY due_at`
					)
				).toEqual(
					[T0, T0 + 60000].map((ms) => ({
						state: 'succeeded',
						due: iso(ms).replace('T', ' ').replace('.000Z', '+00')
					}))
				);
				expect(refused).toBe('invalidInput');
				expect(
					yield* w.sql(
						`SELECT results->0->'warnings' AS warnings FROM sys_run WHERE automation = 'classify' ORDER BY due_at LIMIT 1`
					)
				).toEqual([{ warnings: [`notify: 'unheard' reached no member`] }]);
				expect(
					yield* w.sql(
						`SELECT state, attempts, output, jsonb_array_length(results) AS results FROM sys_run WHERE automation = 'flaky' AND id <> 'bug'`
					)
				).toEqual([{ state: 'succeeded', attempts: 3, output: 'done', results: 3 }]);
				expect(
					yield* w.sql(
						`SELECT state, attempts, error->>'code' AS code FROM sys_run WHERE id = 'bug'`
					)
				).toEqual([{ state: 'failed', attempts: 1, code: 'guestError' }]);
				expect(yield* w.sql(`SELECT count(*)::int AS n FROM quotes WHERE title = 'once'`)).toEqual([
					{ n: 3 }
				]);
				expect(yield* w.sql('SELECT member,title FROM sys_notification')).toEqual([
					{ member: 'holder', title: 'For ops' }
				]);
			})
	);
});

describe('webhooks and visibility (rules 56, 56a)', () => {
	it.effect(
		'a webhook verifies before reading, dedupes deliveries and acknowledges after its run commits; a run is readable in full by holders and admins, its causing actor sees status and error code only',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, {
					hook: (input) => Effect.succeed(input),
					'quotes.effect.updated': () =>
						Effect.fail(BoltError.make('guestError', 'guest', 'secret detail'))
				});
				yield* w.secrets.set('workspace', 'HOOK', 'tok');
				w.statements.length = 0;
				const body = new TextEncoder().encode('{"order":1}');
				expect(
					yield* w.r.webhook('/in', {
						method: 'POST',
						headers: { authorization: 'Bearer nope' },
						body
					})
				).toEqual({ status: 401 });
				expect(w.statements).toEqual([]);
				const ok = { method: 'POST', headers: { authorization: 'Bearer tok' }, body };
				expect(yield* w.r.webhook('/in', ok)).toEqual({ status: 200 });
				expect(yield* w.r.webhook('/in', ok)).toEqual({ status: 200 });
				expect(
					yield* w.r.webhook('/in', { ...ok, body: new TextEncoder().encode('not json') })
				).toEqual({ status: 400 });
				yield* w.until(T0);
				expect(w.calls.filter((c) => c.target === 'hook').map((c) => c.input)).toEqual([
					{ order: 1 }
				]);
				expect(
					yield* w.sql(
						`SELECT state, count(*)::int AS n FROM sys_run WHERE automation = 'hook' GROUP BY state ORDER BY state`
					)
				).toEqual([
					{ state: 'failed', n: 1 },
					{ state: 'succeeded', n: 1 }
				]);

				const holder = member(['ops']);
				if (holder.actor.kind !== 'member') throw new Error('Expected a member actor');
				const as = (verb: Verb, input: Json) =>
					Effect.gen(function* () {
						return (yield* w.e.act({
							model: 'quotes',
							mode: { _tag: 'Direct' },
							verb,
							input,
							key: randomUUID(),
							issuedAt: iso(T0),
							authority: yield* w.e.authority(holder),
							bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC' },
							invocationId: randomUUID()
						})).outcome;
					});
				const created = yield* as('create', [{ title: 'x', status: 'draft' }]);
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Missing created quote');
				const id = created.records[0].id;
				yield* as('update', [{ target: id, set: { status: 'sent' } }]);
				yield* w.until(T0);
				const [run] = yield* w.sql(
					`SELECT id FROM sys_run WHERE automation = 'quotes.effect.updated'`
				);
				if (run === undefined) throw new Error('Missing updated effect run');
				const runId = String(run['id']);
				const seen = Option.getOrNull(yield* w.r.view(yield* w.e.authority(holder), runId));
				expect(seen).toEqual(
					expect.objectContaining({ status: 'failed', error: { code: 'guestError' } })
				);
				expect(seen).not.toHaveProperty('input');
				const other = yield* w.e.authority({
					...holder,
					actor: { ...holder.actor, id: randomUUID() }
				});
				expect(Option.getOrNull(yield* w.r.view(other, runId))).toBeNull();
				const admin = yield* w.e.authority({ ...holder, admin: true });
				expect(Option.getOrNull(yield* w.r.view(admin, runId))).toMatchObject({
					error: { code: 'guestError', message: 'secret detail' },
					input: { ids: [id] }
				});
			})
	);
});

describe('lanes (rules 48, 51)', () => {
	it.effect(
		'a long automation never holds a triage or another automation, while its own runs stay one at a time; declared concurrency admits two and drains the rest',
		() =>
			Effect.gen(function* () {
				const triaged = yield* Deferred.make<void>(),
					flakyStarted = yield* Deferred.make<void>(),
					entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				let running = 0,
					most = 0,
					pairs = 0,
					mostPairs = 0;
				/** `classify` holds until the triage and `flaky` have run: run one after the other, the tick never ends. */
				const w = yield* world(
					base,
					{
						classify: () =>
							Effect.gen(function* () {
								most = Math.max(most, ++running);
								yield* Deferred.await(triaged);
								yield* Deferred.await(flakyStarted);
								running -= 1;
								return { done: true };
							}),
						flaky: () => Deferred.succeed(flakyStarted, undefined).pipe(Effect.as({ done: true })),
						pair: () =>
							Effect.gen(function* () {
								mostPairs = Math.max(mostPairs, ++pairs);
								if (pairs === 2) yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							}).pipe(
								Effect.ensuring(
									Effect.sync(() => {
										pairs -= 1;
									})
								)
							)
					},
					{
						platform: {
							'agent.triage': () =>
								Deferred.succeed(triaged, undefined).pipe(Effect.as({ decided: true }))
						}
					}
				);
				yield* queue(w, 'c1', 'classify', T0 - 3000); // claimed first
				yield* queue(w, 'c2', 'classify', T0 - 2000);
				yield* queue(w, 'f', 'flaky', T0 - 1000);
				yield* queue(w, 't', 'agent.triage', T0);
				yield* w.r.tick;
				expect(yield* w.sql(`SELECT id, state FROM sys_run ORDER BY due_at`)).toEqual([
					{ id: 'c1', state: 'succeeded' },
					{ id: 'c2', state: 'succeeded' },
					{ id: 'f', state: 'succeeded' },
					{ id: 't', state: 'succeeded' }
				]);
				expect(most).toBe(1);

				const pairRuns = `SELECT id, state, attempts FROM sys_run WHERE automation = 'pair' ORDER BY due_at`;
				for (const [id, due] of [
					['first', T0 - 3000],
					['second', T0 - 2000],
					['third', T0 - 1000]
				] satisfies [string, number][])
					yield* queue(w, id, 'pair', due);
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				expect(yield* w.sql(pairRuns)).toEqual([
					{ id: 'first', state: 'running', attempts: 1 },
					{ id: 'second', state: 'running', attempts: 1 },
					{ id: 'third', state: 'queued', attempts: 0 }
				]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(ticking);
				expect(yield* w.sql(pairRuns)).toEqual([
					{ id: 'first', state: 'succeeded', attempts: 1 },
					{ id: 'second', state: 'succeeded', attempts: 1 },
					{ id: 'third', state: 'succeeded', attempts: 1 }
				]);
				expect(mostPairs).toBe(2);
				expect(pairs).toBe(0);
			})
	);
});
