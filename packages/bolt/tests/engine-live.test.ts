import { expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope, Stream } from 'effect';
import { Activation, Live } from '../src/engine/services.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../src/engine/ports.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { EngineLive } from '../src/engine/host.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { manifest } from './engine-fixture.ts';

const database = Layer.effect(
	TenantDb,
	Effect.gen(function* () {
		const db = yield* TenantDb;
		yield* applyPlan(db, plan(null, manifest));
		return db;
	})
).pipe(Layer.provide(PgliteDb.layer()));
const host = Layer.mergeAll(
	NodeCrypto.layer,
	database,
	Ai.unavailable,
	Convert.unavailable,
	DeadlinePort.unavailable,
	Drivers.unavailable,
	Files.unavailable,
	Geo.unavailable,
	Metering.unavailable,
	Speech.unavailable,
	Transport.unavailable,
	WebRead.unavailable,
	Layer.succeed(Activation, {
		scope: 'test',
		epoch: '',
		release: 'test',
		publicUrl: 'http://localhost',
		guest: Option.none(),
		transforms: new Set<string>(),
		projections: new Set<string>(),
		start: [],
		secretsKey: Option.none()
	})
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
