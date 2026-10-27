// The MCP servers (rule 63b, P23): declared at `src/agent/mcp/+<n>.mcp.ts`, reached through the host's `Mcp` port,
// authorized by a bearer token or OAuth client credentials the engine resolves from the workspace's secrets (the host
// holds the client). One session per server per turn; every call is a facility call under the 60 s wall. Discovery
// omits missing or unreachable servers with their typed failure logged; secret-provider failures still fail discovery
// (rule 69).
import { Cache, Config, Effect, Option, Predicate, Redacted, Ref, Result, Scope } from 'effect';
import { Unavailable } from '../../decl/errors.ts';
import { Port, type PortFailure } from '../port.ts';
import { Mcp, type McpSession } from '../ports.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type Authority, type McpServer } from '../contracts.ts';

/** The workspace's secrets (URL, client ids, tokens, client secrets) by `SecretName`. */
export type McpHost = {
	secret(name: string): Effect.Effect<string | undefined, PortFailure>;
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
	const client = yield* Mcp;
	const closed = yield* Ref.make(false);
	// a session acquired after the turn's scope closed is closed at once (a closed scope runs a new finalizer)
	const resources = yield* Scope.make('parallel');
	yield* Effect.addFinalizer((exit) =>
		Ref.set(closed, true).pipe(Effect.andThen(Scope.close(resources, exit)))
	);
	const unavailableError = (server: string, reason: string) =>
		new Unavailable({ facility: `mcp:${server}`, reason });
	const unavailable = (server: string, reason: string) =>
		Effect.fail(unavailableError(server, reason));
	const open = Effect.gen(function* () {
		return !(yield* Ref.get(closed));
	});
	const secret = (name: string) =>
		host === undefined
			? Config.option(Config.Redacted(name)).pipe(
					Effect.map((value) => Option.getOrUndefined(Option.map(value, Redacted.value))),
					Effect.mapError(Port.failure('mcp.configuration'))
				)
			: host.secret(name);
	/** A configuration gap is an answer (kept by the cache); a secret provider's failure fails the lookup. */
	const resolve = Effect.fn('Mcp.resolve')(function* (
		server: string
	): Effect.fn.Return<Result.Result<McpServer, Unavailable>, PortFailure> {
		const spec = m.mcp[server];
		if (spec === undefined)
			return Result.fail(unavailableError(server, 'no MCP server is configured'));
		const url = yield* secret(spec.url);
		if (url === undefined || url === '')
			return Result.fail(unavailableError(server, `${spec.url} is not set`));
		if (spec.auth === undefined) return Result.succeed({ url, headers: {} });
		if ('bearer' in spec.auth) {
			const bearer = yield* secret(spec.auth.bearer);
			return bearer === undefined
				? Result.fail(unavailableError(server, `${spec.auth.bearer} is not set`))
				: Result.succeed({ url, headers: {}, auth: { bearer } });
		}
		const { clientId, clientSecret, scopes } = spec.auth.oauth;
		const id = yield* secret(clientId),
			sec = clientSecret === undefined ? undefined : yield* secret(clientSecret);
		return id === undefined || sec === undefined
			? Result.fail(unavailableError(server, 'the OAuth client credentials are not set'))
			: Result.succeed({
					url,
					headers: {},
					auth: { client: { id, secret: sec, ...(scopes === undefined ? {} : { scopes }) } }
				});
	});
	const connect = Effect.fn('Mcp.connect')(function* (
		server: string
	): Effect.fn.Return<Result.Result<McpSession, PortFailure>, PortFailure> {
		const resolved = yield* resolve(server);
		if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
		return yield* client
			.connect(resolved.success)
			.pipe(Port.call(`mcp:${server}`, wallMs), Scope.provide(resources), Effect.result);
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
		if (!(yield* open)) return yield* unavailable(server, 'the session scope is closed');
		if (!allowed(server, tool))
			return yield* unavailable(server, `${tool} is not in the server's allowlist`);
		if (!Predicate.isObject(input))
			return yield* unavailable(server, 'tool arguments must be an object');
		const session = yield* Effect.fromResult(yield* Cache.get(cache, server));
		return yield* session.call(tool, input).pipe(Port.call(`mcp:${server}.${tool}`, wallMs));
	});
	const tools = Effect.fn('Mcp.tools')(function* (authority: Authority) {
		const lists = yield* Effect.forEach(
			mcpServers(m, authority),
			({ name }) =>
				Effect.gen(function* () {
					if (!(yield* open)) return yield* unavailable(name, 'the session scope is closed');
					const connected = yield* Cache.get(cache, name);
					if (Result.isFailure(connected)) {
						yield* Effect.logWarning(connected.failure);
						return [];
					}
					const listed = yield* connected.success.tools.pipe(
						Port.call(`mcp:${name}`, wallMs),
						Effect.map(Option.some),
						Effect.tapCause(Effect.logWarning),
						Effect.catch(() => Effect.succeed(Option.none()))
					);
					if (Option.isNone(listed)) return [];
					return listed.value
						.filter((tool) => allowed(name, tool.name))
						.map((tool): McpTool => ({
							server: name,
							name: tool.name,
							description: tool.description,
							input: tool.inputSchema
						}));
				}),
			{ concurrency: 'unbounded' }
		);
		return lists.flat();
	});
	return { tools, call };
});
export type McpSessions = Effect.Success<ReturnType<typeof mcpSessions>>;
