// End to end through the engine entry and the test kit: a live view on the engine's hub receives every commit the
// cell makes as a patch, stamped with the lane sequence the act replied with (rules 64–66).
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, Stream } from 'effect';
import type { Frame } from '../src/protocol/wire.ts';
import { lowerRead } from '../src/engine/query/engine.ts';
import { Live, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { ACME, callbacks as manifest, guest, seed } from './engine-fixture.ts';

const workspace = Layer.unwrap(
	program(guest.source).pipe(Effect.map((guest) => TestWorkspace.layer({ manifest, guest, seed })))
);

describe('a live subscription on the engine', () => {
	it.live("receives the committed row, stamped with the act's sequence", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const t = yield* TestWorkspace,
					live = yield* Live,
					writes = yield* Writes;
				const rep = t.as(t.member(['rep'])).authority;
				const frames: Frame[] = [];
				const hello = yield* Deferred.make<string>();
				const patched = yield* Deferred.make<void>();
				yield* live.connect(rep).pipe(
					Stream.runForEach((frame) =>
						Effect.gen(function* () {
							frames.push(frame);
							if (frame.t === 'hello') yield* Deferred.succeed(hello, frame.conn);
							if (frame.t === 'patch') yield* Deferred.succeed(patched, undefined);
						})
					),
					Effect.forkScoped
				);
				const conn = yield* Deferred.await(hello);
				yield* live.register(conn, 'orders', {
					read: lowerRead(manifest, 'query', ['orders', { all: true, select: { title: true } }])
				});
				const r = yield* writes.act({
					collection: 'orders',
					verb: 'create',
					mode: { _tag: 'Direct' },
					input: { title: ' desk ', region: 'north', customer: ACME },
					key: 'k1',
					issuedAt: t.clock.now(),
					authority: rep,
					bindings: {
						now: t.clock.now(),
						today: t.clock.now().slice(0, 10),
						tz: 'UTC',
						params: {}
					},
					invocationId: 'i1'
				});
				expect(r.outcome.kind).toBe('committed');
				yield* live.settled;
				yield* Deferred.await(patched);
				// the first answer, then the commit as a patch built from its RETURNING image
				const last = frames.findLast((frame) => frame.t === 'patch');
				if (last?.t !== 'patch') throw new Error('Missing committed patch');
				expect(last.v).toBe(r.v);
				expect(last.ops).toMatchObject([{ op: 'upsert', index: 0, row: { title: 'desk' } }]);
			})
		).pipe(Effect.provide(workspace))
	);
});
