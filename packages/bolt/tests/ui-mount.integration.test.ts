// @vitest-environment happy-dom
// Mount smoke test (§3.5, §3.6, rules 64–67): the ui next Table, Form and RecordShell over the real `$bolt` client,
// the /__bolt handler and a test-kit workspace on PGlite. A write paints every live view at once and lifts on the
// outcome: a commit stays (the stream carries it), a refusal un-paints.
import './setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from '@effect/vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Fiber,
	FiberSet,
	Layer,
	ManagedRuntime,
	Result,
	Schema
} from 'effect';
import type { KindsHost } from '@norbital-ai/ui';
import { decodeManifest } from '../src/engine/manifest.ts';
import { PATHS } from '../src/protocol/wire.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { liveBolt } from './support/live-bolt.ts';
import { mountEdge } from '@norbital-ai/ui/effect';
import View from './support/ui-mount.svelte';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			tasks: {
				description: 'A task',
				label: 'title',
				fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } }
			}
		},
		relationships: {},
		collections: {
			tasks: {
				read: { fields: 'all' },
				create: { input: { columns: ['title'] } },
				update: { input: { columns: ['title'] } }
			}
		},
		policies: {
			editor: {
				description: 'Edits titles, creates nothing',
				grants: { tasks: { read: true, update: true } }
			}
		},
		integrations: {},
		pipelines: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);
const kinds = {
	catalog: {
		tasks: {
			label: ['title'],
			fields: { title: { kind: 'text' } },
			create: { columns: ['title'] },
			update: { columns: ['title'] }
		}
	}
} satisfies KindsHost;
const tick = Effect.sleep(5).pipe(Effect.andThen(Effect.sync(() => flushSync())));
const until = (ok: () => boolean) =>
	Effect.gen(function* () {
		for (let i = 0; i < 400 && !ok(); i++) yield* tick;
		expect(ok()).toBe(true);
	});

const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({ manifest, now: new Date(yield* Clock.currentTimeMillis).toISOString() })
	);
	const t = Context.get(context, TestWorkspace),
		route = yield* routeFixture(context),
		admin = t.as(t.admin).authority;
	const created = (yield* actReply(route, admin, {
		callable: 'tasks.create',
		input: { title: 'Original' },
		issuedAt: t.clock.now()
	})).outcome;
	if (created.kind !== 'committed' || created.records[0] === undefined)
		throw new Error('task create returned no record');
	const id = created.records[0].id,
		editor = t.as(t.member(['editor'])).authority;
	let gate: Deferred.Deferred<void> | undefined;
	const hold = Effect.gen(function* () {
		gate = yield* Deferred.make<void>();
	});
	const open = Effect.suspend(() =>
		gate === undefined ? Effect.void : Deferred.succeed(gate, undefined).pipe(Effect.asVoid)
	);
	const run = yield* FiberSet.makeRuntimePromise<never>();
	const fetch: typeof globalThis.fetch = (input, init) => {
		const request = new Request(
			input instanceof Request ? input : new URL(String(input), 'http://cell'),
			init
		);
		const wait =
			new URL(request.url).pathname === PATHS.act && gate !== undefined
				? Deferred.await(gate)
				: Effect.void;
		return run(wait.pipe(Effect.andThen(route.handle(editor, request))), {
			signal: request.signal
		});
	};
	const bolt = yield* liveBolt(fetch),
		target = document.createElement('div');
	yield* Effect.acquireRelease(
		Effect.sync(() => mountEdge(ManagedRuntime.make(Layer.empty))),
		(dispose) =>
			Effect.tryPromise({
				try: dispose,
				catch: (error) => new KitInvalid({ message: String(error) })
			}).pipe(Effect.orDie)
	);
	document.body.append(target);
	const view = mount(View, { target, props: { bolt, kinds, id } });
	yield* Effect.addFinalizer(() =>
		open.pipe(
			Effect.andThen(
				Effect.tryPromise({
					try: () => unmount(view),
					catch: (error) => new KitInvalid({ message: String(error) })
				})
			),
			Effect.andThen(Effect.sync(() => target.remove())),
			Effect.orDie
		)
	);
	const text = (section: string) =>
		target.querySelector(`[data-test="${section}"]`)?.textContent ?? '';
	yield* until(() => text('table').includes('Original') && text('record').includes('Original'));
	return { t, route, admin, bolt, id, target, text, hold, open };
});

it.live(
	'a committed update paints Table and RecordShell before the reply, and stays after it',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const { bolt, id, text, hold, open } = yield* fixture;
				yield* hold;
				const outcome = yield* Effect.forkScoped(
					bolt.act('tasks.update', { target: id, set: { title: 'Renamed' } })
				);
				yield* until(() => text('table').includes('Renamed') && text('record').includes('Renamed'));
				expect(text('table')).not.toContain('Original');
				yield* open;
				expect((yield* Fiber.join(outcome)).kind).toBe('committed');
				for (let i = 0; i < 20; i++) yield* tick;
				expect(text('table')).toContain('Renamed');
				expect(text('record')).toContain('Renamed');
			})
		)
);

it.live('a refused update un-paints both views back to the stored row', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { bolt, id, text, hold, open } = yield* fixture;
			yield* hold;
			const outcome = yield* Effect.forkScoped(
				Effect.flip(
					bolt.act('tasks.update', {
						target: id,
						set: { title: 'Sneaky', note: 'not in the allowlist' }
					})
				)
			);
			yield* until(() => text('table').includes('Sneaky') && text('record').includes('Sneaky'));
			yield* open;
			expect((yield* Fiber.join(outcome))._tag).toBe('ActRefused');
			yield* until(() => text('table').includes('Original') && text('record').includes('Original'));
			expect(text('table')).not.toContain('Sneaky');
		})
	)
);

it.live(
	'a create from the Form paints a pending Table row, and a refusal removes it and shows the reason',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const { route, admin, target, text, hold, open } = yield* fixture;
				const input = target.querySelector<HTMLInputElement>(
					'[data-test="form"] [data-field="title"] input'
				);
				if (input === null) throw new Error('create form has no title input');
				input.value = 'Brand new';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				flushSync();
				yield* hold;
				const submit = target.querySelector<HTMLButtonElement>(
					'[data-test="form"] button[type="submit"]'
				);
				if (submit === null) throw new Error('create form has no submit button');
				submit.click();
				yield* until(() => text('table').includes('Brand new'));
				yield* open;
				yield* until(() => !text('table').includes('Brand new'));
				yield* until(() => target.querySelector('[data-test="form"] [role="alert"]') !== null);
				const reply = yield* qReply(route, admin, {
					reads: [{ m: 'read', a: ['tasks', { all: true }] }]
				});
				const rows = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ rows: Schema.Array(Schema.Struct({ title: Schema.String })) })
				)(reply.answers[0]);
				expect(rows.rows.map((row) => row.title)).toEqual(['Original']);
			})
		)
);
