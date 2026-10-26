// The runs area on PGlite (rules 48–56a, 70): the one queue, the deadlines port, buckets, event triggers written in the
// causing statement, re-queues, attempts, the journal, webhooks, visibility, restart recovery. Crons: runs-fire.
import { randomUUID } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import {
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Result,
	Schema,
	Stream
} from 'effect';
import { TestClock } from 'effect/testing';
import type { Json } from '../src/decl/values.ts';
import type { Holder } from '../src/engine/access/authority.ts';
import type {
	Authority,
	Invocation,
	Rows,
	Outcome as WriteOutcome
} from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { type EngineError } from '../src/engine/errors.ts';
import { Port } from '../src/engine/port.ts';
import { BoltError, CODES } from '../src/protocol/errors.ts';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { EngineLive, type EngineHost, type EngineServices } from '../src/engine/host.ts';
import { memoryAuditLayer, respondSystem1 } from '../src/test/index.ts';
import {
	Activation,
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
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Docs,
	Images,
	Keys,
	Mcp,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../src/engine/ports.ts';
import { nodePorts } from '../src/node/ports.ts';
import { keysPort } from '../src/node/keys.ts';
import { Secrets, type SecretsShape } from '../src/engine/secrets.ts';
import { RunsLive } from '../src/engine/runs/index.ts';
import { RunJournal, type JournalEntry } from '../src/engine/runs/journal.ts';
import { parseCallable } from '../src/engine/callables/index.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { Outcome } from '../src/protocol/schema.ts';
import {
	AgentCallTable,
	AgentTurns,
	boltRoutes,
	RateLimits,
	SessionAuthority
} from '../src/protocol/http.ts';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import type { Verb } from '../src/engine/write/act.ts';
const base: EngineManifest = {
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
	collections: {
		quotes: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'status'] } },
			update: { input: { columns: ['title', 'status'] } },
			delete: {}
		}
	},
	integrations: {},
	teams: {},
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
		}
	},
	automations: {
		remind: {
			description: 'Remind 3 days after a quote',
			on: { created: 'quotes', delay: '3d' },
			runAs: ['ops']
		},
		sent: {
			description: 'A quote was sent',
			on: { updated: 'quotes', fields: ['status'], where: { status: { eq: 'sent' } } },
			runAs: ['ops']
		},
		gone: { description: 'A quote was deleted', on: { deleted: 'quotes' }, runAs: ['ops'] },
		classify: { description: 'Re-queues itself while work is left', runAs: ['ops'] },
		flaky: {
			description: 'Fails transiently twice',
			runAs: ['ops'],
			retry: { attempts: 3, backoff: '1min' }
		},
		hook: {
			description: 'A webhook',
			on: { webhook: '/in', verify: { scheme: 'bearer', secret: 'HOOK' } },
			runAs: ['ops']
		}
	}
};
const withCron: EngineManifest = {
	...base,
	automations: {
		...base.automations,
		digest: { description: 'Daily', on: { cron: '0 6 * * *' }, runAs: ['ops'] }
	}
};
const empty: EngineManifest = { ...base, automations: {} };
const T0 = Date.parse('2026-09-25T09:00:00Z');
const DAY = 86400000;
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
							now: string;
					  };
				key?: string;
			}
		): Effect.Effect<Json, BoltError>;
		notify(notices: Json): Effect.Effect<Json, BoltError>;
		/** `ctx.web.read`: a durable call, answered from the run's journal on a replay. */
		web(url: string): Effect.Effect<Json, BoltError>;
		infer(args: Json): Effect.Effect<Json, BoltError>;
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
					notify: (notices) => cross({ _tag: 'notify', notices }),
					web: (url) => cross({ _tag: 'web.read', args: [url] }),
					infer: (args) => cross({ _tag: 'ai.sys_2.infer', args: [args] })
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
	act(collection: string, verb: Verb, input: Json): Effect.Effect<WriteOutcome, EngineError>;
	until(ms: number): Effect.Effect<void, EngineError>;
	sql(text: string, params?: Json[]): Effect.Effect<Rows['rows'], EngineError>;
};
const world = Effect.fn('TestRuns.world')(function* (
	manifest: EngineManifest,
	bodies: {
		[name: string]: Body;
	} = {},
	extra: {
		start?: readonly string[];
		maintenanceClock?: 'test';
		platform?: {
			readonly [name: string]: RunHandler;
		};
		journal?: RunJournal['Service'];
		web?: WebRead['Service'];
		ai?: Ai['Service'];
	} = {}
) {
	const pg = yield* PgliteDb.open().pipe(Effect.provide(Pristine.layer));
	const inner = PgliteDb.make(pg),
		clock = { ms: T0 };
	yield* TestClock.setTime(T0);
	const statements: {
		at: number;
		text: string;
		params: readonly Json[];
	}[] = [];
	const db = TenantDb.typed({
		read: (batch) =>
			Effect.suspend(() => {
				statements.push(...batch.map((x) => ({ at: clock.ms, text: x.text, params: x.params })));
				return inner.read(batch);
			}),
		write: (statement, lock) =>
			Effect.suspend(() => {
				statements.push({ at: clock.ms, text: statement.text, params: statement.params });
				return inner.write(statement, lock);
			}),
		// Keep every native batch statement visible, including audit receipts and acknowledgements.
		transaction: (batch) =>
			Effect.suspend(() => {
				statements.push(
					...batch.statements.map((x) => ({ at: clock.ms, text: x.text, params: x.params }))
				);
				return inner.transaction(batch);
			}),
		session: inner.session
	});
	let next: number | null = null;
	const deadlines: DeadlinePort['Service'] = {
		announce: (_, at) =>
			Effect.sync(() => {
				next = Math.min(next ?? Infinity, Date.parse(at));
			}),
		settle: (_, at) =>
			Effect.sync(() => {
				next = at === null ? null : Date.parse(at);
			}),
		teardown: () =>
			Effect.sync(() => {
				next = null;
			})
	};
	yield* applyPlan(db, yield* plan(null, manifest), { accept: true });
	const host = Layer.mergeAll(
		memoryAuditLayer,
		NodeCrypto.layer,
		NodeFileSystem.layer,
		NodePath.layer,
		Layer.unwrap(Effect.map(nodePorts(), (ports) => GuestIsolates.fromAbi(ports.guestIsolates))),
		Keys.fromAbi(keysPort(new Uint8Array(32).fill(7))),
		Http.unavailable,
		Images.unavailable,
		Docs.unavailable,
		Mcp.unavailable,
		Layer.succeed(TenantDb, db),
		extra.ai === undefined ? Ai.unavailable : Layer.succeed(Ai, extra.ai),
		Convert.unavailable,
		Layer.succeed(DeadlinePort, deadlines),
		Drivers.unavailable,
		Files.unavailable,
		Geo.unavailable,
		Metering.unavailable,
		Speech.unavailable,
		Transport.unavailable,
		extra.web === undefined ? WebRead.unavailable : Layer.succeed(WebRead, extra.web),
		...(extra.journal === undefined ? [] : [Layer.succeed(RunJournal, extra.journal)]),
		Layer.succeed(Activation, {
			scope: 'ws',
			epoch: '',
			release: '',
			publicUrl: 'http://localhost',
			guest: Option.none(),
			start: extra.start ?? []
		})
	);
	const engine = Layer.build(EngineLive(manifest).pipe(Layer.provideMerge(host)));
	// Queue fixtures isolate recovery retries; the quiet case advances the maintenance clock too.
	const context = yield* extra.maintenanceClock === 'test' ? engine : TestClock.withLive(engine);
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
	yield* r.boot;
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
		act: (collection: string, verb: Verb, input: Json) =>
			Effect.gen(function* () {
				return (yield* e.act({
					collection,
					verb,
					input,
					mode: { _tag: 'Direct' },
					key: randomUUID(),
					issuedAt: iso(clock.ms),
					authority: yield* e.authority(admin),
					bindings: {
						now: iso(clock.ms),
						today: iso(clock.ms).slice(0, 10),
						tz: 'UTC',
						params: {}
					},
					invocationId: randomUUID()
				})).outcome;
			}),
		until: (end: number) =>
			Effect.gen(function* () {
				while (next !== null && next <= end) {
					clock.ms = Math.max(clock.ms, next);
					next = null;
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
/** The host's clock fires the daily digest a day on; the first fire of a day prunes. */
const fireDigest = (w: World) =>
	Effect.gen(function* () {
		const slot = Date.parse('2026-09-26T06:00:00Z');
		yield* setNow(w, slot);
		yield* w.r.fire('digest', iso(slot));
	});
describe('the deadlines port and the idle workspace (rule 52a)', () => {
	it.effect('an idle workspace issues zero statements over a simulated week', () =>
		Effect.gen(function* () {
			const w = yield* world(empty, {}, { maintenanceClock: 'test' });
			yield* w.until(T0 + 7 * DAY);
			expect(w.statements).toEqual([]);
			expect(w.wakes).toEqual([]);
		})
	);
	it.effect(
		'the daily prune drops aged events, closed rate windows and spent host nonces (rule 56, §5.11.6)',
		() =>
			Effect.gen(function* () {
				const w = yield* world(withCron, {
					digest: () =>
						Effect.gen(function* () {
							return { ok: true };
						})
				});
				const old = iso(T0 - 4 * DAY);
				for (const text of [
					`INSERT INTO bolt_rate VALUES ('act', 'b', '${old}', 1), ('act', 'b', '${iso(T0)}', 1)`,
					`INSERT INTO bolt_host_nonce VALUES ('nonce:a', '${iso(T0 - 3600000)}'), ('run:a', '${iso(T0 - 3600000)}'), ('run:b', '${iso(T0 - 31 * DAY)}')`
				])
					yield* w.db.write({ text, params: [] });
				yield* fireDigest(w);
				expect(yield* w.sql(`SELECT count(*)::int AS n FROM bolt_rate`)).toEqual([{ n: 1 }]);
				expect(yield* w.sql(`SELECT key FROM bolt_host_nonce`)).toEqual([{ key: 'run:a' }]);
			})
	);
	it.effect(
		'the daily prune enforces the history horizon of 256 revisions per row (rule 17, L-BOLT-182)',
		() =>
			Effect.gen(function* () {
				const w = yield* world(withCron, {
					digest: () =>
						Effect.gen(function* () {
							return { ok: true };
						})
				});
				yield* w.db.write({
					text: `INSERT INTO bolt_history (collection, record, revision, op, cause) SELECT 'quotes', '00000000-0000-4000-8000-000000000001', g, 'update', 'direct' FROM generate_series(1, 260) g`,
					params: []
				});
				yield* fireDigest(w);
				expect(
					yield* w.sql(
						`SELECT count(*)::int AS n, min(revision) AS lo FROM bolt_history WHERE record = '00000000-0000-4000-8000-000000000001'`
					)
				).toEqual([{ n: 256, lo: 5 }]);
			})
	);
	it.effect(
		'a restart re-arms from one statement; a run that lost its lease is re-queued at once',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, { classify: () => Effect.gen(function* () {}) });
				yield* w.sql(
					`INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, attempts) VALUES ('lost', 'classify', '{}', now(), 'start', 0, 'running', 1)`
				);
				yield* w.r.boot;
				expect(w.statements).toHaveLength(1);
				yield* w.until(T0);
				expect(w.wakes).toEqual([T0]);
				expect(yield* w.sql(`SELECT state, leases FROM sys_run WHERE id = 'lost'`)).toEqual([
					{ state: 'succeeded', leases: 1 }
				]);
			})
	);
});
describe('a preview environment, where the host binds no links', () => {
	it.effect(
		'runs its internal automations on schedule and on writes; an external model sync never wakes',
		() =>
			Effect.gen(function* () {
				const preview = {
					...base,
					models: {
						...base.models,
						products: {
							description: 'An ERP product',
							label: 'name',
							key: ['source', 'code'],
							fields: { code: { kind: 'text' }, name: { kind: 'text' } }
						}
					},
					relationships: {
						'products.source': { to: 'sys_integration', where: { integration: { eq: 'erp' } } }
					},
					collections: {
						...base.collections,
						products: {
							read: { fields: 'all' },
							syncs: { erp: { with: 'erp', read: true, every: '15min' } }
						}
					},
					integrations: {
						erp: {
							description: 'An ERP database',
							driver: 'sqlserver',
							credential: { connection: { kind: 'text' } }
						}
					},
					automations: {
						sent: {
							description: 'A quote was sent',
							on: { updated: 'quotes', fields: ['status'], where: { status: { eq: 'sent' } } },
							runAs: ['ops']
						},
						tidy: { description: 'Internal upkeep', on: { cron: '*/15 * * * *' }, runAs: ['ops'] }
					}
				} satisfies EngineManifest;
				// `world` binds `Drivers.unavailable`: a preview's activation carries no links port
				const w = yield* world(preview, {
					tidy: () => Effect.gen(function* () {}),
					sent: () => Effect.gen(function* () {})
				});
				const quote = yield* w.act('quotes', 'create', { title: 'q' });
				if (quote.kind !== 'committed' || quote.records[0] === undefined)
					throw new Error('Missing quote');
				expect(
					yield* w.act('quotes', 'update', {
						target: quote.records[0].id,
						set: { status: 'sent' }
					})
				).toMatchObject({ kind: 'committed' });
				expect(yield* w.r.crons).toEqual([{ id: 'tidy', cron: '*/15 * * * *', zone: 'UTC' }]);
				yield* w.until(T0 + 15 * 60000);
				yield* w.r.fire('tidy', iso(T0 + 15 * 60000));
				expect(w.calls.map((call) => call.target).sort()).toEqual(['sent', 'tidy']);
				// `tidy` only read: it left no row
				expect(yield* w.sql(`SELECT DISTINCT automation FROM sys_run ORDER BY 1`)).toEqual([
					{ automation: 'sent' }
				]);
			})
	);
});

describe('event triggers (rules 49, 50)', () => {
	it.effect(
		'a created + 3d delay over many rows is written by each causing statement and wakes once per bucket',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, {
					remind: (input) =>
						Schema.decodeUnknownEffect(Schema.Struct({ ids: Schema.Array(Schema.String) }))(
							input
						).pipe(
							Effect.map((value) => ({ n: value.ids.length })),
							Effect.mapError(() => BoltError.make('badAnswer', 'guest', 'Missing ids'))
						)
				});
				// 60 quotes created 09:01:00–09:04:56 share the bucket 3 days after 09:05
				for (let i = 0; i < 60; i++) {
					yield* setNow(w, T0 + 60000 + i * 4000);
					expect(yield* w.act('quotes', 'create', { title: `q${i}` })).toMatchObject({
						kind: 'committed'
					});
				}
				expect(
					yield* w.sql(
						`SELECT count(*)::int AS n, count(DISTINCT due_at)::int AS dues, min(due_at)::text AS due FROM sys_run WHERE automation = 'remind'`
					)
				).toEqual([{ n: 60, dues: 1, due: '2026-09-28 09:05:00+00' }]);
				yield* w.until(T0 + 4 * DAY);
				expect(w.wakes).toEqual([Date.parse('2026-09-28T09:05:00Z')]);
				expect(
					w.calls.map(
						(c) =>
							Schema.decodeUnknownSync(Schema.Struct({ ids: Schema.Array(Schema.String) }))(c.input)
								.ids.length
					)
				).toEqual([60]);
			})
	);
	it.effect(
		'without delay the run is due at its exact commit; `where` and `fields` are judged once on the firing write',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, {
					sent: () => Effect.gen(function* () {}),
					gone: () => Effect.gen(function* () {}),
					remind: () => Effect.gen(function* () {})
				});
				yield* setNow(w, T0 + 17000);
				const created = yield* w.act('quotes', 'create', { title: 'a' });
				expect(created.kind).toBe('committed');
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Missing quote');
				const id = created.records[0].id;
				yield* w.act('quotes', 'update', { target: id, set: { title: 'b' } }); // status unchanged: no run
				expect(
					yield* w.sql(`SELECT count(*)::int AS n FROM sys_run WHERE automation = 'sent'`)
				).toEqual([{ n: 0 }]);
				yield* setNow(w, T0 + 23000);
				yield* w.act('quotes', 'update', { target: id, set: { status: 'sent' } });
				yield* w.act('quotes', 'delete', { target: id });
				yield* w.until(T0 + 60000);
				expect(w.wakes).toEqual([T0 + 23000]);
				const byName = Object.fromEntries(w.calls.map((c) => [c.target, c.input]));
				expect(byName['sent']).toEqual({ collection: 'quotes', ids: [id] });
				expect(byName['gone']).toMatchObject({
					collection: 'quotes',
					ids: [id],
					rows: [{ id, title: 'b', status: 'sent' }]
				});
			})
	);
	it.effect(
		'manual input.rows stay intact while deleted event pre-images retain their field masks',
		() =>
			Effect.gen(function* () {
				const scoped: EngineManifest = {
					...base,
					policies: {
						limited: {
							description: 'Read quote titles and start a manual review',
							grants: { quotes: { read: { fields: ['title'] } } },
							automations: ['review']
						}
					},
					automations: {
						review: {
							description: 'Review authored rows',
							input: {
								collection: { kind: 'text' },
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
							runAs: ['limited']
						},
						gone: {
							description: 'Inspect deleted quotes',
							on: { deleted: 'quotes' },
							runAs: ['limited']
						}
					}
				};
				const w = yield* world(scoped, {
					review: (input) => Effect.succeed(input),
					gone: (input) => Effect.succeed(input)
				});
				const member: Holder = {
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
					policies: ['limited'],
					admin: false
				};
				const manual: Json = {
					collection: 'quotes',
					rows: [
						{ id: 'supplied-row', title: 'Authored title', status: 'sent', note: 'Authored data' }
					]
				};
				const run = randomUUID();
				expect(
					yield* Context.get(w.context, Callables).start({
						automation: 'review',
						runs: [{ id: run, input: manual }],
						authority: yield* w.e.authority(member),
						bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC', params: {} }
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
				expect(yield* w.sql('SELECT state FROM sys_run WHERE id = $1', [run])).toEqual([
					{ state: 'succeeded' }
				]);

				const created = yield* w.act('quotes', 'create', {
					title: 'Readable title',
					status: 'sent'
				});
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Missing quote');
				const quote = created.records[0];
				expect(yield* w.act('quotes', 'delete', { target: quote.id })).toMatchObject({
					kind: 'committed'
				});
				yield* w.until(T0);
				expect(w.calls.find((call) => call.target === 'gone')?.input).toEqual({
					collection: 'quotes',
					ids: [quote.id],
					rows: [{ id: quote.id, revision: quote.revision, title: 'Readable title' }]
				});
				expect(yield* w.sql("SELECT state, cause FROM sys_run WHERE automation = 'gone'")).toEqual([
					{ state: 'succeeded', cause: 'deleted' }
				]);
			})
	);
});
describe('re-queues, attempts and the journal (rules 51, 54, 55, 70)', () => {
	it.effect('backend acts preserve observed revisions and cannot overwrite a newer row', () =>
		Effect.gen(function* () {
			let target = '',
				revision = 0;
			const w = yield* world(
				base,
				{
					classify: (_, ctx) =>
						Effect.gen(function* () {
							return yield* ctx.act(
								'quotes.update',
								{ target, set: { title: 'stale result' } },
								{ observed: { [target]: revision } }
							);
						})
				},
				{ start: ['classify'] }
			);
			const created = Schema.decodeUnknownSync(
				Schema.Struct({
					kind: Schema.Literal('committed'),
					records: Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Number }))
				})
			)(yield* w.act('quotes', 'create', { title: 'original' }));
			const row = created.records[0];
			if (!row)
				return yield* Effect.fail(BoltError.make('guestError', 'guest', 'Missing created quote'));
			target = row.id;
			revision = row.revision;
			yield* w.act('quotes', 'update', { target, set: { title: 'newer edit' } });
			yield* w.until(T0);
			expect(yield* w.sql('SELECT title FROM quotes WHERE id = $1', [target])).toEqual([
				{ title: 'newer edit' }
			]);
			expect(yield* w.sql("SELECT state FROM sys_run WHERE automation = 'classify'")).toEqual([
				{ state: 'failed' }
			]);
		})
	);
	it.effect(
		'a 1-minute re-queue is due at its exact time; the same key replaces; the chain ends by itself',
		() =>
			Effect.gen(function* () {
				let left = 2;
				const w = yield* world(
					base,
					{
						classify: (_, ctx) =>
							Effect.gen(function* () {
								if (left-- <= 0) return;
								yield* ctx.schedule(
									'classify',
									{},
									{ at: { now: '+1min' }, key: 'classify_retry' }
								);
								yield* ctx.schedule(
									'classify',
									{},
									{ at: { now: '+1min' }, key: 'classify_retry' }
								);
							})
					},
					{ start: ['classify'] }
				);
				yield* w.r.boot; // the seed's first admission queued one run; a second boot queues nothing
				yield* w.until(T0 + DAY);
				expect(w.wakes).toEqual([T0, T0 + 60000, T0 + 120000]);
				expect(
					yield* w.sql(`SELECT state, count(*)::int AS n FROM sys_run GROUP BY state`)
				).toEqual([{ state: 'succeeded', n: 3 }]);
			})
	);
	it.effect('only a Transient failure retries, on the same run; each effect happens once', () =>
		Effect.gen(function* () {
			const w = yield* world(
				base,
				{
					flaky: (_, ctx) =>
						Effect.gen(function* () {
							yield* ctx.act('quotes.create', { title: 'once' });
							if (!ctx.attempt.endsWith(':3'))
								return yield* Effect.fail(BoltError.make('upstream', 'guest', '502'));
							return 'done';
						})
				},
				{ start: ['flaky'] }
			);
			yield* w.until(T0 + DAY);
			expect(w.wakes).toHaveLength(3);
			expect(
				yield* w.sql(
					`SELECT state, attempts, output, jsonb_array_length(results) AS results FROM sys_run WHERE automation = 'flaky'`
				)
			).toEqual([{ state: 'succeeded', attempts: 3, output: 'done', results: 3 }]);
			expect(yield* w.sql(`SELECT count(*)::int AS n FROM quotes WHERE title = 'once'`)).toEqual([
				{ n: 1 }
			]);
		})
	);
	it.effect(
		"a retried run replays its web answer from the run's journal; the journal goes when the run completes",
		() =>
			Effect.gen(function* () {
				const kept = new Map<string, JournalEntry[]>();
				const journal: RunJournal['Service'] = {
					read: (run) => Effect.sync(() => kept.get(run) ?? []),
					write: (run, entry) =>
						Effect.sync(() => {
							kept.set(run, [...(kept.get(run) ?? []), entry]);
						}),
					clear: (run) =>
						Effect.sync(() => {
							kept.delete(run);
						})
				};
				let pages = 0;
				const seen: number[] = [];
				const w = yield* world(
					base,
					{
						flaky: (_, ctx) =>
							Effect.gen(function* () {
								const page = yield* ctx.web('https://a.test');
								seen.push([...kept.values()].flat().length);
								if (!ctx.attempt.endsWith(':2'))
									return yield* Effect.fail(BoltError.make('upstream', 'guest', '502'));
								return page;
							})
					},
					{
						start: ['flaky'],
						journal,
						web: {
							read: (url) =>
								Effect.sync(() => {
									pages++;
									return { url, title: null, text: `page ${pages}` };
								})
						}
					}
				);
				yield* w.until(T0 + DAY);
				// the page was read once: the retry got its answer from the journal, not the web
				expect(pages).toBe(1);
				expect(seen).toEqual([1, 1]);
				expect(
					yield* w.sql(`SELECT state, output FROM sys_run WHERE automation = 'flaky'`)
				).toEqual([{ state: 'succeeded', output: expect.objectContaining({ text: 'page 1' }) }]);
				expect(kept.size).toBe(0);
			})
	);
	it.effect('a run whose journal is full ends failed: journalFull', () =>
		Effect.gen(function* () {
			const w = yield* world(
				base,
				{
					flaky: (_, ctx) =>
						Effect.gen(function* () {
							yield* ctx.web('https://a.test').pipe(Effect.ignore);
							return 'done';
						})
				},
				{
					start: ['flaky'],
					journal: {
						read: () => Effect.succeed([]),
						write: () => Effect.fail(BoltError.make('journalFull', 'facility', 'full')),
						clear: () => Effect.void
					},
					web: { read: (url) => Effect.succeed({ url, title: null, text: 'page' }) }
				}
			);
			yield* w.until(T0 + DAY);
			expect(
				yield* w.sql(`SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'flaky'`)
			).toEqual([{ state: 'failed', code: 'journalFull' }]);
		})
	);
	it.effect('a notice that names no recipient is refused and writes nothing (L-BOLT-340)', () =>
		Effect.gen(function* () {
			const w = yield* world(
				base,
				{
					flaky: (_, ctx) =>
						ctx.notify({ to: [], title: 'nowhere' }).pipe(
							Effect.as('sent'),
							Effect.catch((error) => Effect.succeed(error.code))
						)
				},
				{ start: ['flaky'] }
			);
			yield* w.until(T0 + DAY);
			expect(yield* w.sql(`SELECT state, output FROM sys_run WHERE automation = 'flaky'`)).toEqual([
				{ state: 'succeeded', output: 'invalidInput' }
			]);
			expect(yield* w.sql(`SELECT count(*)::int AS n FROM sys_notification`)).toEqual([{ n: 0 }]);
		})
	);
	it.effect(
		'an automation resolves source-policy holders once across retries without granting descendants or external members',
		() =>
			Effect.gen(function* () {
				const w = yield* world(
					{ ...base, teams: { ops: ['ops'], branch: { parent: 'ops', policies: [] } } },
					{
						flaky: (_, ctx) =>
							Effect.gen(function* () {
								yield* ctx.notify({
									to: [{ policy: 'ops' }, { team: 'ops' }, { user: 'holder' }],
									title: 'For ops',
									once: 'source-policy-notice'
								});
								if (!ctx.attempt.endsWith(':3'))
									return yield* Effect.fail(BoltError.make('upstream', 'guest', '502'));
								return 'done';
							})
					},
					{ start: ['flaky'] }
				);
				yield* w.db.write({
					text: `INSERT INTO sys_user(id,name,team,active,kind) VALUES
			('holder','Holder','ops',true,'staff'), ('branch-holder','Branch','branch',true,'staff'),
			('inactive-holder','Inactive','ops',false,'staff'), ('external-holder','External','ops',true,'external')`,
					params: []
				});
				yield* w.until(T0 + DAY);
				expect(
					yield* w.sql("SELECT state, attempts FROM sys_run WHERE automation = 'flaky'")
				).toEqual([{ state: 'succeeded', attempts: 3 }]);
				expect(yield* w.sql('SELECT member,title FROM sys_notification')).toEqual([
					{ member: 'holder', title: 'For ops' }
				]);
			})
	);
	it.effect(
		'an inbox notice that reaches no member is not refused; the attempt reports it (L-BOLT-340, rule 21)',
		() =>
			Effect.gen(function* () {
				const w = yield* world(
					{ ...base, teams: { nobody: [] } },
					{
						flaky: (_, ctx) =>
							Effect.gen(function* () {
								yield* ctx.notify({ to: [{ team: 'nobody' }], title: 'unheard' });
								return 'sent';
							})
					},
					{ start: ['flaky'] }
				);
				yield* w.until(T0 + DAY);
				expect(
					yield* w.sql(
						`SELECT state, output, results->0->'warnings' AS warnings FROM sys_run WHERE automation = 'flaky'`
					)
				).toEqual([
					{ state: 'succeeded', output: 'sent', warnings: [`notify: 'unheard' reached no member`] }
				]);
				expect(yield* w.sql(`SELECT count(*)::int AS n FROM sys_notification`)).toEqual([{ n: 0 }]);
			})
	);
	it.effect('a refusal or a bug is never retried', () =>
		Effect.gen(function* () {
			const w = yield* world(
				base,
				{
					flaky: () =>
						Effect.gen(function* () {
							return yield* Effect.fail(BoltError.make('guestError', 'guest', 'bug'));
						})
				},
				{ start: ['flaky'] }
			);
			yield* w.until(T0 + DAY);
			expect(yield* w.sql(`SELECT state, attempts, error->>'code' AS code FROM sys_run`)).toEqual([
				{ state: 'failed', attempts: 1, code: 'guestError' }
			]);
		})
	);
});
describe('webhooks and visibility (rules 56, 56a)', () => {
	it.effect(
		'verifies before reading, dedupes deliveries, and acknowledges after the run row commits',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, {
					hook: (input) =>
						Effect.gen(function* () {
							return input;
						})
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
				expect(w.calls.map((c) => c.input)).toEqual([{ order: 1 }]);
				expect(
					yield* w.sql(
						`SELECT state, count(*)::int AS n FROM sys_run GROUP BY state ORDER BY state`
					)
				).toEqual([
					{ state: 'failed', n: 1 },
					{ state: 'succeeded', n: 1 }
				]);
			})
	);
	it.effect(
		'a run is readable in full by automations holders and admins; the causing actor sees status and error code only',
		() =>
			Effect.gen(function* () {
				const w = yield* world(base, {
					sent: () =>
						Effect.gen(function* () {
							return yield* Effect.fail(BoltError.make('guestError', 'guest', 'secret detail'));
						})
				});
				const member: Holder = {
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
					policies: ['ops'],
					admin: false
				};
				if (member.actor.kind !== 'member') throw new Error('Expected a member actor');
				const created = (yield* w.e.act({
					collection: 'quotes',
					mode: { _tag: 'Direct' },
					verb: 'create',
					input: { title: 'x', status: 'draft' },
					key: randomUUID(),
					issuedAt: iso(T0),
					authority: yield* w.e.authority(member),
					bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC', params: {} },
					invocationId: randomUUID()
				})).outcome;
				expect(created.kind).toBe('committed');
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Missing created quote');
				const id = created.records[0].id;
				yield* w.e.act({
					collection: 'quotes',
					mode: { _tag: 'Direct' },
					verb: 'update',
					input: { target: id, set: { status: 'sent' } },
					key: randomUUID(),
					issuedAt: iso(T0),
					authority: yield* w.e.authority(member),
					bindings: { now: iso(T0), today: '2026-09-25', tz: 'UTC', params: {} },
					invocationId: randomUUID()
				});
				yield* w.until(T0);
				const [run] = yield* w.sql(`SELECT id FROM sys_run WHERE automation = 'sent'`);
				if (run === undefined) throw new Error('Missing sent run');
				const runId = String(run['id']);
				expect(Option.getOrNull(yield* w.r.view(yield* w.e.authority(member), runId))).toEqual(
					expect.objectContaining({ status: 'failed', error: { code: 'guestError' } })
				);
				expect(
					Option.getOrNull(yield* w.r.view(yield* w.e.authority(member), runId))
				).not.toHaveProperty('input');
				const other = yield* w.e.authority({
					...member,
					actor: { ...member.actor, id: randomUUID() }
				});
				expect(Option.getOrNull(yield* w.r.view(other, runId))).toBeNull();
				const admin = yield* w.e.authority({ ...member, admin: true });
				expect(Option.getOrNull(yield* w.r.view(admin, runId))).toMatchObject({
					error: { code: 'guestError', message: 'secret detail' },
					input: { ids: [id] }
				});
			})
	);
});
describe('lanes: a long automation never holds an agent.triage decision (rules 48, 51)', () => {
	const queue = (w: World, id: string, automation: string, due: number) =>
		w.db.write({
			text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
		VALUES ($1, $2, '{"conversation":"c","waits":0}'::jsonb, $3::timestamptz, 'schedule', 0)`,
			params: [id, automation, iso(due)]
		});
	const states = (w: World) =>
		w.sql(
			`SELECT automation, state FROM sys_run WHERE automation IN ('classify', 'agent.triage') ORDER BY automation`
		);
	/** `classify` holds until `agent.triage` has run: run one after the other, the wake never ends (the test times out). */
	const gated = () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			return {
				released: Deferred.await(release),
				platform: {
					'agent.triage': () =>
						Deferred.succeed(release, undefined).pipe(Effect.as({ decided: true }))
				}
			};
		});
	it.effect('a triage due with a long automation completes while the automation still runs', () =>
		Effect.gen(function* () {
			const g = yield* gated();
			const w = yield* world(
				base,
				{
					classify: () =>
						Effect.gen(function* () {
							yield* g.released;
							return { done: true };
						})
				},
				{ platform: g.platform }
			);
			yield* queue(w, randomUUID(), 'classify', T0 - 1000); // claimed first
			yield* queue(w, randomUUID(), 'agent.triage', T0);
			yield* w.r.tick;
			expect(yield* states(w)).toEqual([
				{ automation: 'agent.triage', state: 'succeeded' },
				{ automation: 'classify', state: 'succeeded' }
			]);
		})
	);
	it.effect(
		'different workspace automations run side by side; one automation’s runs stay one at a time',
		() =>
			Effect.gen(function* () {
				const flakyStarted = yield* Deferred.make<void>();
				let running = 0,
					most = 0;
				/** `classify` holds until `flaky` has started: run one after the other, the tick never ends. */
				const w = yield* world(base, {
					classify: () =>
						Effect.gen(function* () {
							most = Math.max(most, ++running);
							yield* Deferred.await(flakyStarted);
							running -= 1;
							return { done: true };
						}),
					flaky: () => Deferred.succeed(flakyStarted, undefined).pipe(Effect.as({ done: true }))
				});
				yield* queue(w, randomUUID(), 'classify', T0 - 3000); // claimed first
				yield* queue(w, randomUUID(), 'classify', T0 - 2000);
				yield* queue(w, randomUUID(), 'flaky', T0 - 1000);
				yield* w.r.tick;
				expect(yield* w.sql(`SELECT automation, state FROM sys_run ORDER BY due_at`)).toEqual([
					{ automation: 'classify', state: 'succeeded' },
					{ automation: 'classify', state: 'succeeded' },
					{ automation: 'flaky', state: 'succeeded' }
				]);
				expect(most).toBe(1);
			})
	);
	it.effect('declared concurrency admits two overlapping runs and drains the remaining queue', () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>(),
				release = yield* Deferred.make<void>();
			let running = 0,
				most = 0;
			const w = yield* world(
				{
					...base,
					automations: {
						...base.automations,
						classify: {
							description: 'Two independent reviews',
							runAs: ['ops'],
							concurrency: { max: 2 }
						}
					}
				},
				{
					classify: () =>
						Effect.gen(function* () {
							most = Math.max(most, ++running);
							if (running === 2) yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
						}).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									running -= 1;
								})
							)
						)
				}
			);
			for (const [id, due] of [
				['first', T0 - 3000],
				['second', T0 - 2000],
				['third', T0 - 1000]
			] satisfies [string, number][])
				yield* queue(w, id, 'classify', due);
			const ticking = yield* Effect.forkChild(w.r.tick);
			yield* Deferred.await(entered);
			expect(yield* w.sql(`SELECT id, state, attempts FROM sys_run ORDER BY due_at`)).toEqual([
				{ id: 'first', state: 'running', attempts: 1 },
				{ id: 'second', state: 'running', attempts: 1 },
				{ id: 'third', state: 'queued', attempts: 0 }
			]);
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(ticking);
			expect(yield* w.sql(`SELECT id, state, attempts FROM sys_run ORDER BY due_at`)).toEqual([
				{ id: 'first', state: 'succeeded', attempts: 1 },
				{ id: 'second', state: 'succeeded', attempts: 1 },
				{ id: 'third', state: 'succeeded', attempts: 1 }
			]);
			expect(most).toBe(2);
			expect(running).toBe(0);
		})
	);
	it.effect(
		'an automation’s admitted batch holds its later runs; queued runs stay stoppable and hand off by due time',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				const order: string[] = [];
				const w = yield* world(base, {
					classify: () =>
						Effect.gen(function* () {
							order.push('classify');
							if (order.length === 1) {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							}
						}),
					flaky: () =>
						Effect.sync(() => {
							order.push('export');
						})
				});
				for (const [id, automation, due] of [
					['first', 'classify', T0 - 4000],
					['export', 'flaky', T0 - 3000],
					['second', 'classify', T0 - 2000],
					['stop', 'classify', T0 - 1000]
				] satisfies [string, string, number][])
					yield* queue(w, id, automation, due);
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				expect(
					yield* w.sql(
						`SELECT id, state, attempts, started_at IS NULL AS unstarted, leases FROM sys_run WHERE automation = 'classify' ORDER BY due_at`
					)
				).toEqual([
					{ id: 'first', state: 'running', attempts: 1, unstarted: false, leases: 0 },
					{ id: 'second', state: 'queued', attempts: 0, unstarted: true, leases: 0 },
					{ id: 'stop', state: 'queued', attempts: 0, unstarted: true, leases: 0 }
				]);
				const admin = yield* w.e.authority({
					actor: { kind: 'system', run: 'test', by: { automation: 'classify' } },
					policies: [],
					admin: true
				});
				expect(Option.getOrNull(yield* w.r.stop(admin, 'stop'))).toMatchObject({
					status: 'stopped'
				});
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(ticking);
				expect(order.toSorted()).toEqual(['classify', 'classify', 'export']);
				expect(yield* w.sql(`SELECT state, attempts FROM sys_run WHERE id = 'stop'`)).toEqual([
					{ state: 'stopped', attempts: 0 }
				]);
			})
	);
	it.effect(
		'event admission merges one compatible batch up to 10,000 IDs without claiming its backlog',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				const inputs: Json[] = [],
					order: string[] = [];
				const w = yield* world(base, {
					classify: (input) =>
						Effect.gen(function* () {
							inputs.push(input);
							order.push('classify');
							if (inputs.length === 1) {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							}
						}),
					flaky: () =>
						Effect.sync(() => {
							order.push('export');
						})
				});
				const rows = [
					{ id: 'a', cause: 'created', collection: 'quotes', size: 6000, due: T0 - 5000 },
					{ id: 'b', cause: 'created', collection: 'quotes', size: 4000, due: T0 - 4000 },
					{ id: 'c', cause: 'created', collection: 'quotes', size: 1, due: T0 - 2000 },
					{ id: 'd', cause: 'created', collection: 'other', size: 1, due: T0 - 1000 },
					{ id: 'e', cause: 'updated', collection: 'quotes', size: 1, due: T0 }
				].map((row) => ({
					...row,
					due: iso(row.due),
					input: {
						collection: row.collection,
						ids: Array.from({ length: row.size }, (_, i) => `${row.id}${i}`)
					}
				}));
				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT id, 'classify', input, due::timestamptz, cause, 0 FROM jsonb_to_recordset($1::jsonb) x(id text, input jsonb, due text, cause text)`,
					params: [JSON.stringify(rows)]
				});
				yield* queue(w, 'export', 'flaky', T0 - 3000);
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				expect(yield* w.sql(`SELECT id, state, attempts FROM sys_run ORDER BY due_at`)).toEqual([
					{ id: 'a', state: 'running', attempts: 1 },
					{ id: 'b', state: 'running', attempts: 1 },
					{ id: 'export', state: 'queued', attempts: 0 },
					{ id: 'c', state: 'queued', attempts: 0 },
					{ id: 'd', state: 'queued', attempts: 0 },
					{ id: 'e', state: 'queued', attempts: 0 }
				]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(ticking);
				const [first, second, third, fourth, fifth] = rows;
				if (
					first === undefined ||
					second === undefined ||
					third === undefined ||
					fourth === undefined ||
					fifth === undefined
				)
					throw new Error('Missing event fixture');
				expect(inputs).toEqual([
					{ collection: 'quotes', ids: [...first.input.ids, ...second.input.ids] },
					third.input,
					fourth.input,
					fifth.input
				]);
				expect(order).toEqual(['classify', 'export', 'classify', 'classify', 'classify']);
			})
	);
	it.effect(
		'generation interruption recovers the admitted run without spending a queued run lease',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				const w = yield* world(base, {
					classify: () =>
						Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
				});
				yield* queue(w, 'first', 'classify', T0 - 2000);
				yield* queue(w, 'second', 'classify', T0 - 1000);
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(ticking);
				expect(
					yield* w.sql(
						`SELECT id, state, attempts, leases, error->>'code' AS code FROM sys_run ORDER BY id`
					)
				).toEqual([
					{ id: 'first', state: 'running', attempts: 1, leases: 0, code: 'interrupted' },
					{ id: 'second', state: 'queued', attempts: 0, leases: 0, code: null }
				]);
				yield* Deferred.succeed(release, undefined);
				yield* w.r.boot;
				yield* w.r.tick;
				expect(yield* w.sql(`SELECT id, state, attempts, leases FROM sys_run ORDER BY id`)).toEqual(
					[
						{ id: 'first', state: 'succeeded', attempts: 2, leases: 1 },
						{ id: 'second', state: 'succeeded', attempts: 1, leases: 0 }
					]
				);
			})
	);
	it.effect(
		'an interrupted inference restores one conversation and its durable transcript without repeating a tool turn',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				let calls = 0;
				const ai: Ai['Service'] = {
					ask: respondSystem1,
					maxChoices: undefined,
					models: ['default'],
					catalog: Effect.succeed({
						models: [{ id: 'default', label: 'Default' }],
						default: 'default'
					}),
					embed: () => Port.unavailable('ai.embed'),
					infer: () =>
						Stream.unwrap(
							Effect.sync(() => {
								if (++calls === 2)
									return Stream.unwrap(
										Deferred.succeed(entered, undefined).pipe(Effect.as(Stream.never))
									);
								return Stream.succeed({
									_tag: 'Response' as const,
									response: {
										content: '',
										toolCalls:
											calls === 1
												? [{ id: 'edit', name: 'edit', input: { ops: [{ path: '/n', set: 3 }] } }]
												: [{ id: 'submit', name: 'submit', input: {} }],
										finish: 'tool' as const,
										usage: { input: 1, output: 1 }
									}
								});
							})
						)
				};
				const w = yield* world(
					base,
					{
						classify: (_, ctx) =>
							ctx.infer({
								prompt: 'Count the items',
								output: { kind: 'object', fields: { n: { kind: 'int' } } }
							})
					},
					{ ai }
				);
				yield* queue(w, 'research', 'classify', T0);
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(ticking);
				const [before] = yield* w.sql('SELECT id FROM sys_conversation WHERE run = $1', [
					'research'
				]);
				// A lost transcript write is restored from the journal; an uncommitted tail is discarded.
				yield* w.sql("DELETE FROM sys_message WHERE conversation = $1 AND role = 'user'", [
					String(before?.['id'])
				]);
				yield* w.sql(
					`INSERT INTO sys_message (id, conversation, role, content) VALUES ('inflight', $1, 'assistant', '"unfinished"'::jsonb)`,
					[String(before?.['id'])]
				);
				yield* w.r.boot;
				yield* w.r.tick;
				expect(calls).toBe(3);
				expect(
					yield* w.sql('SELECT id, status FROM sys_conversation WHERE run = $1', ['research'])
				).toEqual([{ id: before?.['id'], status: 'idle' }]);
				expect(
					yield* w.sql('SELECT role FROM sys_message WHERE conversation = $1 ORDER BY seq', [
						String(before?.['id'])
					])
				).toEqual([
					{ role: 'user' },
					{ role: 'assistant' },
					{ role: 'tool' },
					{ role: 'assistant' }
				]);
				expect(
					yield* w.sql('SELECT state, output FROM sys_run WHERE id = $1', ['research'])
				).toEqual([{ state: 'succeeded', output: { n: 3 } }]);
			})
	);
	it.effect(
		'a custom admission evaluates its bounded batch once across queued and finished history',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const w = yield* world(base, {
					classify: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
				});
				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, finished_at) SELECT 'finished-' || g, 'classify', '{}'::jsonb, $1::timestamptz, 'schedule', 0, 'succeeded', $1::timestamptz FROM generate_series(1, 8000) g`,
					params: [iso(T0)]
				});
				yield* w.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT 'pending-' || g, CASE WHEN g <= 30 THEN 'classify' ELSE 'flaky' END, CASE WHEN g <= 30 THEN jsonb_build_object('collection', 'quotes', 'ids', jsonb_build_array(g::text)) ELSE '{}'::jsonb END, CASE WHEN g <= 30 THEN $1::timestamptz ELSE $2::timestamptz END, CASE WHEN g <= 30 THEN 'created' ELSE 'schedule' END, 0 FROM generate_series(1, 60) g`,
					params: [iso(T0 - 2000), iso(T0 - 1000)]
				});
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(entered);
				const admission = w.statements.find((statement) => statement.text.includes('head AS ('));
				if (admission === undefined) throw new Error('Missing custom admission statement');
				yield* Fiber.interrupt(ticking);
				yield* w.r.boot;
				const [row] = yield* w.sql(`EXPLAIN (ANALYZE TRUE, FORMAT JSON) ${admission.text}`, [
					...admission.params
				]);
				const plans = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ Plan: Schema.Json })))(
					row?.['QUERY PLAN']
				);
				const loops: number[] = [];
				const visit = (node: Json) => {
					const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
						node
					);
					if (Option.isNone(record)) return;
					if (record.value['Node Type'] === 'WindowAgg')
						loops.push(Schema.decodeUnknownSync(Schema.Number)(record.value['Actual Loops']));
					const children = record.value['Plans'];
					if (Array.isArray(children)) children.forEach(visit);
				};
				for (const plan of plans) visit(plan.Plan);
				expect(loops).toEqual([1]);
			})
	);
	it.effect(
		'an immediate custom continuation drains while a platform run still holds the open tick',
		() =>
			Effect.gen(function* () {
				const scheduled = yield* Deferred.make<void>(),
					finish = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>(),
					continued = yield* Deferred.make<void>();
				let calls = 0,
					before = 0;
				const claims = () =>
					w.statements.filter((statement) =>
						statement.text.includes("UPDATE sys_run s SET state = 'running'")
					).length;
				const w: World = yield* world(
					base,
					{
						classify: (_, ctx) =>
							Effect.gen(function* () {
								if (++calls > 1) {
									yield* Deferred.succeed(continued, undefined);
									return;
								}
								before = claims();
								yield* ctx.schedule('classify', {}, { at: iso(T0), key: 'continuation' });
								yield* Deferred.succeed(scheduled, undefined);
								yield* Deferred.await(finish);
							})
					},
					{
						platform: {
							'agent.triage': () => Deferred.await(release).pipe(Effect.as({ done: true }))
						}
					}
				);
				yield* queue(w, 'platform', 'agent.triage', T0);
				yield* queue(w, 'first', 'classify', T0);
				const ticking = yield* Effect.forkChild(w.r.tick);
				yield* Deferred.await(scheduled);
				while (claims() <= before) yield* Effect.yieldNow;
				yield* w.sql('SELECT 1 AS barrier');
				yield* Deferred.succeed(finish, undefined);
				yield* Deferred.await(continued);
				expect(yield* w.sql(`SELECT state FROM sys_run WHERE id = 'platform'`)).toEqual([
					{ state: 'running' }
				]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(ticking);
				expect(calls).toBe(2);
			})
	);
	it.effect('a triage queued while the long automation runs is claimed by the open wake', () =>
		Effect.gen(function* () {
			const g = yield* gated();
			const w: World = yield* world(
				base,
				{
					classify: () =>
						Effect.gen(function* () {
							yield* queue(w, randomUUID(), 'agent.triage', w.clock.ms);
							yield* w.r.nudge(iso(w.clock.ms));
							yield* g.released;
							return { done: true };
						})
				},
				{ platform: g.platform }
			);
			yield* queue(w, randomUUID(), 'classify', T0);
			yield* w.r.tick;
			expect(yield* states(w)).toEqual([
				{ automation: 'agent.triage', state: 'succeeded' },
				{ automation: 'classify', state: 'succeeded' }
			]);
		})
	);
});
