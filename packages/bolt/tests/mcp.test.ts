import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { expect, it, vi } from '@effect/vitest';
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Option, Scope, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Authority } from '../src/engine/contracts.ts';
import type { Json } from '../src/decl/values.ts';
import { Port } from '../src/engine/port.ts';
import { mcpSessions, type McpHost } from '../src/engine/agent/mcp.ts';

const manifest = {
	mcp: {
		good: { description: 'Good', url: 'URL' },
		bad: { description: 'Bad', url: 'URL', auth: { bearer: 'TOKEN' } }
	}
};
/** `URL` answers the fixture address; `token` answers every other secret (the bearer). */
const host = (token: McpHost['secret'] = () => Effect.succeed(undefined)): McpHost => ({
	secret: (name) => (name === 'URL' ? Effect.succeed('http://fixture.invalid/mcp') : token(name))
});
const sdk = () =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
			vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [] });
			const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
			return { connect, close };
		}),
		() => Effect.sync(() => vi.restoreAllMocks())
	);
const fixture = (
	m: Parameters<typeof mcpSessions>[0] = manifest,
	h: McpHost | null = host(),
	wallMs?: number
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
		const sessions = yield* mcpSessions(m, h ?? undefined, wallMs).pipe(
			Effect.provideService(Scope.Scope, scope)
		);
		return { sessions, close: Scope.close(scope, Exit.void) };
	});

it.effect('shares acquisition and closes once across concurrent shutdowns', () =>
	Effect.gen(function* () {
		const { connect, close } = yield* sdk(),
			f = yield* fixture();
		yield* Effect.all([f.sessions.call('good', 'echo', {}), f.sessions.call('good', 'echo', {})], {
			concurrency: 'unbounded'
		});
		expect(connect).toHaveBeenCalledTimes(1);
		yield* Effect.all([f.close, f.close], { concurrency: 'unbounded' });
		expect(close).toHaveBeenCalledTimes(1);
	})
);
it.effect('closes successful clients despite cached acquisition failures', () =>
	Effect.gen(function* () {
		const { close } = yield* sdk(),
			error = new FacilityFailure({ kind: 'upstream', message: 'secret unavailable' });
		const secret = vi.fn(() => Effect.fail(error)),
			f = yield* fixture(manifest, host(secret));
		yield* f.sessions.call('good', 'echo', {});
		for (let i = 0; i < 2; i++)
			expect(yield* f.sessions.call('bad', 'echo', {}).pipe(Effect.flip)).toBe(error);
		expect(secret).toHaveBeenCalledTimes(1);
		yield* f.close;
		expect(close).toHaveBeenCalledTimes(1);
	})
);
it.effect('waits for pending acquisition and refuses new sessions during shutdown', () =>
	Effect.gen(function* () {
		const { connect, close } = yield* sdk();
		const connected = Promise.withResolvers<void>(),
			gate = Promise.withResolvers<void>();
		connect.mockImplementation(() => {
			connected.resolve();
			return gate.promise;
		});
		const f = yield* fixture();
		yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
		const call = yield* Effect.forkChild(f.sessions.call('good', 'echo', {}));
		yield* Port.attempt('fixture.connect', () => connected.promise);
		let finished = false;
		const stopping = yield* Effect.forkChild(
			f.close.pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						finished = true;
					})
				)
			),
			{ startImmediately: true }
		);
		expect(finished).toBe(false);
		expect(yield* f.sessions.call('bad', 'echo', {}).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: 'the session scope is closed'
		});
		gate.resolve();
		yield* Fiber.join(call);
		yield* Fiber.join(stopping);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: 'the session scope is closed'
		});
	})
);
it.effect('retains unavailable answers and attempts all closes when one close fails', () =>
	Effect.gen(function* () {
		const { close } = yield* sdk();
		const unavailable = yield* fixture(manifest, null),
			absent = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
		const first = yield* unavailable.sessions
			.call('good', 'echo', {})
			.pipe(Effect.provide(absent), Effect.flip);
		expect(
			yield* unavailable.sessions.call('good', 'echo', {}).pipe(Effect.provide(absent), Effect.flip)
		).toBe(first);
		yield* unavailable.close;
		const f = yield* fixture(
			manifest,
			host(() => Effect.succeed('token'))
		);
		yield* Effect.all([f.sessions.call('good', 'echo', {}), f.sessions.call('bad', 'echo', {})], {
			concurrency: 'unbounded'
		});
		close.mockRejectedValueOnce(new Error('close failed'));
		yield* f.close;
		expect(close).toHaveBeenCalledTimes(2);
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
	collections: {},
	automations: [],
	limits: [],
	teamTree: [],
	scopes: {},
	capabilities: { apps: [], tools: [], mcp: [], skills: [] }
};
it.effect('keeps declaration order and allowlists when server lists finish out of order', () =>
	Effect.gen(function* () {
		yield* sdk();
		const held = Promise.withResolvers<{
			tools: { name: string; inputSchema: { type: 'object' } }[];
		}>();
		const started = Promise.withResolvers<void>(),
			secondFinished = Promise.withResolvers<void>();
		const list = vi
			.spyOn(Client.prototype, 'listTools')
			.mockImplementationOnce(() => {
				started.resolve();
				return held.promise;
			})
			.mockImplementationOnce(async () => {
				secondFinished.resolve();
				return { tools: [{ name: 'second', inputSchema: { type: 'object' } }] };
			});
		const f = yield* fixture({
			mcp: {
				first: { description: '', url: 'URL', tools: ['allowed'] },
				second: { description: '', url: 'URL' }
			}
		});
		yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve({ tools: [] })));
		const result = yield* Effect.forkChild(f.sessions.tools(discoveryAuthority));
		yield* Port.attempt('fixture.list', () => started.promise);
		yield* Port.attempt('fixture.list', () => secondFinished.promise);
		held.resolve({
			tools: [
				{ name: 'blocked', inputSchema: { type: 'object' } },
				{ name: 'allowed', inputSchema: { type: 'object' } }
			]
		});
		expect((yield* Fiber.join(result)).map((tool) => [tool.server, tool.name])).toEqual([
			['first', 'allowed'],
			['second', 'second']
		]);
		expect(list).toHaveBeenCalledTimes(2);
	})
);
it.effect('rejects discovery acquisition failure before an admitted sibling list completes', () =>
	Effect.gen(function* () {
		yield* sdk();
		const error = new FacilityFailure({ kind: 'upstream', message: 'secret rejected' });
		const failed = yield* Deferred.make<string | undefined, FacilityFailure>();
		const started = Promise.withResolvers<void>(),
			held = Promise.withResolvers<{ tools: [] }>();
		const list = vi.spyOn(Client.prototype, 'listTools').mockImplementation(() => {
			started.resolve();
			return held.promise;
		});
		const f = yield* fixture(
			manifest,
			host(() => Deferred.await(failed))
		);
		yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve({ tools: [] })));
		const result = yield* Effect.forkChild(
			f.sessions.tools(discoveryAuthority).pipe(Effect.flip, Effect.timeoutOption('1 millis'))
		);
		yield* Port.attempt('fixture.list', () => started.promise);
		yield* Deferred.fail(failed, error);
		yield* TestClock.adjust('1 millis');
		const rejected = yield* Fiber.join(result);
		expect(Option.isSome(rejected)).toBe(true);
		if (Option.isSome(rejected)) expect(rejected.value).toBe(error);
		expect(list).toHaveBeenCalledTimes(1);
	})
);

