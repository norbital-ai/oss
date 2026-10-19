// The MCP client (rule 63b, P23): servers declared at `src/agent/mcp/+<n>.mcp.ts`, reached over streamable HTTP on the
// current protocol revision, authorized by a bearer token or OAuth client credentials from the workspace's secrets.
// One session per server per turn; every call is a facility call under the 60 s wall. Discovery omits missing or
// unreachable servers with their typed failure logged; secret-provider failures still fail discovery (rule 69).
import {
	Client,
	ClientCredentialsProvider,
	StreamableHTTPClientTransport,
	type FetchLike
} from '@modelcontextprotocol/client';
import {
	Cache,
	Config,
	Effect,
	Latch,
	Option,
	Predicate,
	Redacted,
	Ref,
	Result,
	Schema,
	Scope,
	Semaphore
} from 'effect';
import { Unavailable } from '../../decl/errors.ts';
import { Port, type PortFailure } from '../port.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type Authority } from '../contracts.ts';

/** The workspace's secrets (URL, client ids, tokens, client secrets) by `SecretName`. */
export type McpHost = {
	secret(name: string): Effect.Effect<string | undefined, PortFailure>;
	fetch?: FetchLike;
};
export type McpTool = { server: string; name: string; description: string; input: Json };

/** Rule 58: the servers a held policy's capabilities name (an administrator holds every declared one). */
export const mcpServers = (
	m: Pick<EngineManifest, 'mcp'>,
	a: Authority
): { name: string; description: string }[] =>
	Object.entries(m.mcp)
		.filter(([n]) => a.admin || a.capabilities.mcp.includes(n))
		.map(([name, s]) => ({ name, description: String(s['description'] ?? '') }));

