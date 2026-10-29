import { expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect';
import { Live } from '../src/engine/services.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { bareHost } from './effect-engine.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { manifest } from './engine-fixture.ts';

const database = TestDb.layer(manifest);
const host = Layer.unwrap(Effect.map(TenantDb, (db) => bareHost(db))).pipe(
	Layer.provideMerge(database)
);
it.effect('builds the native graph and ends connection streams when its generation closes', () =>
	Effect.gen(function* () {
		const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
			Scope.close(scope, Exit.void)
		);
		const context = yield* Layer.build(EngineLive(manifest).pipe(Layer.provide(host))).pipe(
			Scope.provide(scope)
		);
		const live = Context.get(context, Live),
			hello = yield* Deferred.make<void>();
		const authority = compileAuthority(
			manifest,
			{ actor: { kind: 'visitor', app: '', visitor: 'test' }, policies: [], admin: false },
			'test'
		);
		const connection = yield* live.connect(authority).pipe(
			Stream.tap((frame) =>
				frame.t === 'hello' ? Deferred.succeed(hello, undefined) : Effect.void
			),
			Stream.runCollect,
			Effect.forkScoped
		);
		yield* Deferred.await(hello);
		yield* Scope.close(scope, Exit.void);
		const frames = yield* Fiber.join(connection);
		expect(frames[0]?.t).toBe('hello');
		expect(yield* live.retained).toBe(0);
	})
);
