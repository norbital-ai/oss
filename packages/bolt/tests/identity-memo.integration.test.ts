// Who a signed-in caller is rests in memory for fifteen minutes, so a repeat request makes no trip to the database;
// a statement on who may do what ends it at once, so nothing is ever acted on stale.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest } from './write-fixture.ts';

const opened = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			host: {
				publicUrl: 'http://127.0.0.1:4180',
				workspace: () => ({ name: 'Local', handle: 'local' })
			}
		})
	);
	const t = Context.get(context, TestWorkspace);
	const id = randomUUID();
	yield* t.db.write({
		text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@x.test', 'Ada', 'staff', true)`,
		params: [id]
	});
	const session = yield* t.session(id);
	/** A real shell route, whose own data is one read: anything past that is the price of knowing the caller. */
	const ask = Effect.gen(function* () {
		const response = yield* t.handle(
			new Request('http://127.0.0.1:4180/__bolt/shell/inbox', {
				headers: { cookie: session }
			})
		);
		yield* Effect.promise(() => response.text());
		return response.status;
	});
	// a workspace's start-up work lands on its first requests: what follows is the steady cost
	yield* ask;
	yield* ask;
	return { t, id, ask };
});

describe('who a caller is rests in memory', () => {
	it.live('a repeat request asks the database only for its own data', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, ask } = yield* opened;
				t.count.reset();
				expect(yield* ask).toBe(200);
				expect(t.count).toMatchObject({ reads: 1, writes: 0 });
			})
		)
	);
	it.live('a write that has nothing to do with people leaves it standing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, ask } = yield* opened;
				yield* t.db.write({
					text: `INSERT INTO sys_config (key, value) VALUES ('unrelated', 'x')`,
					params: []
				});
				t.count.reset();
				yield* ask;
				expect(t.count.reads).toBe(1);
			})
		)
	);
	it.live('deactivating a member takes effect on their very next request', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, id, ask } = yield* opened;
				yield* t.db.write({
					text: `UPDATE sys_user SET active = false, revision = revision + 1 WHERE id = $1`,
					params: [id]
				});
				expect(yield* ask).toBe(401);
			})
		)
	);
	it.live('taking away a session takes effect on the very next request', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, id, ask } = yield* opened;
				yield* t.db.write({ text: `DELETE FROM sys_session WHERE "user" = $1`, params: [id] });
				expect(yield* ask).toBe(401);
			})
		)
	);
	it.live('it is read again after fifteen minutes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, ask } = yield* opened;
				t.clock.advance('14min');
				yield* t.settled();
				t.count.reset();
				yield* ask;
				expect(t.count.reads).toBe(1);
				t.clock.advance('2min');
				yield* t.settled();
				t.count.reset();
				yield* ask;
				expect(t.count.reads).toBeGreaterThan(1);
			})
		)
	);
});
