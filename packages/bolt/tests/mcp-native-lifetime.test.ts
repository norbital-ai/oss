import { Client } from '@modelcontextprotocol/client';
import { expect, it, vi } from '@effect/vitest';
import { Effect, Exit, Fiber, Scope } from 'effect';
import { mcpSessions } from '../src/engine/agent/mcp.ts';
import { Port } from '../src/engine/port.ts';

const fixture = Effect.gen(function* () {
	const scope = yield* Scope.make();
	yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
	const sessions = yield* mcpSessions(
		{ mcp: { good: { description: '', url: 'URL' }, other: { description: '', url: 'URL' } } },
		{ secret: () => Effect.succeed('http://fixture.invalid/mcp') }
	).pipe(Scope.provide(scope));
	return { sessions, close: Scope.close(scope, Exit.void) };
});

const sdk = Effect.acquireRelease(
	Effect.sync(() => {
		const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
		const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
		return { connect, close };
	}),
	() => Effect.sync(() => vi.restoreAllMocks())
);

it.effect('waits for interrupted native SDK acquisition before closing its client', () =>
	Effect.gen(function* () {
		const { connect, close } = yield* sdk;
		const started = Promise.withResolvers<void>();
		const native = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		connect.mockImplementation((_transport, options) => {
			signal = options?.signal;
			started.resolve();
			return native.promise;
		});
		const f = yield* fixture;
		yield* Effect.addFinalizer(() => Effect.sync(() => native.resolve()));
		const call = yield* Effect.forkChild(f.sessions.call('good', 'echo', {}));
		yield* Port.attempt('fixture.connect', () => started.promise);
		const interrupting = yield* Effect.forkChild(Fiber.interrupt(call), { startImmediately: true });
		yield* Fiber.join(interrupting);
		expect(signal?.aborted).toBe(true);
		const stopping = yield* Effect.forkChild(f.close, { startImmediately: true });
		expect(stopping.pollUnsafe()).toBeUndefined();
		expect(close).not.toHaveBeenCalled();
		expect(yield* f.sessions.call('other', 'echo', {}).pipe(Effect.flip)).toMatchObject({
			_tag: 'Unavailable',
			reason: 'the session scope is closed'
		});
		native.reject(new Error('connection aborted'));
		yield* Fiber.join(stopping);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	})
);

it.effect('caches rejected SDK acquisition and releases its client exactly once', () =>
	Effect.gen(function* () {
		const { connect, close } = yield* sdk;
		connect.mockRejectedValue(new Error('connection refused'));
		const f = yield* fixture;
		const failure = yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip);
		expect(failure).toMatchObject({ kind: 'upstream', message: 'connection refused' });
		expect(yield* f.sessions.call('good', 'echo', {}).pipe(Effect.flip)).toBe(failure);
		yield* Effect.all([f.close, f.close], { concurrency: 'unbounded' });
		expect(connect).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	})
);
