// The MCP client under the public-address policy: a server URL on a private address is refused before any request
// leaves, and the refusal names no part of what that address would have answered.
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mcp_port } from '../src/node/mcp.ts';

it.live('refuses a private MCP server without reaching it or echoing its body', () =>
	Effect.scoped(
		Effect.gen(function* () {
			let hits = 0;
			const server = createServer((_request, response) => {
				hits++;
				response.writeHead(500, { 'content-type': 'text/plain' }).end('INTERNAL-SECRET');
			});
			yield* Effect.acquireRelease(
				Effect.promise(() => once(server.listen(0, '127.0.0.1'), 'listening')),
				() => Effect.sync(() => server.close())
			);
			const address = server.address(),
				port = typeof address === 'object' && address !== null ? address.port : 0;
			const mcp = yield* mcp_port;
			const failure = yield* Effect.promise(() =>
				mcp
					.connect({ url: `http://127.0.0.1:${port}/mcp`, headers: {} }, new AbortController().signal)
					.then(
					() => undefined,
					(error: unknown) => String(error instanceof Error ? error.message : error)
				)
			);
			expect(failure).toBeDefined();
			expect(failure).not.toContain('INTERNAL-SECRET');
			expect(hits).toBe(0);
		})
	)
);
