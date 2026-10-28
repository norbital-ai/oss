// The engine's side of MCP over a fake `Mcp` service: server resolution from secrets, one session per server per turn,
// allowlists, discovery and the turn scope's lifetime. The SDK client is the host's (`node/mcp.ts`).
import { expect, it, vi } from '@effect/vitest';
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Authority, McpPort, McpServer, McpToolInfo } from '../src/engine/contracts.ts';
import type { Json } from '../src/decl/values.ts';
import { Port, type PortFailure } from '../src/engine/port.ts';
import { Mcp } from '../src/engine/ports.ts';
import { mcpSessions, type McpHost } from '../src/engine/agent/mcp.ts';

const manifest = {
	mcp: {
		good: { description: 'Good', url: 'URL' },
		bad: { description: 'Bad', url: 'URL', auth: { bearer: 'TOKEN' } }
	}
};
const URL_OF = 'https://fixture.test/mcp';
/** `URL` answers the fixture address; `token` answers every other secret (the bearer). */
const host = (token: McpHost['secret'] = () => Effect.succeed(undefined)): McpHost => ({
	secret: (name) => (name === 'URL' ? Effect.succeed(URL_OF) : token(name))
});
type Fake = {
	connect?: (server: McpServer) => Effect.Effect<void, PortFailure>;
	tools?: (server: McpServer) => Effect.Effect<readonly McpToolInfo[], PortFailure>;
	call?: (tool: string, input: Json) => Effect.Effect<Json, PortFailure>;
};
/** A fake port service: what it was asked to connect, and how many sessions it closed. */
const fakeMcp = (fake: Fake = {}) => {
	const seen = { connects: [] as McpServer[], closes: 0 };
	const service: Mcp['Service'] = {
		connect: (server) =>
			Effect.acquireRelease(
				(fake.connect?.(server) ?? Effect.void).pipe(
					Effect.tap(() => Effect.sync(() => seen.connects.push(server)))
				),
				() =>
					Effect.sync(() => {
						seen.closes++;
					})
			).pipe(
				Effect.as({
					tools: fake.tools?.(server) ?? Effect.succeed([]),
					call: (tool: string, input: Json) =>
						fake.call?.(tool, input) ?? Effect.succeed({ content: [] })
				})
			)
	};
	return { seen, service };
};
const fixture = (
	o: {
		m?: Parameters<typeof mcpSessions>[0];
		host?: McpHost | null;
		wallMs?: number;
		fake?: Fake;
	} = {}
) =>
	Effect.gen(function* () {
		const { seen, service } = fakeMcp(o.fake);
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
		const sessions = yield* mcpSessions(
			o.m ?? manifest,
			o.host === null ? undefined : (o.host ?? host()),
			o.wallMs
		).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(Mcp, service));
		return { sessions, seen, close: Scope.close(scope, Exit.void) };
	});

