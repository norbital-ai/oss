// The model idle wall preserves partial text and identifies a cut tool call separately from no output; the
// administrator's System 1 and System 2 picks reach every decision and model class.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result, Stream } from 'effect';
import { type AiRequest, type DecisionRequest, Unavailable } from '@norbital-ai/host-api';
import { infer_facility, modelCall } from '../src/engine/agent/ai.ts';
import { AdminAi, SpendActor, type AgentSettings, SYSTEM_AGENTS } from '../src/engine/agent/settings.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Ai } from '../src/engine/ports.ts';
import type { AiEvent } from '@norbital-ai/host-api';
import { clock_probe } from './support/clock-probe.ts';

const request = { model: 'default', system: '', messages: [] };
const atWall = (events: readonly AiEvent[]) =>
	Effect.gen(function* () {
		const unused = () => Effect.fail(new Unavailable({ facility: 'ai', reason: 'unused' }));
		const ai: Ai['Service'] = {
			ask: unused,
			embed: unused,
			models: ['default'],
			maxChoices: undefined,
			deciders: Effect.succeed({ models: [], default: '' }),
			catalog: Effect.succeed({ models: [], default: 'default' }),
			infer: () => Stream.concat(Stream.fromIterable(events), Stream.fromEffect(Effect.never))
		};
		return yield* clock_probe(modelCall(ai, request, { wallMs: 20 }).pipe(Effect.result), 21);
	});

describe('modelCall at its wall', () => {
	it.effect('text so far: a cut step', () =>
		Effect.gen(function* () {
			const result = yield* atWall([{ _tag: 'Delta', text: 'partial' }]);
			expect(Result.getOrThrow(result)).toMatchObject({ finish: 'cut', content: 'partial' });
		})
	);
	it.effect('only a tool call in progress: cutTool', () =>
		Effect.gen(function* () {
			const result = yield* atWall([{ _tag: 'Progress', reasoning: undefined }]);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result))
				expect(result.failure).toMatchObject({ kind: 'timeout', cutTool: true });
		})
	);
	it.effect('nothing at all: yielded nothing', () =>
		Effect.gen(function* () {
			const result = yield* atWall([]);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure).toMatchObject({ kind: 'timeout' });
				expect('cutTool' in result.failure).toBe(false);
			}
		})
	);
});

