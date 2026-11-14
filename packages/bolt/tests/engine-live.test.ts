import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect';
import { Live, Manifest, Reads, type LiveShape, type ReadsShape } from '../src/engine/services.ts';
import { LiveHubLive } from '../src/engine/live/hub.ts';
import { lower_read } from '../src/engine/query/engine.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { Authority } from '../src/engine/contracts.ts';
import type { Captured } from '../src/engine/db/captured.ts';
import type { Frame } from '../src/protocol/wire.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { bare_host } from './effect-engine.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { manifest } from './engine-fixture.ts';

const database = TestDb.layer(manifest);
const host = Layer.unwrap(Effect.map(TenantDb, (db) => bare_host(db))).pipe(
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
		const authority = yield* compile_authority(
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

const hub = (run: ReadsShape['run']) =>
	Layer.build(LiveHubLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Manifest, manifest), Layer.succeed(Reads, { run }))))).pipe(
		Effect.map((context) => Context.get(context, Live))
	);
const memberOf = (id: string, admin: boolean) =>
	compile_authority(manifest, {
		actor: { kind: 'member', id, email: null, phone: null, external: false, teams: [], team_path: [], admin, party: null },
		policies: [],
		admin
	}, `member:${id}:1`);
/** A connection's frames as they arrive, and its stream's end. */
const watch = (live: LiveShape, authority: Authority) =>
	Effect.gen(function* () {
		const frames: Frame[] = [], hello = yield* Deferred.make<string>();
		const ended = yield* live.connect(authority).pipe(
			Stream.runForEach((frame) => Effect.sync(() => frames.push(frame)).pipe(
				Effect.andThen(frame.t === 'hello' ? Deferred.succeed(hello, frame.conn) : Effect.void))),
			Effect.forkScoped
		);
		return { frames, conn: yield* Deferred.await(hello), ended };
	});
const userChange = (id: string, before: number, after: number): Captured => ({
	model: 'sys_user', id, op: 'update', revision: after, transaction: '1', cause: 'direct',
	old: { id, revision: before }, new: { id, revision: after }
});

it.effect('a connection ends when its principal changes; a change that moves no revision keeps it', () =>
	Effect.gen(function* () {
		const live = yield* hub(() => Effect.succeed([]));
		const id = randomUUID();
		const mine = yield* watch(live, yield* memberOf(id, false));
		// a sign-in stamp (`last_seen`) moves no revision: the stream stays
		live.publish([userChange(id, 1, 1)]);
		yield* live.settled;
		// deactivated, moved team or demoted: the revision moves, and the stream ends before the commit reaches it
		live.publish([userChange(id, 1, 2)]);
		yield* live.settled;
		yield* Fiber.join(mine.ended);
		expect(mine.frames.map((frame) => frame.t)).toEqual(['hello', 'v']);
		// a signed-out session ends its member's streams too
		const again = yield* watch(live, yield* memberOf(id, false));
		live.publish([{ model: 'sys_session', id: randomUUID(), op: 'delete', revision: 0, transaction: '2', cause: 'direct', old: { user: id }, new: null }]);
		yield* live.settled;
		yield* Fiber.join(again.ended);
	}).pipe(Effect.scoped)
);

it.effect('a view whose read failed is dropped: a later commit asks it nothing', () =>
	Effect.gen(function* () {
		let reads = 0;
		const live = yield* hub(() => Effect.suspend(() => {
			reads++;
			return Effect.fail(BoltError.make('internal', 'decode', 'the read failed'));
		}));
		const watched = yield* watch(live, yield* memberOf(randomUUID(), true));
		yield* live.register(watched.conn, 'orders', { read: yield* lower_read(manifest, 'read', ['orders', { all: true }]) });
		const asked = reads;
		expect(asked).toBeGreaterThan(0);
		live.publish([{ model: 'orders', id: randomUUID(), op: 'create', revision: 1, transaction: '1', cause: 'direct', old: null, new: { title: 'new' } }]);
		yield* live.settled;
		expect(reads).toBe(asked);
		expect(yield* live.retained).toBe(0);
	}).pipe(Effect.scoped)
);