it.effect('shares one session per server and closes it once across concurrent shutdowns', () =>
	Effect.gen(function* () {
		const f = yield* fixture();
		yield* Effect.all([f.sessions.call('good', 'echo', {}), f.sessions.call('good', 'echo', {})], {
			concurrency: 'unbounded'
		});
		expect(f.seen.connects).toEqual([{ url: URL_OF, headers: {} }]);
		yield* Effect.all([f.close, f.close], { concurrency: 'unbounded' });
		expect(f.seen.closes).toBe(1);
	})
);
it.effect('resolves the URL and credentials from secrets into the server the port connects', () =>
	Effect.gen(function* () {
		const secrets: Record<string, string> = {
			URL: URL_OF,
			TOKEN: 'token',
			CLIENT: 'cid',
			SECRET: 'csec'
		};
		const f = yield* fixture({
			m: {
				mcp: {
					bearer: { description: '', url: 'URL', auth: { bearer: 'TOKEN' } },
					client: {
						description: '',
						url: 'URL',
						auth: { oauth: { clientId: 'CLIENT', clientSecret: 'SECRET', scopes: ['a', 'b'] } }
					}
				}
			},
			host: { secret: (name) => Effect.succeed(secrets[name]) }
		});
		yield* f.sessions.call('bearer', 'echo', {});
		yield* f.sessions.call('client', 'echo', {});
		expect(f.seen.connects).toEqual([
			{ url: URL_OF, headers: {}, auth: { bearer: 'token' } },
			{
				url: URL_OF,
				headers: {},
				auth: { client: { id: 'cid', secret: 'csec', scopes: ['a', 'b'] } }
			}
		]);
	})
);
it.effect('keeps a secret provider failure for the turn and closes the sessions it opened', () =>
	Effect.gen(function* () {
		const error = new FacilityFailure({ kind: 'upstream', message: 'secret unavailable' });
		const secret = vi.fn(() => Effect.fail(error)),
			f = yield* fixture({ host: host(secret) });
		yield* f.sessions.call('good', 'echo', {});
		for (let i = 0; i < 2; i++)
			expect(yield* f.sessions.call('bad', 'echo', {}).pipe(Effect.flip)).toBe(error);
		expect(secret).toHaveBeenCalledTimes(1);
		yield* f.close;
		expect(f.seen.closes).toBe(1);
	})
);
it.effect('answers an unconfigured server Unavailable, kept for the turn, without connecting', () =>
	Effect.gen(function* () {
		const f = yield* fixture({ host: null }),
			absent = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
		const first = yield* f.sessions
			.call('good', 'echo', {})
			.pipe(Effect.provide(absent), Effect.flip);
		expect(first).toMatchObject({ _tag: 'Unavailable', reason: 'URL is not set' });
		expect(
			yield* f.sessions.call('good', 'echo', {}).pipe(Effect.provide(absent), Effect.flip)
		).toBe(first);
		expect(f.seen.connects).toEqual([]);
	})
);
it.effect('refuses every call once the turn scope closed', () =>
	Effect.gen(function* () {
		const f = yield* fixture();
		yield* f.sessions.call('good', 'echo', {});
		yield* f.close;
		expect(yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: 'the session scope is closed'
		});
	})
);
it.effect('closes at once a session that connected after the turn scope closed', () =>
	Effect.gen(function* () {
		const gate = yield* Deferred.make<void>(),
			connecting = yield* Deferred.make<void>();
		const f = yield* fixture({
			fake: {
				connect: () =>
					Deferred.succeed(connecting, undefined).pipe(Effect.andThen(Deferred.await(gate)))
			}
		});
		const call = yield* Effect.forkChild(f.sessions.call('good', 'echo', {}));
		yield* Deferred.await(connecting);
		yield* f.close;
		expect(f.seen.closes).toBe(0);
		yield* Deferred.succeed(gate, undefined);
		yield* Fiber.join(call);
		expect(f.seen.connects).toHaveLength(1);
		expect(f.seen.closes).toBe(1);
	})
);

