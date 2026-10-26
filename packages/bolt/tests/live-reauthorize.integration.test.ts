// A live connection answers only the one who opened it (rules 64–66). When their authority changed since — a policy, a
// team, the record they were just bound to — registering on it re-answers every view under the new authority instead
// of refusing; another member is still refused.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Queue, Schema, Stream } from 'effect';
import { Sse } from 'effect/unstable/encoding';
import type { Authority } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { Frame } from '../src/protocol/schema.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';
import { routeFixture } from './support/route-fixture.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {},
	relationships: {},
	collections: {},
	policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {}
} satisfies EngineManifest;

it.live(
	'the same member with a changed authority re-registers and is answered again; another member is refused',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
				const t = Context.get(context, TestWorkspace),
					route = yield* routeFixture(context);
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann'), ('bob', 'bob@x.test', 'Bob')`,
					params: []
				});
				const authorities = new Authorities(manifest, 'test');
				const ann = yield* authorities.member(t.db, 'ann'),
					bob = yield* authorities.member(t.db, 'bob');
				if (ann === null || bob === null || ann.actor.kind !== 'member')
					throw new Error('Missing test members');
				let who: Authority = ann;
				const frames: Frame[] = [],
					received = yield* Queue.unbounded<Frame>();
				const response = yield* route.handle(who, new Request('http://cell/__bolt/live'));
				if (response.body === null) throw new Error('Missing live stream');
				const body = response.body;
				yield* Stream.fromReadableStream({
					evaluate: () => body,
					onError: (error) => new KitInvalid({ message: String(error) })
				}).pipe(
					Stream.decodeText(),
					Stream.pipeThroughChannel(Sse.decode()),
					Stream.mapEffect((event) =>
						Schema.decodeUnknownEffect(Schema.fromJsonString(Frame))(event.data)
					),
					Stream.runForEach((frame) =>
						Effect.gen(function* () {
							frames.push(frame);
							yield* Queue.offer(received, frame);
						})
					),
					Effect.forkScoped
				);
				const hello = yield* Queue.take(received);
				if (hello.t !== 'hello') throw new Error('Missing hello frame');
				const conn = hello.conn;
				const register = (view: string) =>
					route.handle(
						who,
						new Request('http://cell/__bolt/live', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ conn, add: [{ view, read: { m: 'conversations', a: [] } }] })
						})
					);
				const answers = (view: string) =>
					frames.filter((frame) => frame.t === 'answer' && frame.view === view).length;
				const until = (done: () => boolean) =>
					Effect.gen(function* () {
						while (!done()) yield* Queue.take(received);
						expect(done()).toBe(true);
					});

				expect((yield* register('a')).status).toBe(200);
				yield* until(() => answers('a') === 1);
				// Ann is bound to her record: her authority (its key) changes, her identity does not
				who = {
					...ann,
					key: `${ann.key}:bound`,
					actor: { ...ann.actor, party: { collection: 'customers', id: 'c1' } }
				};
				expect((yield* register('b')).status).toBe(200);
				yield* until(() => answers('a') === 2 && answers('b') === 1);
				who = bob;
				expect((yield* register('c')).status).toBe(403);
			})
		)
);
