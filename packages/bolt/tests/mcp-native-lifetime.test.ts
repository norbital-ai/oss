// The turn's MCP sessions over a Promise `McpPort` (`Mcp.fromAbi`), as a host binds it: interruption aborts the port
// call, a failed connect is kept for the turn, and every opened session closes exactly once.
import { expect, it, vi } from '@effect/vitest';
import { Effect, Exit, Fiber, Scope } from 'effect';
import type { McpPort } from '../src/engine/contracts.ts';
import { Mcp } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { mcpSessions } from '../src/engine/agent/mcp.ts';

const fixture = (port: McpPort) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
		const sessions = yield* mcpSessions(
			{ mcp: { good: { description: '', url: 'GOOD' }, other: { description: '', url: 'OTHER' } } },
			{ secret: (name) => Effect.succeed(`https://${name.toLowerCase()}.test/mcp`) }
		).pipe(Scope.provide(scope), Effect.provide(Mcp.fromAbi(port)));
		return { sessions, close: Scope.close(scope, Exit.void) };
	});
const port = (connect: McpPort['connect']) => {
	const close = vi.fn(async (_session: string) => {});
	const mcp: McpPort = {
		connect: vi.fn(connect),
		tools: async () => [],
		call: async () => ({ content: [] }),
		close
	};
	return { mcp, close };
};

it.effect("an interrupted connect aborts the port's signal and leaves nothing to close", () =>
	Effect.gen(function* () {
		const started = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const p = port((_server, s) => {
			signal = s;
			started.resolve();
			return new Promise<string>(() => {});
		});
		const f = yield* fixture(p.mcp);
		const call = yield* Effect.forkChild(f.sessions.call('good', 'echo', {}));
		yield* Port.attempt('fixture.connect', () => started.promise);
		yield* Fiber.interrupt(call);
		expect(signal?.aborted).toBe(true);
		yield* f.close;
		expect(p.close).not.toHaveBeenCalled();
	})
);

it.effect('keeps a rejected connect for the turn and closes an opened session exactly once', () =>
	Effect.gen(function* () {
		const p = port(async (server) => {
			if (server.url === 'https://good.test/mcp') throw new Error('connection refused');
			return 'session-other';
		});
		const f = yield* fixture(p.mcp);
		const failure = yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip);
		expect(failure).toMatchObject({ kind: 'upstream', message: 'connection refused' });
		expect(yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip)).toBe(failure);
		yield* f.sessions.call('other', 'echo', {});
		yield* Effect.all([f.close, f.close], { concurrency: 'unbounded' });
		expect(p.mcp.connect).toHaveBeenCalledTimes(2);
		expect(p.close).toHaveBeenCalledTimes(1);
		expect(p.close).toHaveBeenCalledWith('session-other');
	})
);