const discoveryAuthority: Authority = {
	key: 'discovery',
	actor: {
		kind: 'member',
		id: 'actor',
		email: null,
		phone: null,
		teams: [],
		admin: true,
		party: null,
		external: false,
		teamPath: []
	},
	admin: true,
	policies: [],
	models: {},
	automations: [],
	limits: [],
	teamTree: [],
	scopes: {},
	capabilities: { apps: [], tools: [], mcp: [], skills: [] }
};
const info = (name: string): McpToolInfo => ({
	name,
	description: name,
	inputSchema: { type: 'object' }
});
it.effect('keeps declaration order and allowlists when server lists finish out of order', () =>
	Effect.gen(function* () {
		const first = yield* Deferred.make<readonly McpToolInfo[]>(),
			second = yield* Deferred.make<void>();
		const f = yield* fixture({
			m: {
				mcp: {
					first: { description: '', url: 'FIRST', tools: ['allowed'] },
					second: { description: '', url: 'SECOND' }
				}
			},
			host: { secret: (name) => Effect.succeed(name) },
			fake: {
				tools: (server) =>
					server.url === 'FIRST'
						? Deferred.await(first)
						: Deferred.succeed(second, undefined).pipe(Effect.as([info('second')]))
			}
		});
		const result = yield* Effect.forkChild(f.sessions.tools(discoveryAuthority));
		yield* Deferred.await(second);
		yield* Deferred.succeed(first, [info('blocked'), info('allowed')]);
		expect((yield* Fiber.join(result)).map((tool) => [tool.server, tool.name])).toEqual([
			['first', 'allowed'],
			['second', 'second']
		]);
	})
);
it.effect('fails discovery on a secret provider failure, ending a sibling list', () =>
	Effect.gen(function* () {
		const error = new FacilityFailure({ kind: 'upstream', message: 'secret rejected' });
		const failed = yield* Deferred.make<string | undefined, FacilityFailure>(),
			listing = yield* Deferred.make<void>();
		let ended = false;
		const f = yield* fixture({
			host: host(() => Deferred.await(failed)),
			fake: {
				tools: () =>
					Deferred.succeed(listing, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								ended = true;
							})
						)
					)
			}
		});
		const result = yield* Effect.forkChild(f.sessions.tools(discoveryAuthority).pipe(Effect.flip));
		yield* Deferred.await(listing);
		yield* Deferred.fail(failed, error);
		expect(yield* Fiber.join(result)).toBe(error);
		expect(ended).toBe(true);
	})
);
it.effect('omits from discovery a server that does not connect or whose list fails', () =>
	Effect.gen(function* () {
		const down = new FacilityFailure({ kind: 'upstream', message: 'connection refused' });
		const f = yield* fixture({
			m: {
				mcp: {
					down: { description: '', url: 'DOWN' },
					broken: { description: '', url: 'BROKEN' },
					up: { description: '', url: 'UP' }
				}
			},
			host: { secret: (name) => Effect.succeed(name) },
			fake: {
				connect: (server) => (server.url === 'DOWN' ? Effect.fail(down) : Effect.void),
				tools: (server) =>
					server.url === 'BROKEN'
						? Effect.fail(new FacilityFailure({ kind: 'upstream', message: 'list failed' }))
						: Effect.succeed([info('ok')])
			}
		});
		expect((yield* f.sessions.tools(discoveryAuthority)).map((tool) => tool.server)).toEqual([
			'up'
		]);
		expect(yield* f.sessions.call('down', 'ok', {}).pipe(Effect.flip)).toBe(down);
	})
);
it.effect('refuses a disallowed tool or non-object arguments before connecting', () =>
	Effect.gen(function* () {
		const f = yield* fixture({
			m: { mcp: { good: { description: '', url: 'URL', tools: ['allowed'] } } }
		});
		expect(yield* f.sessions.call('good', 'blocked', {}).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: "blocked is not in the server's allowlist"
		});
		expect(yield* f.sessions.call('good', 'allowed', [1]).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: 'tool arguments must be an object'
		});
		expect(f.seen.connects).toEqual([]);
	})
);
it.effect("passes the port's result and failure through", () =>
	Effect.gen(function* () {
		const answer = {
			content: [{ type: 'text', text: 'answer' }],
			structured: { count: 1 },
			isError: true
		};
		const f = yield* fixture({
			fake: {
				call: (tool) =>
					tool === 'echo'
						? Effect.succeed(answer)
						: Effect.fail(new FacilityFailure({ kind: 'upstream', message: 'remote failed' }))
			}
		});
		expect(yield* f.sessions.call('good', 'echo', { value: 1 })).toEqual(answer);
		expect(yield* f.sessions.call('good', 'other', {}).pipe(Effect.flip)).toMatchObject({
			kind: 'upstream',
			message: 'remote failed'
		});
	})
);
it.effect('ends a call past its wall as a timeout and interrupts the port call', () =>
	Effect.gen(function* () {
		const called = yield* Deferred.make<void>();
		let interrupted = false;
		const f = yield* fixture({
			wallMs: 25,
			fake: {
				call: () =>
					Deferred.succeed(called, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								interrupted = true;
							})
						)
					)
			}
		});
		const result = yield* Effect.forkChild(f.sessions.call('good', 'echo', {}).pipe(Effect.flip));
		yield* Deferred.await(called);
		yield* TestClock.adjust('26 millis');
		expect(yield* Fiber.join(result)).toMatchObject({
			kind: 'timeout',
			message: 'mcp:good.echo did not answer within 25 ms'
		});
		expect(interrupted).toBe(true);
	})
);

it.effect("over a host's Promise port, an interrupted connect aborts the port's signal and leaves nothing to close", () =>
	Effect.gen(function* () {
		const started = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const close = vi.fn(async (_session: string) => {});
		const port: McpPort = {
			connect: (_server, s) => {
				signal = s;
				started.resolve();
				return new Promise<string>(() => {});
			},
			tools: async () => [],
			call: async () => ({ content: [] }),
			close
		};
		const scope = yield* Scope.make();
		const sessions = yield* mcpSessions(manifest, host()).pipe(
			Scope.provide(scope),
			Effect.provide(Mcp.fromAbi(port))
		);
		const call = yield* Effect.forkChild(sessions.call('good', 'echo', {}));
		yield* Port.attempt('fixture.connect', () => started.promise);
		yield* Fiber.interrupt(call);
		expect(signal?.aborted).toBe(true);
		yield* Scope.close(scope, Exit.void);
		expect(close).not.toHaveBeenCalled();
	})
);
