// bolt-server's self-host adapters: configuration, sealed secrets, deadlines and FIFO admission.
import { describe, expect, it, vi } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import {
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schema,
	Scope,
	Stream
} from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/http';
import {
	DeadlinePort,
	inProcessDeadlines,
	Keys,
	Port,
	Secrets,
	TenantDb
} from '@norbital-ai/bolt/engine';
import { nodePorts, PgliteDb } from '@norbital-ai/bolt/node';
import { BoltConfig, ConfigError, type StartFlags } from '../src/config.ts';
import { main } from '../src/main.ts';
import { openAi } from '../src/ports.ts';
import { envelope } from '../src/envelope.ts';

const config = (values: Readonly<Record<string, string | undefined>>, flags: StartFlags = {}) =>
	BoltConfig(flags).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))));
class WorkFailed extends Schema.TaggedError<WorkFailed>()('WorkFailed', {
	message: Schema.String
}) {}
const client = (fetch: typeof globalThis.fetch) =>
	FetchHttpClient.layer.pipe(
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
		Layer.merge(NodeCrypto.layer)
	);

describe('bolt start configuration (§5.11.6)', () => {
	const base = {
		BOLT_ARTIFACT: '/a',
		BOLT_PUBLIC_URL: 'https://acme.example',
		BOLT_PGLITE_DIR: '/db',
		BOLT_AUDIT_DIR: '/audit'
	};
	it.effect('accepts a complete host Google OAuth client and refuses either missing half', () =>
		Effect.gen(function* () {
			expect((yield* config(base)).googleOAuth).toBeNull();
			const google = {
				BOLT_GOOGLE_OAUTH_CLIENT_ID: 'google-client',
				BOLT_GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret'
			};
			expect((yield* config({ ...base, ...google })).googleOAuth).toEqual({
				id: 'google-client',
				secret: 'google-secret'
			});
			for (const [name, value] of Object.entries(google))
				expect((yield* Effect.flip(config({ ...base, [name]: value }))).message).toMatch(
					/set both BOLT_GOOGLE_OAUTH_CLIENT_ID and BOLT_GOOGLE_OAUTH_CLIENT_SECRET/
				);
		})
	);
	it.effect('decodes the defaults and the flags', () =>
		Effect.gen(function* () {
			const c = yield* config(base, {
				trustProxy: '10.0.0.0/8,::1',
				founder: 'a@b.example',
				seed: './pack'
			});
			expect(c).toMatchObject({
				host: '127.0.0.1',
				port: 3100,
				database: { pglite: '/db' },
				auditDir: '/audit',
				publicUrl: 'https://acme.example',
				files: null,
				transactional: null,
				trustProxy: ['10.0.0.0/8', '::1'],
				founder: 'a@b.example',
				seed: './pack',
				environment: null,
				apns: {}
			});
			expect((yield* config({ ...base, BOLT_ENVIRONMENT: 'staging' })).environment).toBe('staging');
		})
	);
	it.effect.each([
		{ env: { ...base, BOLT_SERVER_PORT: '1' }, message: /unknown configuration: BOLT_SERVER_PORT/ },
		{ env: { ...base, BOLT_APNS_KEYS: '{"TEAM":{}}' }, message: /BOLT_APNS_KEYS does not match/ },
		{ env: { ...base, BOLT_DATABASE_URL: 'postgres://x' }, message: /exactly one/ },
		{ env: { ...base, BOLT_AUDIT_DIR: undefined }, message: /BOLT_AUDIT_DIR is required/ },
		{ env: { ...base, BOLT_AUDIT_DIR: '/db/.' }, message: /must be separate/ },
		{
			env: { BOLT_ARTIFACT: '/a', BOLT_PUBLIC_URL: 'https://acme.example' },
			message: /exactly one/
		},
		{ env: { ...base, BOLT_PUBLIC_URL: 'http://acme.example' }, message: /https/ },
		{ env: { ...base, BOLT_PUBLIC_URL: 'https://acme.example/app' }, message: /no path/ },
		{ env: { ...base, BOLT_MASTER_KEY: 'short' }, message: /32-byte/ },
		{ env: { ...base, BOLT_AI_SYS_2_PROVIDER: 'anthropic' }, message: /not registered/ },
		{ env: { ...base, BOLT_FILES_PROVIDER: 'local' }, message: /BOLT_FILES_ENDPOINT/ },
		{
			env: { BOLT_PUBLIC_URL: 'https://acme.example', BOLT_PGLITE_DIR: '/db' },
			message: /BOLT_ARTIFACT/
		}
	])('refuses to start: $env', ({ env, message }) =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(config(env));
			expect(error).toBeInstanceOf(ConfigError);
			expect(error).toMatchObject({ message: expect.stringMatching(message) });
		})
	);
	it.effect('accepts a loopback http origin and refuses a bad flag', () =>
		Effect.gen(function* () {
			expect(
				(yield* config({ ...base, BOLT_PUBLIC_URL: 'http://app.localhost:5173' })).publicUrl
			).toBe('http://app.localhost:5173');
			expect(yield* Effect.flip(config(base, { trustProxy: 'nope' }))).toMatchObject({
				message: expect.stringMatching(/CIDR/)
			});
			expect(yield* main(['--port=invalid']).pipe(Effect.provide(NodeServices.layer))).toBe(2);
			expect(yield* main(['--accept']).pipe(Effect.provide(NodeServices.layer))).toBe(2);
		})
	);
});

