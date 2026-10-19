// @vitest-environment happy-dom
// G5's in-app triage cases (rule 60a) in a DOM over the real handler and a test-kit workspace: plain-Enter parts show the
// "waiting for more…" state and are answered as one turn; respond-now and Cmd/Ctrl+Enter start the turn at once with
// every pending row and no decision call; without the port each post starts a turn as before.
import './setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it } from '@effect/vitest';
import {
	Clock,
	Context,
	Effect,
	FiberSet,
	Layer,
	ManagedRuntime,
	Predicate,
	Result,
	Stream
} from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { routeFixture } from './support/route-fixture.ts';
import { mountEdge } from '@norbital-ai/ui/effect';
import type { Json } from '../src/decl/values.ts';
import type { System1Request } from '../src/engine/decisions/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import Agent from '../src/shell/agent/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
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

const tick = Effect.sleep(5).pipe(Effect.andThen(Effect.sync(() => flushSync())));
const until = (ok: () => boolean, n = 600) =>
	Effect.gen(function* () {
		for (let i = 0; i < n && !ok(); i++) yield* tick;
		expect(ok()).toBe(true);
	});
/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) =>
	(typeof c === 'string' ? c : Predicate.isObject(c) ? String(c['text'] ?? '') : '').replace(
		/^\[[^\]]*\]\s*/,
		''
	);

const panel = (o: { triage: boolean }) =>
	Effect.gen(function* () {
		const inputs: System1Request[] = [],
			turns: string[][] = [];
		const ask: Ai['Service']['ask'] = (r) =>
			Effect.sync(() => {
				inputs.push(r);
				return {
					answers: {
						action: { type: 'choice', choice: 'wait', confidence: 1, probabilities: { wait: 1 } },
						wait: {
							type: 'score',
							score: 10,
							level: 10,
							confidence: 1,
							probabilities: {},
							legend: {}
						}
					},
					costUsd: 0,
					provider: 'scripted'
				};
			});
		const infer: Ai['Service']['infer'] = (r) =>
			Stream.suspend(() => {
				turns.push(
					r.messages
						.filter((m) => m.role === 'user' && !text(m.content).startsWith('Now: '))
						.map((m) => text(m.content))
				);
				return Stream.succeed({
					_tag: 'Response',
					response: {
						content: 'On it.',
						toolCalls: [],
						finish: 'stop',
						usage: { input: 1, output: 1 }
					}
				});
			});
		const ports = Layer.succeed(Ai, {
			ask,
			infer,
			models: ['default'],
			maxChoices: undefined,
			catalog: Port.unavailable('ai.catalog'),
			embed: () => Port.unavailable('ai.embed')
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: o.triage
					? manifest
					: { ...manifest, workspace: { ...manifest.workspace, agent: { triage: false } } },
				ports,
				now: new Date(yield* Clock.currentTimeMillis).toISOString()
			})
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context);
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`,
			params: []
		});
		const ann = yield* new Authorities(manifest, 'test').member(t.db, 'ann');
		if (ann === null) throw new Error('Ann has no authority');
		const run = yield* FiberSet.makeRuntimePromise<never>();
		const fetch: typeof globalThis.fetch = (input, init) => {
			const request = new Request(new URL(String(input), 'http://cell'), init);
			return run(route.handle(ann, request), { signal: request.signal });
		};
		const bolt = yield* liveBolt(fetch);
		yield* Effect.acquireRelease(
			Effect.sync(() => mountEdge(ManagedRuntime.make(Layer.empty))),
			(dispose) =>
				Effect.tryPromise({
					try: dispose,
					catch: (error) => new KitInvalid({ message: String(error) })
				}).pipe(Effect.orDie)
		);
		sessionStorage.clear();
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent, {
			target,
			props: { api: shellApi(fetch), bolt, t: (k: string) => k, request: {}, onClose: () => {} }
		});
		yield* Effect.addFinalizer(() =>
			Effect.tryPromise({
				try: () => unmount(v),
				catch: (error) => new KitInvalid({ message: String(error) })
			}).pipe(Effect.andThen(Effect.sync(() => target.remove())), Effect.orDie)
		);
		const box = () => {
			const area = target.querySelector('textarea');
			if (area === null) throw new Error('Agent composer missing');
			return area;
		};
		const enter = (body: string, mod: { metaKey?: boolean; ctrlKey?: boolean } = {}) =>
			Effect.gen(function* () {
				box().value = body;
				box().dispatchEvent(new Event('input', { bubbles: true }));
				flushSync();
				box().dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mod })
				);
				yield* until(() => box().value === '');
				yield* until(() =>
					[...target.querySelectorAll('[data-role="user"] [data-text]')].some(
						(e) => e.textContent === body
					)
				);
			});
		return { t, target, inputs, turns, enter, settled: route.settled };
	});

describe('the agent panel with triage (G5, rule 60a)', () => {
	it.live(
		'two plain-Enter parts wait for more, and respond-now answers them as one turn with no decision call',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const p = yield* panel({ triage: true });
					yield* p.enter('draft a note');
					yield* p.enter('for the Kismis job');
					yield* until(() => p.target.querySelector('[data-role="waiting"]') !== null);
					expect(p.target.querySelectorAll('[data-pending]')).toHaveLength(2);
					expect(p.turns).toHaveLength(0);
					const respond = p.target.querySelector<HTMLButtonElement>('[data-role="waiting"] button');
					if (respond === null) throw new Error('respond-now button missing');
					respond.click();
					yield* until(() =>
						(p.target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes(
							'On it.'
						)
					);
					yield* p.settled;
					expect(p.turns).toEqual([['draft a note', 'for the Kismis job']]);
					expect(p.inputs).toHaveLength(0);
					expect(p.target.querySelector('[data-role="waiting"]')).toBeNull();
				})
			)
	);

	it.live('Cmd/Ctrl+Enter sends now with every pending row; the decider is never asked', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel({ triage: true });
				yield* p.enter('first part');
				yield* p.enter('second part', { ctrlKey: true });
				yield* until(() =>
					(p.target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes('On it.')
				);
				yield* p.settled;
				expect(p.turns).toEqual([['first part', 'second part']]);
				yield* p.t.runDue(); // the decision the first part queued finds nothing pending
				expect(p.inputs).toHaveLength(0);
			})
		)
	);

	it.live('without the port each post starts a turn', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel({ triage: false });
				yield* p.enter('hello');
				yield* until(() =>
					(p.target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes('On it.')
				);
				expect(p.target.querySelector('[data-role="waiting"]')).toBeNull();
			})
		)
	);
});
