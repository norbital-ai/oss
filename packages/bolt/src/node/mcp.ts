/// <reference types="node" />
// The MCP client for same-graph hosts (`McpPort`, rule 63b): the SDK's streamable HTTP client on the current protocol
// revision, one per session. The engine resolves each server's URL and credentials from the workspace's secrets; the
// sessions close with the scope that made the port.
import { randomUUID } from 'node:crypto';
import {
	Client,
	ClientCredentialsProvider,
	StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { Effect, Exit, FiberSet, Predicate, Schema, type Scope } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';
import type { McpPort, McpServer } from '../engine/contracts.ts';
import { Port } from '../engine/port.ts';

const close = (client: Client) =>
	Port.attempt('mcp.close', () => client.close()).pipe(
		Effect.tapCause(Effect.logWarning),
		Effect.ignore
	);

export const mcpPort: Effect.Effect<McpPort, never, Scope.Scope> = Effect.gen(function* () {
	const sessions = new Map<string, Client>();
	yield* Effect.addFinalizer(() =>
		Effect.forEach(sessions.values(), close, { discard: true }).pipe(
			Effect.ensuring(Effect.sync(() => sessions.clear()))
		)
	);
	const session = (id: string) => {
		const client = sessions.get(id);
		return client === undefined
			? Effect.fail(new FacilityFailure({ kind: 'invalid', message: 'the MCP session is closed' }))
			: Effect.succeed(client);
	};
	const connect = Effect.fn('Mcp.connect')(function* (server: McpServer) {
		const auth = server.auth;
		const transport = yield* Effect.try({
			try: () =>
				new StreamableHTTPClientTransport(new URL(server.url), {
					requestInit: {
						headers: {
							...server.headers,
							...(auth !== undefined && 'bearer' in auth
								? { authorization: `Bearer ${auth.bearer}` }
								: {})
						}
					},
					...(auth !== undefined && 'client' in auth
						? {
								authProvider: new ClientCredentialsProvider({
									clientId: auth.client.id,
									clientSecret: auth.client.secret,
									...(auth.client.scopes === undefined
										? {}
										: { scope: auth.client.scopes.join(' ') })
								})
							}
						: {})
				}),
			catch: Port.failure('mcp')
		});
		const client = new Client({ name: '@norbital-ai/bolt', version: '0.0.1' });
		yield* Port.attempt('mcp', (signal) => client.connect(transport, { signal })).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? close(client) : Effect.void))
		);
		const id = randomUUID();
		sessions.set(id, client);
		return id;
	});
	const tools = Effect.fn('Mcp.tools')(function* (id: string) {
		const client = yield* session(id);
		const listed = yield* Port.attempt('mcp', (signal) => client.listTools(undefined, { signal }));
		return yield* Effect.forEach(listed.tools, (tool) =>
			Schema.decodeUnknownEffect(Schema.Json)(tool.inputSchema).pipe(
				Effect.map((inputSchema) => ({
					name: tool.name,
					description: tool.description ?? '',
					inputSchema
				})),
				Effect.mapError(Port.failure('mcp'))
			)
		);
	});
	const call = Effect.fn('Mcp.call')(function* (id: string, tool: string, input: Json) {
		const client = yield* session(id);
		if (!Predicate.isObject(input))
			return yield* Effect.fail(
				new FacilityFailure({ kind: 'invalid', message: 'tool arguments must be an object' })
			);
		const result = yield* Port.attempt('mcp', (signal) =>
			client.callTool({ name: tool, arguments: input }, { signal })
		);
		return yield* Schema.decodeUnknownEffect(Schema.Json)({
			content: result.content,
			...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }),
			...(result.isError ? { isError: true } : {})
		}).pipe(Effect.mapError(Port.failure('mcp')));
	});
	const run = yield* FiberSet.makeRuntimePromise();
	return {
		connect: (server, signal) => run(connect(server), { signal }),
		tools: (id, signal) => run(tools(id), { signal }),
		call: (id, tool, input, signal) => run(call(id, tool, input), { signal }),
		close: (id) =>
			run(
				Effect.suspend(() => {
					const client = sessions.get(id);
					sessions.delete(id);
					return client === undefined ? Effect.void : close(client);
				})
			)
	};
});