describe('sealed secrets (§5.11.4)', () => {
	it.live(
		'stores envelopes a copied row cannot open, answers status without a key, refuses undeclared names',
		() =>
			Effect.gen(function* () {
				const db = yield* TenantDb;
				yield* db.write({
					text: 'CREATE TABLE sys_config (key text PRIMARY KEY, value text NOT NULL)',
					params: []
				});
				const context = yield* Layer.build(
					Secrets.layer(['ERP_TOKEN', 'BASE']).pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(TenantDb, db),
								Keys.fromAbi((yield* nodePorts({ secretsKey: new Uint8Array(32).fill(7) })).keys)
							)
						)
					)
				);
				const s = Context.get(context, Secrets);
				yield* s.set('workspace', 'ERP_TOKEN', 'tok');
				yield* s.set('user-1', 'google', 'refresh');
				const row = (key: string) =>
					db.value(Schema.String, {
						text: 'SELECT value FROM sys_config WHERE key = $1',
						params: [key]
					});
				const workspace = yield* row('secret:workspace:ERP_TOKEN'),
					user = yield* row('secret:user-1:google');
				expect(yield* s.open('workspace', 'ERP_TOKEN', workspace)).toEqual(Option.some('tok'));
				expect(
					yield* Config.String('ERP_TOKEN').pipe(Effect.provide(ConfigProvider.layer(s.config)))
				).toBe('tok');
				expect(yield* Effect.flip(s.set('workspace', 'OTHER', 'x'))).toMatchObject({
					message: expect.stringMatching(/declared/)
				});
				expect(yield* s.open('user-1', 'google', user)).toEqual(Option.some('refresh'));
				expect(yield* s.open('user-2', 'google', user)).toEqual(Option.none());
				expect(workspace).not.toContain('tok');
				const keylessContext = yield* Layer.build(
					Secrets.layer(['ERP_TOKEN', 'BASE']).pipe(
						Layer.provide(Layer.mergeAll(Layer.succeed(TenantDb, db), Keys.unavailable))
					)
				);
				const keyless = Context.get(keylessContext, Secrets);
				expect(yield* keyless.status('workspace')).toEqual({ ERP_TOKEN: true, BASE: false });
				expect(yield* Effect.flip(keyless.set('workspace', 'ERP_TOKEN', 'x'))).toMatchObject({
					message: expect.stringMatching(/secrets key/)
				});
			}).pipe(Effect.provide(PgliteDb.layer()))
	);
});

