// @vitest-environment happy-dom
// The agent panel's file control: a picked file uploads to `/__bolt/files/sys_message.files` on send and the posted
// row carries it, shown by name in the transcript.
import './setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from '@effect/vitest';
import { Clock, Context, Effect, FiberSet, Layer, ManagedRuntime, Result } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import Agent from '../src/shell/agent/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {},
		relationships: {},
		collections: {},
		policies: {},
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		pipelines: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {}
	})
);
const tick = Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(flushSync)));
const until = (ok: () => boolean, n = 600) =>
	Effect.gen(function* () {
		for (let i = 0; i < n && !ok(); i++) yield* tick;
		expect(ok()).toBe(true);
	});

it.live('a picked file uploads on send and the posted row carries it', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					now: new Date(yield* Clock.currentTimeMillis).toISOString(),
					fakes: {
						ai: {
							cassette: {
								default: [
									{
										content: 'Seen.',
										toolCalls: [],
										finish: 'stop',
										usage: { input: 1, output: 1 }
									}
								]
							}
						}
					}
				})
			);
			const t = Context.get(context, TestWorkspace);
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`,
				params: []
			});
			const cookie = yield* t.session('ann');
			const run = yield* FiberSet.makeRuntimePromise();
			const fetch: typeof globalThis.fetch = (input, init) =>
				run(
					Effect.gen(function* () {
						const request = new Request(
							new URL(input instanceof Request ? input.url : String(input), 'http://cell'),
							input instanceof Request ? input : init
						);
						request.headers.set('cookie', cookie);
						return yield* t.handle(request);
					})
				);
			const bolt = yield* liveBolt(fetch);
			yield* Effect.acquireRelease(
				Effect.sync(() => mountEdge(ManagedRuntime.make(Layer.empty))),
				(dispose) =>
					Effect.tryPromise({
						try: dispose,
						catch: (error) => new KitInvalid({ message: String(error) })
					}).pipe(Effect.orDie)
			);
			try {
				sessionStorage.clear();
			} catch {
				/* none */
			}
			const target = document.createElement('div');
			document.body.append(target);
			const v = mount(Agent, {
				target,
				props: { api: shellApi(fetch), bolt, t: (k: string) => k, request: {}, onClose: () => {} }
			});
			try {
				const input = target.querySelector<HTMLInputElement>('input[type="file"]')!;
				Object.defineProperty(input, 'files', {
					configurable: true,
					value: [new File([new Uint8Array([1, 2, 3])], 'pump.png', { type: 'image/png' })]
				});
				input.dispatchEvent(new Event('change', { bubbles: true }));
				flushSync();
				expect(target.querySelector('[data-attached]')?.textContent).toContain('pump.png');
				const box = target.querySelector('textarea')!;
				box.value = 'what is this?';
				box.dispatchEvent(new Event('input', { bubbles: true }));
				flushSync();
				box.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
				);
				yield* until(() =>
					(target.querySelector('[data-attachment]')?.textContent ?? '').includes('pump.png')
				);
				yield* t.settled();
				const [row] = (yield* t.db.read([
					{ text: `SELECT files FROM sys_message WHERE role = 'user'`, params: [] }
				]))[0]!.rows;
				expect(row!['files']).toMatchObject([{ name: 'pump.png', mime: 'image/png', bytes: 3 }]);
				expect(target.querySelector('[data-attached]')).toBeNull();
			} finally {
				yield* Effect.tryPromise({
					try: () => unmount(v),
					catch: (error) => new KitInvalid({ message: String(error) })
				});
				target.remove();
			}
		})
	)
);
