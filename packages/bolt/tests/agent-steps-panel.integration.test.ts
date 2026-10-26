// @vitest-environment happy-dom
// The agent panel folds each run of consecutive tool steps into one quiet group ("Worked for 1s · 3 steps"), Codex-style,
// marked when a step failed and closed once the turn settled; a reply ends it. Each step is a row (verb, target,
// duration) opening to its input and result behind one tab each, the failing call's icon an alert. Staging's failing loop
// was a wall of rows.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from '@effect/vitest';
import { Clock, Context, Effect, FiberSet, Layer, ManagedRuntime, Result } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
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

it.live(
	'a run of tool steps is one collapsed "Worked for" group with a failure mark; a reply ends it',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const script: AiResponse[] = [
					use('history', { query: 'quote' }),
					use('read', { collection: 'quotes', where: { month: 'x' } }),
					use('read', { collection: 'quotes', where: { year: 'x' } }),
					{
						content: 'No month field on quotes.',
						toolCalls: [],
						finish: 'stop',
						usage: { input: 1, output: 1 }
					}
				];
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						now: new Date(yield* Clock.currentTimeMillis).toISOString(),
						fakes: { ai: { cassette: { default: script } } }
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
						request: { prompt: 'why?' },
						onClose: () => {}
					}
				});
				try {
					// User interaction follows Svelte's attachment and effect setup.
					flushSync();
					target
						.querySelector('form')!
						.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
					yield* until(
						() =>
							target
								.querySelector('[data-role="assistant"]')
								?.textContent?.includes('No month field') === true
					);
					const runs = target.querySelectorAll('[data-role="steps"]');
					expect(runs).toHaveLength(1);
					yield* until(() => runs[0]!.querySelector('[data-working]') === null);
					expect(runs[0]!.querySelector('summary')!.textContent).toMatch(
						/Worked for \d+s\s*· 3 steps/
					);
					expect(runs[0]!.hasAttribute('data-failed')).toBe(true);
					expect(runs[0]!.querySelector('details')!.open).toBe(false);
					const steps = [...target.querySelectorAll('[data-step]')];
					expect(steps.map((e) => e.getAttribute('data-step-state'))).toEqual([
						'done',
						'failed',
						'failed'
					]);
					expect(
						steps.map((e) =>
							e
								.querySelector('summary')!
								.textContent!.replace(/\s+/g, ' ')
								.trim()
								.replace(/ \d+(\.\d)?s$/, '')
						)
					).toEqual(['Searched past messages quote', 'Read quotes', 'Read quotes']);
					// a step opens to its input and result, one tab each, rendered only once opened
					expect(steps[1]!.querySelector('[role="tabpanel"]')).toBeNull();
					steps[1]!.querySelector('details')!.open = true;
					yield* until(() => steps[1]!.querySelector('[role="tabpanel"]') !== null);
					expect(
						[...steps[1]!.querySelectorAll('[role="tab"]')].map((e) => [
							e.textContent,
							e.getAttribute('aria-selected')
						])
					).toEqual([
						['Input', 'true'],
						['Output', 'false']
					]);
					expect(steps[1]!.querySelector('[role="tabpanel"]')!.textContent).toContain('Month');
					expect(steps[1]!.querySelector('[role="tabpanel"] .cm-editor')).toBeNull();
					steps[1]!.querySelector<HTMLElement>('[data-pane="output"]')!.click();
					yield* until(
						() => steps[1]!.querySelector('[aria-selected="true"]')?.textContent === 'Output'
					);
					expect(steps[1]!.querySelector('[role="tabpanel"]')!.textContent).toMatch(/error/i); // the run sits between the question and the reply
					expect(
						[...target.querySelectorAll('ol[aria-live] > li')].map((e) =>
							e.getAttribute('data-role')
						)
					).toEqual(['user', 'steps', 'assistant']);
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