describe('the in-process timekeeper and the envelope (rules 52a, 71)', () => {
	it.effect('wakes a scope once at its earliest announcement and takes the settled answer', () =>
		Effect.gen(function* () {
			const woke: string[] = [];
			let dk: DeadlinePort['Service'] | undefined;
			const context = yield* Layer.build(
				inProcessDeadlines((scope) =>
					Effect.gen(function* () {
						woke.push(scope);
						if (woke.length === 1) {
							if (dk === undefined) throw new Error('deadline layer has not opened');
							yield* dk.settle(scope, new Date(30).toISOString());
						}
					})
				)
			);
			dk = Context.get(context, DeadlinePort);
			yield* dk.announce('ws', new Date(40).toISOString());
			yield* dk.announce('ws', new Date(10).toISOString());
			yield* dk.announce('ws', new Date(60).toISOString());
			yield* TestClock.adjust('9 millis');
			expect(woke).toEqual([]);
			yield* TestClock.adjust('1 millis');
			expect(woke).toEqual(['ws']);
			yield* TestClock.adjust('20 millis');
			expect(woke).toEqual(['ws', 'ws']);
			yield* TestClock.adjust('1 second');
			expect(woke).toEqual(['ws', 'ws']);
		})
	);
	it.effect(
		'stays silent about a wake that a stop interrupted, and never wakes again (rule 71a)',
		() =>
			Effect.gen(function* () {
				const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						errors.mockRestore();
					})
				);
				let calls = 0,
					released = false;
				const scope = yield* Scope.make();
				yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
				const context = yield* Layer.build(
					inProcessDeadlines(() =>
						Effect.sync(() => {
							calls++;
						}).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Effect.sync(() => {
									released = true;
								})
							)
						)
					)
				).pipe(Scope.provide(scope));
				const dk = Context.get(context, DeadlinePort);
				yield* dk.announce('ws', new Date(1).toISOString());
				yield* TestClock.adjust('1 millis');
				expect(calls).toBe(1);
				yield* Scope.close(scope, Exit.void);
				yield* TestClock.adjust('1 second');
				expect([calls, released]).toEqual([1, true]);
				expect(errors).not.toHaveBeenCalled();
			})
	);
	it.effect('admits FIFO under the limit, request-path work ahead of automations', () =>
		Effect.gen(function* () {
			const admit = yield* envelope(1),
				release = yield* Deferred.make<void>(),
				entered = yield* Deferred.make<void>();
			const order: string[] = [];
			const first = yield* admit
				.admit(
					0,
					Effect.sync(() => {
						order.push('a');
					}).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release))
					)
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			const automation = yield* admit
				.admit(
					1,
					Effect.sync(() => {
						order.push('automation');
					})
				)
				.pipe(Effect.forkChild);
			const request = yield* admit
				.admit(
					0,
					Effect.sync(() => {
						order.push('request');
					})
				)
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			expect(order).toEqual(['a']);
			yield* Deferred.succeed(release, undefined);
			yield* Effect.all([Fiber.join(first), Fiber.join(automation), Fiber.join(request)]);
			expect(order).toEqual(['a', 'request', 'automation']);
		})
	);
	it.effect(
		'releases failed work with its original error and retains FIFO within both priority lanes',
		() =>
			Effect.gen(function* () {
				const admit = yield* envelope(1),
					first = yield* Deferred.make<void, WorkFailed>();
				const error = new WorkFailed({ message: 'native failure' }),
					order: string[] = [];
				const failed = yield* Effect.flip(admit.admit(0, Deferred.await(first))).pipe(
					Effect.forkChild
				);
				const tasks = yield* Effect.forEach(
					[
						{ lane: 1, name: 'automation 1' },
						{ lane: 0, name: 'request 1' },
						{ lane: 1, name: 'automation 2' },
						{ lane: 0, name: 'request 2' }
					] satisfies readonly { lane: 0 | 1; name: string }[],
					({ lane, name }) =>
						admit
							.admit(
								lane,
								Effect.sync(() => {
									order.push(name);
								})
							)
							.pipe(Effect.forkChild)
				);
				yield* Effect.yieldNow;
				yield* Deferred.fail(first, error);
				expect(yield* Fiber.join(failed)).toBe(error);
				yield* Effect.forEach(tasks, Fiber.join);
				expect(order).toEqual(['request 1', 'request 2', 'automation 1', 'automation 2']);
				expect(yield* admit.drain(100)).toBe(true);
			})
	);
	it.effect('sheds both lanes while draining all admitted slots', () =>
		Effect.gen(function* () {
			const admit = yield* envelope(2),
				a = yield* Deferred.make<void>(),
				b = yield* Deferred.make<void>();
			const active = yield* Effect.all([
				admit.admit(0, Deferred.await(a)).pipe(Effect.forkChild),
				admit.admit(1, Deferred.await(b)).pipe(Effect.forkChild)
			]);
			const request = yield* Effect.flip(admit.admit(0, Effect.succeed('queued'))).pipe(
				Effect.forkChild
			);
			const automation = yield* Effect.flip(admit.admit(1, Effect.succeed('queued'))).pipe(
				Effect.forkChild
			);
			yield* Effect.yieldNow;
			const drained = yield* admit.drain(1000).pipe(Effect.forkChild);
			expect(yield* Fiber.join(request)).toMatchObject({ code: 'busy' });
			expect(yield* Fiber.join(automation)).toMatchObject({ code: 'busy' });
			yield* Deferred.succeed(a, undefined);
			yield* Deferred.succeed(b, undefined);
			yield* Effect.forEach(active, Fiber.join);
			expect(yield* Fiber.join(drained)).toBe(true);
			expect(yield* admit.drain(1000)).toBe(true);
		})
	);
	it.effect('retains fractional and unbounded capacity while work is admitted', () =>
		Effect.gen(function* () {
			for (const max of [2.5, Infinity]) {
				const admit = yield* envelope(max),
					entered = yield* Deferred.make<void>(),
					release = yield* Deferred.make<void>();
				let running = 0;
				const tasks = yield* Effect.forEach([0, 1, 2], () =>
					admit
						.admit(
							0,
							Effect.gen(function* () {
								if (++running === 3) yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							})
						)
						.pipe(Effect.forkChild)
				);
				yield* Deferred.await(entered);
				expect(yield* admit.drain(0)).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Effect.forEach(tasks, Fiber.join);
				expect(yield* admit.drain(100)).toBe(true);
			}
		})
	);
	it.effect(
		'drains within its grace: admission closes, waiters are shed, a never-settling call cannot hold it (rule 71a)',
		() =>
			Effect.gen(function* () {
				const admit = yield* envelope(1);
				const active = yield* admit.admit(1, Effect.never).pipe(Effect.forkChild);
				const shed = yield* Effect.flip(admit.admit(0, Effect.succeed('late'))).pipe(
					Effect.forkChild
				);
				yield* Effect.yieldNow;
				const drained = yield* admit.drain(50).pipe(Effect.forkChild);
				yield* TestClock.adjust('50 millis');
				expect(yield* Fiber.join(drained)).toBe(false);
				expect(yield* Fiber.join(shed)).toMatchObject({ code: 'busy' });
				expect(yield* Effect.flip(admit.admit(0, Effect.succeed('new')))).toMatchObject({
					code: 'busy'
				});
				yield* Fiber.interrupt(active);
				expect(yield* (yield* envelope(1)).drain(10_000)).toBe(true);
			})
	);
});