it.live('uses SDK pagination to discover every page without a Bolt cursor loop', () =>
	Effect.gen(function* () {
		const methods: string[] = [],
			cursors: (Json | undefined)[] = [];
		const Message = Schema.Struct({
			method: Schema.String,
			id: Schema.optionalKey(Schema.Json),
			params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
		});
		const server = yield* Effect.acquireRelease(
			Port.attempt(
				'fixture.listen',
				() =>
					new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
						const server = createServer(async (req, res) => {
							if (req.method !== 'POST') {
								res.writeHead(405).end();
								return;
							}
							let body = '';
							for await (const chunk of req) body += String(chunk);
							const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Message))(body);
							if (decoded._tag === 'None') {
								res.writeHead(400).end();
								return;
							}
							const message = decoded.value,
								method = message.method;
							methods.push(method);
							if (message.id === undefined) {
								res.writeHead(202).end();
								return;
							}
							const cursor = message.params?.['cursor'];
							let result: Json;
							if (method === 'initialize')
								result = {
									protocolVersion: message.params?.['protocolVersion'] ?? null,
									capabilities: { tools: {} },
									serverInfo: { name: 'pages', version: '1' }
								};
							else if (method === 'tools/list') {
								cursors.push(cursor);
								result =
									cursor === undefined
										? {
												tools: [{ name: 'first', inputSchema: { type: 'object' } }],
												nextCursor: 'page2'
											}
										: { tools: [{ name: 'second', inputSchema: { type: 'object' } }] };
							} else {
								res.writeHead(202).end();
								return;
							}
							res
								.writeHead(200, { 'content-type': 'application/json' })
								.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
						});
						server.once('error', reject);
						server.listen(0, '127.0.0.1', () => resolve(server));
					})
			),
			(server) =>
				Port.attempt(
					'fixture.close',
					() =>
						new Promise<void>((resolve, reject) =>
							server.close((error) => (error ? reject(error) : resolve()))
						)
				).pipe(Effect.orDie)
		);
		const address = server.address();
		if (address === null || typeof address === 'string')
			return yield* Effect.die(new Error('fixture has no TCP address'));
		const f = yield* fixture(
			{ mcp: { pages: { description: '', url: 'URL' } } },
			{ secret: () => Effect.succeed(`http://127.0.0.1:${address.port}/mcp`) }
		);
		expect((yield* f.sessions.tools(discoveryAuthority)).map((tool) => tool.name)).toEqual([
			'first',
			'second'
		]);
		expect(cursors).toEqual([undefined, 'page2']);
		expect(methods.filter((method) => method === 'initialize')).toHaveLength(1);
		yield* f.close;
	})
);
it.effect('omits an in-flight tool list when SDK close rejects its request', () =>
	Effect.gen(function* () {
		const { close } = yield* sdk();
		const started = Promise.withResolvers<void>(),
			held = Promise.withResolvers<{ tools: [] }>();
		vi.spyOn(Client.prototype, 'listTools').mockImplementation(() => {
			started.resolve();
			return held.promise;
		});
		close.mockImplementation(async () => {
			held.reject(new Error('Connection closed'));
		});
		const f = yield* fixture();
		yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve({ tools: [] })));
		const observed = yield* Effect.forkChild(f.sessions.tools(discoveryAuthority));
		yield* Port.attempt('fixture.list', () => started.promise);
		yield* f.close;
		expect(yield* Fiber.join(observed)).toEqual([]);
	})
);
it.effect('refuses a disallowed tool before opening its SDK session', () =>
	Effect.gen(function* () {
		const { connect } = yield* sdk();
		const f = yield* fixture({
			mcp: { good: { description: '', url: 'URL', tools: ['allowed'] } }
		});
		expect(yield* f.sessions.call('good', 'blocked', {}).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: "blocked is not in the server's allowlist"
		});
		expect(connect).not.toHaveBeenCalled();
	})
);
it.effect('retains tool result projection and upstream failure mapping', () =>
	Effect.gen(function* () {
		yield* sdk();
		const call = vi.mocked(Client.prototype.callTool);
		call.mockResolvedValueOnce({
			content: [{ type: 'text', text: 'answer' }],
			structuredContent: { count: 1 },
			isError: true
		});
		call.mockRejectedValueOnce(new Error('remote failed'));
		const f = yield* fixture();
		expect(yield* f.sessions.call('good', 'echo', { value: 1 })).toEqual({
			content: [{ type: 'text', text: 'answer' }],
			structured: { count: 1 },
			isError: true
		});
		expect(yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip)).toMatchObject({
			kind: 'upstream',
			message: 'remote failed'
		});
	})
);
it.effect('classifies an aborted SDK request as timeout', () =>
	Effect.gen(function* () {
		yield* sdk();
		const called = Promise.withResolvers<void>();
		const held = Promise.withResolvers<Awaited<ReturnType<Client['callTool']>>>();
		let signal: AbortSignal | undefined;
		vi.mocked(Client.prototype.callTool).mockImplementation((_request, options) => {
			signal = options?.signal;
			signal?.addEventListener('abort', () => held.reject(new Error('request aborted')), {
				once: true
			});
			called.resolve();
			return held.promise;
		});
		const f = yield* fixture(manifest, host(), 25);
		const result = yield* Effect.forkChild(f.sessions.call('good', 'echo', {}).pipe(Effect.flip));
		yield* Port.attempt('fixture.call', () => called.promise);
		yield* TestClock.adjust('26 millis');
		expect(yield* Fiber.join(result)).toMatchObject({
			kind: 'timeout',
			message: 'mcp:good.echo did not answer within 25 ms'
		});
		expect(signal?.aborted).toBe(true);
		expect(Client.prototype.callTool).toHaveBeenCalledWith(
			{ name: 'echo', arguments: {} },
			{ signal }
		);
	})
);
it.effect('keeps malformed URLs as acquisition failures', () =>
	Effect.gen(function* () {
		const { connect } = yield* sdk(),
			f = yield* fixture(manifest, { secret: () => Effect.succeed('http://') });
		const failure = yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip);
		expect(failure).toMatchObject({
			_tag: 'FacilityFailure',
			kind: 'upstream',
			message: expect.stringMatching(/Invalid URL/)
		});
		expect(connect).not.toHaveBeenCalled();
	})
);
