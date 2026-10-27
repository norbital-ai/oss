// @vitest-environment happy-dom
// A built preview is the panel header's one Preview button, never a link nor a card per step: it opens the session rail's
// one previewer, which shows the latest preview in the shared web view (mounted only while open) under its caption; a dot
// marks a preview not yet seen. Staging's Norbius handed the person a long raw URL instead.
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
		exposures: { quotes: { read: { quotes: { fields: 'all' } } } },
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

it.live(
	'a built preview opens in the previewer from the header Preview button, which closes it again',
	() =>
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
					expect(open.getAttribute('aria-label')).toBe('New preview');
					expect(open.querySelector('[data-preview-unseen]')).not.toBeNull();
					// one button in the header, no card per step
					expect(target.querySelectorAll('[data-open-preview]')).toHaveLength(1);
					expect(target.querySelector('[data-outcome]')).toBeNull();
					// no frame, and no rail, until the button opens it
					expect(target.querySelector('iframe')).toBeNull();
					expect(target.querySelector('[data-rail="preview"]')).toBeNull();
					open.click();
					yield* until(() => target.querySelector(`[data-agent-preview="${PREVIEW}"]`) !== null);
					expect(target.querySelector('[data-rail-expand]')).toBeNull();
					expect(target.querySelector('iframe')?.getAttribute('src')).toBe(PREVIEW);
					expect(
						target.querySelector('[data-agent-rail] [data-rail]')?.getAttribute('data-rail')
					).toBe('preview');
					// seen: the dot clears
					yield* until(() => open.querySelector('[data-preview-unseen]') === null);
					expect(open.getAttribute('aria-label')).toBe('Preview');
					// what it shows is one tap away, behind the frame's details (ⓘ)
					target.querySelector<HTMLElement>('[aria-label="Details"]')!.click();
					yield* until(() => document.querySelector('[data-preview-caption]') !== null);
					expect(document.querySelector('[data-preview-caption]')!.textContent).toContain(
						'Draft · Rename title'
					);
					// The transcript stays mounted; the same button folds the frame away.
					expect(target.querySelector('[data-role="assistant"]')).not.toBeNull();
					open.click();
					yield* until(() => target.querySelector('iframe') === null);
					expect(target.querySelector('[data-rail="preview"]')).toBeNull();
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