describe('the OpenAI-compatible model port (P19)', () => {
	it.effect('maps the declared classes to the operator’s models on the sys_2 endpoint', () =>
		Effect.gen(function* () {
			let url = '',
				sent: unknown;
			const f: typeof fetch = async (input, init) => {
				const request = new Request(input, init);
				url = request.url;
				sent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(await request.text());
				const structured = Schema.is(Schema.Struct({ response_format: Schema.Json }))(sent);
				return Response.json({
					choices: [{ message: { content: structured ? '{"ok":true}' : 'ok' } }]
				});
			};
			const http = client(f);
			const ai = yield* openAi(
				{
					sys1: { endpoint: 'https://s1.test/v1' },
					sys2: { endpoint: 'https://llm.test/v1', credential: 'k' }
				},
				{
					sys1: 'tiny',
					sys2: { default: 'gpt-x', fast: 'gpt-y' },
					embed: {},
					modalities: { sys2: null, embed: null }
				},
				['default', 'fast', 'strong'],
				() => Port.unavailable('files')
			).pipe(Effect.provide(http));
			expect(ai.models).toEqual(['default', 'fast']);
			const events = yield* Stream.runCollect(
				ai.infer({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
			).pipe(Effect.provide(http));
			const answer = events.find((event) => event._tag === 'Response');
			if (answer === undefined) throw new Error('model returned no response');
			expect(answer.response.content).toBe('ok');
			expect([
				url,
				Schema.decodeUnknownSync(Schema.Struct({ model: Schema.String }))(sent).model
			]).toEqual(['https://llm.test/v1/chat/completions', 'gpt-y']);
			expect(sent).not.toHaveProperty('provider');
			const deepSeekModel = 'deepseek/deepseek-v4.1-flash-1017';
			const router = yield* openAi(
				{
					sys1: { endpoint: 'https://s1.test/v1' },
					sys2: { endpoint: 'https://openrouter.ai/api/v1', credential: 'k' }
				},
				{
					sys1: 'tiny',
					sys2: { default: deepSeekModel, fast: 'openai/gpt-x' },
					embed: {},
					modalities: { sys2: null, embed: null }
				},
				['default', 'fast'],
				() => Port.unavailable('files')
			).pipe(Effect.provide(http));
			yield* Stream.runDrain(
				router.infer({
					model: deepSeekModel,
					messages: [{ role: 'user', content: 'hi' }],
					tools: [{ name: 'read', description: 'Read', input: { type: 'object' } }],
					output: { type: 'object', properties: { ok: { type: 'boolean' } } }
				})
			);
			expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
			expect(sent).toMatchObject({
				model: deepSeekModel,
				provider: { sort: 'price', require_parameters: true },
				tools: [{ type: 'function', function: { name: 'read' } }],
				response_format: { type: 'json_schema' }
			});
			yield* Stream.runDrain(
				router.infer({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
			);
			expect(sent).toMatchObject({ model: 'openai/gpt-x' });
			expect(sent).not.toHaveProperty('provider');
		})
	);
	it.effect(
		'sys_1 asks the operator’s model on its own endpoint in P37 shapes: text-only state, a decoded distribution and a context refusal',
		() =>
			Effect.gen(function* () {
				let url = '',
					sent: unknown,
					status = 200;
				const f: typeof fetch = async (input, init) => {
					const request = new Request(input, init);
					url = request.url;
					sent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(await request.text());
					if (status !== 200)
						return Response.json(
							{ error: { message: 'This model’s maximum context length is 32768 tokens' } },
							{ status }
						);
					return Response.json({
						choices: [
							{
								message: {
									content:
										'{"action":{"probabilities":{"respond":0.2,"wait":0.8}},"wait":{"probabilities":{"0":0.1,"1":0.2,"2":0.7}},"sure":{"noul":0.9}}'
								}
							}
						],
						usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0001 }
					});
				};
				const http = client(f);
				const ai = yield* openAi(
					{
						sys1: { endpoint: 'https://s1.test/v1', credential: 's' },
						sys2: { endpoint: 'https://llm.test/v1' }
					},
					{
						sys1: 'tiny',
						sys2: { default: 'gpt-x' },
						embed: {},
						modalities: { sys2: null, embed: null }
					},
					['default'],
					() => Port.unavailable('files')
				).pipe(Effect.provide(http));
				const request = {
					state: { text: 'see photo', photo: { name: 'p.png', mime: 'image/png', size: 2 } },
					questions: {
						action: {
							type: 'choice',
							instructions: 'p',
							criteria: { respond: 'now', wait: 'later' }
						},
						wait: { type: 'score', instructions: 's', criteria: ['0 s', '1 s', '2 s'] },
						sure: { type: 'noul', instructions: 'n', criteria: { true: 'y', false: 'n' } }
					}
				} as const;
				const d = yield* ai.ask(request).pipe(Effect.provide(http));
				const body = Schema.decodeUnknownSync(
					Schema.Struct({
						model: Schema.String,
						response_format: Schema.Unknown,
						messages: Schema.Array(Schema.Struct({ content: Schema.String }))
					})
				)(sent);
				expect([url, body.model]).toEqual(['https://s1.test/v1/chat/completions', 'tiny']);
				expect(body.response_format).toMatchObject({ type: 'json_schema' });
				expect(body.messages.at(-1)?.content).toEqual(
					expect.stringContaining('"photo":{"name":"p.png","mime":"image/png","size":2}')
				);
				expect(d).toMatchObject({
					costUsd: 0.0001,
					answers: {
						action: { type: 'choice', choice: 'wait', confidence: 0.8 },
						sure: { type: 'noul', noul: 0.9 },
						wait: { type: 'score', level: 2, legend: { 2: '2 s' } }
					}
				});
				const scored = d.answers['wait'];
				if (scored?.type !== 'score') throw new Error('wait was not answered as a score');
				expect(scored.score).toBeCloseTo(1.6);
				status = 400;
				expect(yield* Effect.flip(ai.ask(request).pipe(Effect.provide(http)))).toMatchObject({
					kind: 'tooLarge'
				});
			})
	);
	it.effect(
		'sys_1 on provider decisions posts { model, state, questions } to the Decisions API URL as given',
		() =>
			Effect.gen(function* () {
				let url = '',
					sent: unknown;
				const f: typeof fetch = async (input, init) => {
					const request = new Request(input, init);
					url = request.url;
					sent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(await request.text());
					return Response.json({
						answers: { sure: { type: 'noul', noul: 0.9 } },
						usage: { cost: 0.00002 }
					});
				};
				const http = client(f);
				const ai = yield* openAi(
					{
						sys1: {
							provider: 'decisions',
							endpoint: 'https://d.test/api/alpha/decisions',
							credential: 's'
						},
						sys2: { endpoint: 'https://llm.test/v1' }
					},
					{
						sys1: 'vendor/jev',
						sys2: { default: 'gpt-x' },
						embed: {},
						modalities: { sys2: null, embed: null }
					},
					['default'],
					() => Port.unavailable('files')
				).pipe(Effect.provide(http));
				const request = {
					state: { text: 'hi' },
					questions: {
						sure: { type: 'noul', instructions: 'n', criteria: { true: 'y', false: 'n' } }
					}
				} as const;
				expect(yield* ai.ask(request).pipe(Effect.provide(http))).toMatchObject({
					costUsd: 0.00002,
					answers: { sure: { type: 'noul', noul: 0.9 } }
				});
				expect([url, sent]).toEqual([
					'https://d.test/api/alpha/decisions',
					{ model: 'vendor/jev', state: request.state, questions: request.questions }
				]);
			})
	);
});

it.effect('a slow deadline cannot starve another scope or overlap itself', () =>
	Effect.gen(function* () {
		const woke: string[] = [],
			held = yield* Deferred.make<void>(),
			scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const context = yield* Layer.build(
			inProcessDeadlines((name) =>
				Effect.sync(() => {
					woke.push(name);
				}).pipe(Effect.andThen(name === 'slow' ? Deferred.await(held) : Effect.void))
			)
		).pipe(Scope.provide(scope));
		const dk = Context.get(context, DeadlinePort);
		yield* dk.announce('slow', new Date(1).toISOString());
		yield* dk.announce('fast', new Date(1).toISOString());
		yield* TestClock.adjust('1 millis');
		expect(woke).toEqual(['slow', 'fast']);
		yield* dk.announce('slow', new Date(1).toISOString());
		yield* TestClock.adjust('1 millis');
		expect(woke).toEqual(['slow', 'fast']);
		yield* Scope.close(scope, Exit.void);
		yield* Deferred.succeed(held, undefined);
		yield* TestClock.adjust('1 millis');
		expect(woke).toEqual(['slow', 'fast']);
	})
);