describe("the administrator's System 1 and System 2", () => {
	const listing = (...ids: string[]) =>
		Effect.succeed({ models: ids.map((id) => ({ id, label: id })), default: ids[0] ?? '' });
	/** The host's AI under `settings`, recording the model each decision and inference was asked with. */
	const under = (settings: { system1: string | null; system2: string | null }) => {
		const asked: (string | undefined)[] = [],
			inferred: string[] = [];
		const host = Layer.succeed(Ai, {
			ask: (_request, model) =>
				Effect.sync(() => {
					asked.push(model);
					return { answers: {}, cost_usd: 0, provider: 'p' };
				}),
			maxChoices: undefined,
			deciders: listing('jev', 'fast-1'),
			models: ['default', 'strong'],
			catalog: listing('big-1', 'big-2'),
			embed: () => Effect.fail(new Unavailable({ facility: 'ai', reason: 'unused' })),
			infer: (request) => {
				inferred.push(request.model);
				return Stream.empty;
			}
		});
		const db = Layer.succeed(
			TenantDb,
			TenantDb.typed({
				read: (statements) =>
					Effect.succeed(
						statements.map(() => ({
							rows: [{ value: JSON.stringify({ monthly: null, member: null, models: [], ...settings }) }],
							affected: 1
						}))
					),
				write: () => Effect.succeed({ rows: [], affected: 0 }),
				transaction: () => Effect.succeed([])
			})
		);
		const decision: DecisionRequest = { state: 's', questions: { q: { type: 'noul' } } };
		const run = (request: AiRequest) =>
			Effect.gen(function* () {
				const ai = yield* Ai;
				yield* ai.ask(decision);
				yield* ai.ask(decision, 'named');
				yield* Stream.runDrain(ai.infer(request));
				return { asked, inferred };
			}).pipe(Effect.provide(AdminAi.pipe(Layer.provide(Layer.merge(host, db)))));
		return run;
	};
	it.effect('decisions run on System 1, every model class on System 2; a named model goes as is', () =>
		Effect.gen(function* () {
			const run = under({ system1: 'fast-1', system2: 'big-2' });
			expect(yield* run({ model: 'strong', messages: [] })).toEqual({
				asked: ['fast-1', 'named'],
				inferred: ['big-2']
			});
			expect((yield* run({ model: 'big-1', messages: [] })).inferred).toEqual(['big-2', 'big-1']);
		})
	);
	it.effect("a pick the provider no longer lists, or none, leaves the host's own", () =>
		Effect.gen(function* () {
			expect(yield* under({ system1: 'gone', system2: 'gone' })({ model: 'default', messages: [] })).toEqual({
				asked: [undefined, 'named'],
				inferred: ['default']
			});
			expect(yield* under({ system1: null, system2: null })({ model: 'default', messages: [] })).toEqual({
				asked: [undefined, 'named'],
				inferred: ['default']
			});
		})
	);

	it.effect('routes fast, default, and strong model classes distinctly without flattening to one model', () =>
		Effect.gen(function* () {
			const inferred: string[] = [];
			const runWith = (
				settings: Partial<AgentSettings>,
				models: { readonly deciders: readonly string[]; readonly catalog: readonly string[] }
			) => {
				inferred.length = 0;
				const host = Layer.succeed(Ai, {
					ask: () => Effect.succeed({ answers: {}, cost_usd: 0, provider: 'p' }),
					maxChoices: undefined,
					deciders: listing(...models.deciders),
					models: ['fast', 'default', 'strong'],
					catalog: listing(...models.catalog),
					embed: () => Effect.succeed([[1, 2]]),
					infer: (req) => {
						inferred.push(req.model);
						return Stream.empty;
					}
				});
				const db = Layer.succeed(
					TenantDb,
					TenantDb.typed({
						read: (statements) =>
							Effect.succeed(
								statements.map(() => ({
									rows: [
										{
											value: JSON.stringify({
												monthly: null,
												member: null,
												policies: {},
												models: [],
												system1: null,
												system2: null,
												...settings
											})
										}
									],
									affected: 1
								}))
							),
						write: () => Effect.succeed({ rows: [], affected: 0 }),
						transaction: () => Effect.succeed([])
					})
				);
				return Effect.gen(function* () {
					const ai = yield* Ai;
					yield* Stream.runDrain(ai.infer({ model: 'fast', messages: [] }));
					yield* Stream.runDrain(ai.infer({ model: 'default', messages: [] }));
					yield* Stream.runDrain(ai.infer({ model: 'strong', messages: [] }));
					yield* Stream.runDrain(ai.infer({ model: 'custom/explicit', messages: [] }));
					return [...inferred];
				}).pipe(Effect.provide(AdminAi.pipe(Layer.provide(Layer.merge(host, db)))));
			};

			// Explicit system1 + system2 + strong override: each class routes to its own model
			expect(
				yield* runWith(
					{ system1: 'fast-1', system2: 'mid-2', strong: 'opus-3' },
					{ deciders: ['jev', 'fast-1'], catalog: ['fast-1', 'mid-2', 'opus-3'] }
				)
			).toEqual(['fast-1', 'mid-2', 'opus-3', 'custom/explicit']);

			// Without strong override, strong falls back to system2; without system1 pick, fast uses host decider in catalog
			expect(
				yield* runWith(
					{ system1: null, system2: 'mid-2' },
					{ deciders: ['jev', 'fast-host'], catalog: ['fast-host', 'mid-2'] }
				)
			).toEqual(['fast-host', 'mid-2', 'mid-2', 'custom/explicit']);

			// When no decider is in the chat catalog, fast stays 'fast' (never flattened to system2)
			expect(
				yield* runWith(
					{ system1: null, system2: 'mid-2' },
					{ deciders: ['jev'], catalog: ['mid-2'] }
				)
			).toEqual(['fast', 'mid-2', 'mid-2', 'custom/explicit']);
		})
	);
});