/** Sessions and their cache belong to the calling turn's scope. */
export const mcpSessions = Effect.fn('Mcp.sessions')(function* (
	m: Pick<EngineManifest, 'mcp'>,
	host: McpHost | undefined = undefined,
	wallMs: number = LIMITS.callMs.tool
) {
	const lifecycle = yield* Ref.make({ closed: false, pending: 0 });
	const drained = yield* Latch.make(true);
	const gate = yield* Semaphore.make(1);
	const resources = yield* Scope.make('parallel');
	const unavailableError = (server: string, reason: string) =>
		new Unavailable({ facility: `mcp:${server}`, reason });
	const unavailable = (server: string, reason: string) =>
		Effect.fail(unavailableError(server, reason));
	const admit = (server: string) =>
		gate.withPermit(
			Effect.gen(function* () {
				if ((yield* Ref.get(lifecycle)).closed)
					return yield* unavailable(server, 'the session scope is closed');
				yield* drained.close;
				yield* Ref.update(lifecycle, (state) => ({ ...state, pending: state.pending + 1 }));
			})
		);
	const settled = gate.withPermit(
		Effect.gen(function* () {
			const state = yield* Ref.updateAndGet(lifecycle, (state) => ({
				...state,
				pending: state.pending - 1
			}));
			if (state.pending === 0) yield* drained.open;
		})
	);
	yield* Effect.addFinalizer((exit) =>
		Effect.gen(function* () {
			yield* gate.withPermit(Ref.update(lifecycle, (state) => ({ ...state, closed: true })));
			yield* drained.await;
			yield* Scope.close(resources, exit);
		})
	);
	const secret = (name: string) =>
		host === undefined
			? Config.option(Config.redacted(name)).pipe(
					Effect.map((value) => Option.getOrUndefined(Option.map(value, Redacted.value))),
					Effect.mapError(Port.failure('mcp.configuration'))
				)
			: host.secret(name);
	const connect = Effect.fn('Mcp.connect')(function* (server: string) {
		return yield* Effect.acquireUseRelease(
			admit(server),
			() =>
				Effect.gen(function* () {
					const spec = m.mcp[server];
					if (spec === undefined)
						return Result.fail(unavailableError(server, 'no MCP server is configured'));
					const url = yield* secret(spec.url);
					if (url === undefined || url === '')
						return Result.fail(unavailableError(server, `${spec.url} is not set`));
					let authProvider: ClientCredentialsProvider | undefined;
					const headers: Record<string, string> = {};
					if (spec.auth !== undefined && 'bearer' in spec.auth) {
						const token = yield* secret(spec.auth.bearer);
						if (token === undefined)
							return Result.fail(unavailableError(server, `${spec.auth.bearer} is not set`));
						headers['authorization'] = `Bearer ${token}`;
					} else if (spec.auth !== undefined) {
						const { clientId, clientSecret, scopes } = spec.auth.oauth;
						const id = yield* secret(clientId),
							sec = clientSecret === undefined ? undefined : yield* secret(clientSecret);
						if (id === undefined || sec === undefined)
							return Result.fail(
								unavailableError(server, 'the OAuth client credentials are not set')
							);
						authProvider = new ClientCredentialsProvider({
							clientId: id,
							clientSecret: sec,
							...(scopes === undefined ? {} : { scope: scopes.join(' ') })
						});
					}
					const transport = yield* Effect.try({
						try: () =>
							new StreamableHTTPClientTransport(new URL(url), {
								requestInit: { headers },
								...(authProvider === undefined ? {} : { authProvider }),
								...(host?.fetch === undefined ? {} : { fetch: host.fetch })
							}),
						catch: Port.failure(`mcp:${server}`)
					});
					const client = yield* Effect.acquireRelease(
						Effect.sync(() => new Client({ name: '@norbital-ai/bolt', version: '0.0.1' })),
						(client) =>
							Port.attempt('mcp.close', () => client.close()).pipe(
								Effect.tapCause(Effect.logWarning),
								Effect.ignore
							)
					).pipe(Scope.provide(resources));
					// An aborted SDK acquisition stays in the resource scope until its native Promise settles.
					const connected = yield* Effect.callback<void, PortFailure>((resume, signal) => {
						const pending = Result.try({
							try: () => client.connect(transport, { signal }),
							catch: Port.failure(`mcp:${server}`)
						});
						if (Result.isFailure(pending)) return resume(Effect.fail(pending.failure));
						pending.success.then(
							() => resume(Effect.void),
							(error) => resume(Effect.fail(Port.failure(`mcp:${server}`)(error)))
						);
						return Effect.gen(function* () {
							yield* gate.withPermit(
								Effect.gen(function* () {
									yield* drained.close;
									yield* Ref.update(lifecycle, (state) => ({
										...state,
										pending: state.pending + 1
									}));
								})
							);
							yield* Port.attempt(`mcp:${server}`, () => pending.success).pipe(
								Effect.tapCause(Effect.logWarning),
								Effect.ignore,
								Effect.ensuring(settled),
								Effect.forkIn(resources)
							);
						});
					}).pipe(Port.call(`mcp:${server}`, wallMs), Effect.result);
					// SDK connection availability is cached separately from secret/configuration failures.
					return Result.map(connected, () => client);
				}),
			() => settled
		);
	});
	const cache = yield* Cache.make({
		capacity: Math.max(1, Object.keys(m.mcp).length),
		timeToLive: Infinity,
		lookup: connect
	});
	const allowed = (server: string, tool: string) => {
		const only = m.mcp[server]?.tools;
		return only === undefined || only.includes(tool);
	};
	const call = Effect.fn('Mcp.call')(function* (server: string, tool: string, input: Json) {
		if ((yield* Ref.get(lifecycle)).closed)
			return yield* unavailable(server, 'the session scope is closed');
		if (!allowed(server, tool))
			return yield* unavailable(server, `${tool} is not in the server's allowlist`);
		if (!Predicate.isObject(input))
			return yield* unavailable(server, 'tool arguments must be an object');
		const client = yield* Effect.fromResult(yield* Cache.get(cache, server));
		const result = yield* Port.attempt(`mcp:${server}.${tool}`, (signal) =>
			client.callTool({ name: tool, arguments: input }, { signal })
		).pipe(Port.call(`mcp:${server}.${tool}`, wallMs));
		return yield* Schema.decodeUnknownEffect(Schema.Json)({
			content: result.content,
			...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }),
			...(result.isError ? { isError: true } : {})
		}).pipe(Effect.mapError(Port.failure(`mcp:${server}.${tool}`)));
	});
	const tools = Effect.fn('Mcp.tools')(function* (authority: Authority) {
		const lists = yield* Effect.forEach(
			mcpServers(m, authority),
			({ name }) =>
				Effect.gen(function* () {
					if ((yield* Ref.get(lifecycle)).closed)
						return yield* unavailable(name, 'the session scope is closed');
					const connected = yield* Cache.get(cache, name);
					if (Result.isFailure(connected)) {
						yield* Effect.logWarning(connected.failure);
						return [];
					}
					const client = connected.success;
					const result = yield* Port.attempt(`mcp:${name}`, (signal) =>
						client.listTools(undefined, { signal })
					).pipe(
						Port.call(`mcp:${name}`, wallMs),
						Effect.map(Option.some),
						Effect.tapCause(Effect.logWarning),
						Effect.catch(() => Effect.succeed(Option.none()))
					);
					if (Option.isNone(result)) return [];
					return yield* Effect.forEach(
						result.value.tools.filter((tool) => allowed(name, tool.name)),
						(tool) =>
							Schema.decodeUnknownEffect(Schema.Json)(tool.inputSchema).pipe(
								Effect.map((input) => ({
									server: name,
									name: tool.name,
									description: tool.description ?? '',
									input
								})),
								Effect.mapError(Port.failure(`mcp:${name}`))
							)
					);
				}),
			{ concurrency: 'unbounded' }
		);
		return lists.flat();
	});
	return { tools, call };
});
export type McpSessions = Effect.Success<ReturnType<typeof mcpSessions>>;
