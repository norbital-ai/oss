// @vitest-environment happy-dom
// A built preview is an "Open preview" button, never a link: it opens the panel's Preview tab, which shows that preview in
// the shared web view (mounted only while the tab is open) under its caption; Chat returns to the transcript. Staging's
// Norbius handed the person a long raw URL instead.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from '@effect/vitest';
import { Clock, Context, Effect, FiberSet, Layer, ManagedRuntime, Result } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
import type { HostTool } from '../src/engine/agent/index.ts';
import Agent from '../src/shell/agent/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {
			quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } }
		},
		relationships: {},
		collections: { quotes: { read: { fields: 'all' } } },
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
const use = (name: string, input: import('../src/decl/values.ts').Json): AiResponse => ({
	content: '',
	toolCalls: [{ id: randomUUID(), name, input }],
	finish: 'tool',
	usage: { input: 1, output: 1 }
});

const PREVIEW = 'https://acme--u-ann.preview.test/';

it.live('a built preview opens in the Preview tab from its Open preview button', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const validate: HostTool = {
				name: 'workspace_validate',
				description: 'Build the preview',
				input: { type: 'object' },
				studio: 'preview',
				call: async () => ({
					preview: PREVIEW,
					commit: 'abc1234def',
					environment: 'Preview',
					message: 'Rename title',
					changes: [],
					log: Array.from({ length: 40 }, (_, i) => `built step ${i}`)
				})
			};
			const script: AiResponse[] = [
				use('workspace_validate', {}),
				{
					content: 'Built. Open it in the Preview tab.',
					toolCalls: [],
					finish: 'stop',
					usage: { input: 1, output: 1 }
				}
			];
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					now: new Date(yield* Clock.currentTimeMillis).toISOString(),
					fakes: { ai: { cassette: { default: script } } },
					host: { agent: { hostTools: [validate] } }
				})
			);
			const t = Context.get(context, TestWorkspace);
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, admin) VALUES ('ann', 'ann@x.test', 'Ann', true)`,
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
				props: {
					api: shellApi(fetch),
					bolt,
					t: (k: string) => k,
					request: { prompt: 'build it' },
					onClose: () => {}
				}
			});
			try {
				flushSync();
				target
					.querySelector('form')!
					.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
				yield* until(() => target.querySelector('[data-open-preview]') !== null);
				const open = target.querySelector<HTMLElement>('[data-open-preview]')!;
				// a button for the tab, not a link to a page of its own
				expect(open.closest('a')).toBeNull();
				expect(open.getAttribute('href')).toBeNull();
				expect(open.textContent).toBe('Open preview');
				// no frame until the tab opens
				expect(target.querySelector('iframe')).toBeNull();
				expect(target.querySelector('[data-agent-tab="chat"]')!.getAttribute('aria-selected')).toBe(
					'true'
				);
				open.click();
				yield* until(() => target.querySelector(`[data-agent-preview="${PREVIEW}"]`) !== null);
				expect(
					target.querySelector('[data-agent-tab="preview"]')!.getAttribute('aria-selected')
				).toBe('true');
				expect(target.querySelector('iframe')?.getAttribute('src')).toBe(PREVIEW);
				expect(target.querySelector('[data-preview-caption]')!.textContent).toContain(
					"Preview · commit abc1234 'Rename title'"
				);
				expect(target.querySelector('[data-role="assistant"]')).toBeNull();
				target.querySelector<HTMLElement>('[data-agent-tab="chat"]')!.click();
				yield* until(() => target.querySelector('[data-role="assistant"]') !== null);
				expect(target.querySelector('iframe')).toBeNull();
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