describe('monthly spend caps and accounting across infer_facility, sys_1, and embed', () => {
	const makeSpendHarness = (settings: AgentSettings) => {
		let workspaceSpend = 0;
		const memberSpend = new Map<string, number>();
		const calls = { ask: 0, infer: 0, embed: 0 };
		const db = Layer.succeed(
			TenantDb,
			TenantDb.typed({
				read: (statements) =>
					Effect.sync(() =>
						statements.map((stmt) => {
							if (stmt.text.includes("WHERE key = 'agent'"))
								return { rows: [{ value: JSON.stringify(settings) }], affected: 1 };
							const member = stmt.params[0];
							const total = typeof member === 'string' ? (memberSpend.get(member) ?? 0) : workspaceSpend;
							return { rows: [{ sum: total }], affected: 1 };
						})
					),
				write: (stmt) =>
					Effect.sync(() => {
						const cost = Number(stmt.params[0] ?? 0);
						const member = stmt.params[1];
						if (typeof member === 'string')
							memberSpend.set(member, (memberSpend.get(member) ?? 0) + cost);
						else workspaceSpend += cost;
						return { rows: [], affected: 1 };
					}),
				transaction: () => Effect.succeed([])
			})
		);
		const host = Layer.succeed(Ai, {
			ask: () =>
				Effect.sync(() => {
					calls.ask++;
					return { answers: {}, cost_usd: 0.6, provider: 'p' };
				}),
			maxChoices: undefined,
			deciders: Effect.succeed({ models: [], default: '' }),
			models: ['fast', 'default', 'strong'],
			catalog: Effect.succeed({ models: [], default: 'default' }),
			embed: () =>
				Effect.sync(() => {
					calls.embed++;
					return [[0.1, 0.2]];
				}),
			infer: (req) => {
				calls.infer++;
				return Stream.succeed<AiEvent>({
					_tag: 'Response',
					response: {
						content: req.purpose === 'chat' ? 'chat-ok' : 'infer-ok',
						tool_calls: [],
						finish: 'stop',
						usage: { input: 10, output: 5, cost: 0.5 }
					}
				});
			}
		});
		return {
			layer: AdminAi.pipe(Layer.provide(Layer.merge(host, db))),
			calls,
			spent: () => ({ workspace: workspaceSpend, members: Object.fromEntries(memberSpend) })
		};
	};

	it.effect('records sys_1 and infer_facility spend and blocks subsequent sys_1, infer_facility, and embed calls at workspace cap', () =>
		Effect.gen(function* () {
			const harness = makeSpendHarness({
				monthly: 1.0,
				member: null,
				policies: {},
				models: [],
				system1: null,
				system2: null,
				system: SYSTEM_AGENTS
			});
			yield* Effect.gen(function* () {
				const ai = yield* Ai;
				const decision: DecisionRequest = { state: 's', questions: { q: { type: 'noul' } } };
				// 1. sys_1 call succeeds and records $0.60
				yield* ai.ask(decision);
				expect(harness.spent().workspace).toBeCloseTo(0.6);
				// 2. infer_facility call succeeds and records $0.50 -> total $1.10 >= $1.00 cap
				const infer = infer_facility(ai);
				expect(yield* infer({ _tag: 'ai.sys_2.infer', args: [{ prompt: 'hi' }] })).toEqual({
					ok: true,
					value: 'infer-ok'
				});
				expect(harness.spent().workspace).toBeCloseTo(1.1);
				// 3. Subsequent sys_1, infer_facility, and embed calls are all blocked without reaching host
				const askBlocked = yield* Effect.flip(ai.ask(decision));
				expect(askBlocked).toMatchObject({ kind: 'invalid', message: expect.stringContaining('spending limit') });
				const inferBlocked = yield* infer({ _tag: 'ai.sys_2.infer', args: [{ prompt: 'again' }] });
				expect(inferBlocked).toMatchObject({ ok: false, error: { kind: 'invalid', message: expect.stringContaining('spending limit') } });
				const embedBlocked = yield* Effect.flip(ai.embed(['hello'], 'default'));
				expect(embedBlocked).toMatchObject({ kind: 'invalid', message: expect.stringContaining('spending limit') });
				expect(harness.calls).toEqual({ ask: 1, infer: 1, embed: 0 });
			}).pipe(Effect.provide(harness.layer));
		})
	);

	it.effect('enforces member caps via SpendActor and does not double-count chat purpose calls', () =>
		Effect.gen(function* () {
			const harness = makeSpendHarness({
				monthly: 10,
				member: 0.5,
				policies: {},
				models: [],
				system1: null,
				system2: null,
				system: SYSTEM_AGENTS
			});
			yield* Effect.gen(function* () {
				const ai = yield* Ai;
				// Chat purpose calls are accounted by sys_message, not double-recorded in facility spend
				yield* Stream.runDrain(ai.infer({ model: 'default', purpose: 'chat', messages: [] }));
				expect(harness.spent().workspace).toBe(0);
				// Member-attributed facility infer records $0.50 for alice, tripping alice's $0.50 cap
				const infer = infer_facility(ai);
				expect(
					yield* infer({ _tag: 'ai.sys_2.infer', args: [{ prompt: 'hi' }] }).pipe(
						Effect.provideService(SpendActor, { member: 'alice', policies: [] })
					)
				).toEqual({ ok: true, value: 'infer-ok' });
				expect(harness.spent().members['alice']).toBeCloseTo(0.5);
				// Alice is now blocked on embed while Bob still succeeds
				const aliceBlocked = yield* Effect.flip(
					ai.embed(['hello'], 'default').pipe(
						Effect.provideService(SpendActor, { member: 'alice', policies: [] })
					)
				);
				expect(aliceBlocked).toMatchObject({ kind: 'invalid', message: expect.stringContaining('member') });
				const bobOk = yield* ai.embed(['hello'], 'default').pipe(
					Effect.provideService(SpendActor, { member: 'bob', policies: [] })
				);
				expect(bobOk).toEqual([[0.1, 0.2]]);
			}).pipe(Effect.provide(harness.layer));
		})
	);
});
