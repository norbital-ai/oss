// A cookie can remain valid after the member or session it names is revoked.
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
	const ask = Effect.gen(function* () {
		const response = yield* t.handle(
			new Request('http://127.0.0.1:4180/__bolt/shell/inbox', {
				headers: { cookie: session }
			})
		);
		yield* Effect.promise(() => response.text());
		return response.status;
	});
	expect(yield* ask).toBe(200);
	return { t, id, ask };
});

describe('session revocation', () => {
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
});
