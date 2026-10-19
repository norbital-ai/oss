// @vitest-environment happy-dom
// The agent panel's restored pieces (§5.9, §5.10) over the real handler: the live `conversations` read lists the
// member's own root in-app conversations and the envoy threads they may read, most recently active first,
// titled by the engine or the first message; the selector segments them by source and opens a thread read-only; the
// raw-context tab shows an administrator the state a triage decision was made from. While a turn runs the
// panel offers Stop, a message sent meanwhile waits in the queue (removable), a stopped conversation offers Resume, and a
// settled reply feeds the context meter (the last call's context against the model's window).
import './setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it } from '@effect/vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	ManagedRuntime,
	Result,
	Schema,
	Stream
} from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Agents } from '../src/engine/services.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { AgentConversation } from '../src/protocol/schema.ts';
import { ReadFailed } from '../src/decl/errors.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { DecisionAnswer } from '../src/engine/decisions/index.ts';
import { conversationId } from '../src/engine/conversations/store.ts';
import Agent from '../src/shell/agent/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { KitInvalid, respondSystem1, TestWorkspace } from '../src/test/index.ts';

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
/** The same workspace with a public whatsapp envoy and triage on, so an inbound message becomes an envoy thread with a decision. */
const envoyManifest = Result.getOrThrow(
	decodeManifest({
		...manifest,
		workspace: { tz: 'UTC', locale: 'en', agent: {} },
		policies: { rep: { description: 'Rep', grants: {} } },
		connections: { whatsapp: { integration: 'whatsapp', envoy: 'field_ops' } },
		envoys: {
			field_ops: {
				audience: 'public',
				name: 'Norbius',
				policies: ['rep'],
				triage: {},
				groupMessages: 'disabled',
				delegation: 'disabled',
				task: 'Help.'
			}
		}
	})
);
const tick = Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(flushSync)));
const until = (ok: () => boolean, n = 600) =>
	Effect.gen(function* () {
		for (let i = 0; i < n && !ok(); i++) yield* tick;
		expect(ok()).toBe(true);
	});
const press = (b: HTMLElement) =>
	Effect.gen(function* () {
		b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		b.click();
		yield* tick;
	});
const reply = (content: string): AiResponse => ({
	content,
	toolCalls: [],
	finish: 'stop',
	usage: { input: 1_500, output: 20 }
});
const ORIGIN = 'http://cell';

const setup = (
	infer: () => Effect.Effect<AiResponse>,
	m: EngineManifest = manifest,
	ask: Ai['Service']['ask'] = respondSystem1
) =>
	Effect.gen(function* () {
		const ports = Layer.succeed(Ai, {
			ask,
			maxChoices: undefined,
			models: ['default'],
			catalog: Port.unavailable('ai.catalog'),
			embed: () => Port.unavailable('ai.embed'),
			infer: () =>
				Stream.fromEffect(
					infer().pipe(Effect.map((response) => ({ _tag: 'Response' as const, response })))
				)
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: m,
				ports,
				host: { publicUrl: ORIGIN },
				now: new Date(yield* Clock.currentTimeMillis).toISOString()
			})
		);
		const t = Context.get(context, TestWorkspace),
			agent = Context.get(context, Agents);
		for (const id of ['ann', 'bob'])
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name) VALUES ($1, $2, $1)`,
				params: [id, `${id}@x.test`]
			});
		const cookies = new Map<string, string>();
		for (const id of ['ann', 'bob']) cookies.set(id, yield* t.session(id));
		let as = 'ann';
		const request = (input: string | URL | Request, init?: RequestInit) => {
			const incoming = new Request(
				new URL(input instanceof Request ? input.url : String(input), ORIGIN),
				input instanceof Request ? input : init
			);
			const cookie = cookies.get(incoming.headers.get('x-user') ?? as);
			if (cookie !== undefined) incoming.headers.set('cookie', cookie);
			return t.handle(incoming);
		};
		const run = yield* FiberSet.makeRuntimePromise();
		const fetch: typeof globalThis.fetch = (input, init) => run(request(input, init));
		const api = shellApi(fetch, { base: ORIGIN }),
			bolt = yield* liveBolt(fetch);
		yield* Effect.acquireRelease(
			Effect.sync(() => mountEdge(ManagedRuntime.make(Layer.empty))),
			(dispose) =>
				Effect.tryPromise({
					try: dispose,
					catch: (error) => new KitInvalid({ message: String(error) })
				}).pipe(Effect.orDie)
		);
		return {
			t,
			agent,
			fetch,
			request,
			api,
			bolt,
			run,
			as: (who: string) => {
				as = who;
			}
		};
	});
/** The member's conversation list as the panel reads it: the live `conversations` read's current answer. */
const listOf = (fetch: typeof globalThis.fetch) =>
	Effect.scoped(
		Effect.gen(function* () {
			const bolt = yield* liveBolt(fetch);
			const read = Object.assign(
				Effect.fail(new ReadFailed({ code: 'liveOnly', message: 'live only' })),
				{ read: { m: 'conversations' as const, a: [] } }
			);
			const values = yield* bolt.live(read).pipe(Stream.take(1), Stream.runCollect);
			return (yield* Schema.decodeUnknownEffect(
				Schema.Struct({ rows: Schema.Array(AgentConversation) })
			)(values[0])).rows;
		})
	);

/** The same workspace with one MCP server: the session rail's Connectors. */
const railManifest = Result.getOrThrow(
	decodeManifest({
		...manifest,
		mcp: { hq: { description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } } }
	})
);

describe('the agent panel restored', () => {
	it.live(
		"an administrator's runtime settings: a spent monthly limit refuses the next turn, and the model list narrows",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const s = yield* setup(() => Effect.succeed(reply('Should not run.')));
					yield* s.t.db.write({
						text: `UPDATE sys_user SET admin = true WHERE id = 'ann'`,
						params: []
					});
					expect(
						yield* s.api.settingsOp('setAgent', { monthly: 0, member: null, models: ['default'] })
					).toBeNull();
					const models = yield* s.api.agent.models();
					expect(models.models.map((x) => x.id)).toEqual(['default']);
					expect(models.admin?.settings).toEqual({
						monthly: 0,
						member: null,
						policies: {},
						models: ['default']
					});
					expect(models.admin?.policies).toEqual([]);
					// a cap names a declared policy
					expect(
						(yield* Effect.flip(
							s.api.settingsOp('setAgent', {
								monthly: null,
								member: null,
								policies: { nobody: 5 },
								models: []
							})
						)).message
					).toMatch(/No policy 'nobody'/);
					expect(models.admin?.spent).toBe(0);
					const started = yield* s.api.agent.start('Limited');
					if (started.kind !== 'committed') throw new Error('start');
					const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
						started.output
					);
					yield* s.api.agent.post(id, 'hello');
					yield* s.t.settled();
					const rows = (yield* s.agent.transcript(id)).filter((r) => r.role === 'assistant');
					expect(rows.map((r) => r.text)).toEqual([
						'I stopped here: the assistant reached its spending limit for this month. An administrator can raise it in Settings.'
					]);
				})
			)
	);

	it.live(
		'the meter opens the session rail: closed cards for the context, the changes and the connected MCP servers',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const s = yield* setup(() => Effect.succeed(reply('Read it.')), railManifest);
					// an administrator holds every declared server (rule 58)
					yield* s.t.db.write({
						text: `UPDATE sys_user SET admin = true WHERE id = 'ann'`,
						params: []
					});
					const models = yield* s.api.agent.models();
					expect(models.mcp).toEqual([{ name: 'hq', description: 'HQ tools' }]);
					try {
						sessionStorage.clear();
					} catch {
						/* none */
					}
					const target = document.createElement('div');
					document.body.append(target);
					const v = mount(Agent, {
						target,
						props: { api: s.api, bolt: s.bolt, t: (k: string) => k, request: {}, onClose: () => {} }
					});
					try {
						const box = target.querySelector('textarea')!;
						box.value = 'hello';
						box.dispatchEvent(new Event('input', { bubbles: true }));
						flushSync();
						box.dispatchEvent(
							new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
						);
						yield* until(() =>
							[...target.querySelectorAll('[data-role="assistant"]')].some((a) =>
								(a.textContent ?? '').includes('Read it.')
							)
						);
						expect(target.querySelector('[data-agent-rail]')).toBeNull();
						target.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
						flushSync();
						const rail = target.querySelector('[data-agent-rail]')!;
						const head = (card: string) =>
							rail
								.querySelector(`[data-rail="${card}"] summary`)
								?.textContent?.replace(/\s+/g, ' ');
						expect(head('context')).toContain('1%');
						expect(head('changes')).toContain('Changes');
						expect(head('connectors')).toContain('1 connected');
						expect(rail.querySelector('[data-rail="tasks"]')).toBeNull(); // no sub-agent, no card
						expect(rail.querySelector('details[open]')).toBeNull(); // every card starts closed
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

	it.live(
		"lists only the member's own root conversations, newest first, titled by the engine or the first message",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const s = yield* setup(() => Effect.succeed(reply('Done.')));
					const start = (title?: string) =>
						s.api.agent.start(title).pipe(
							Effect.flatMap((r) => {
								if (r.kind !== 'committed') throw new Error('start');
								return Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
									r.output
								).pipe(Effect.map((value) => value.id));
							})
						);
					const first = yield* start();
					yield* s.api.agent.post(first, 'Draft the Kismis quote\nwith two lines', true);
					yield* s.t.settled();
					s.t.clock.set(new Date(Date.parse(s.t.clock.now()) + 1).toISOString());
					const second = yield* start('Budget review');
					yield* s.api.agent.post(second, 'numbers please', true);
					yield* s.t.settled();
					yield* s.agent.start({ owner: 'ann', parent: first, title: 'a sub-agent' }); // a child is never a root
					s.as('bob');
					const other = yield* start('Bob only');
					s.as('ann');
					const rows = yield* listOf(s.fetch);
					expect(rows.map((c) => c.id)).toEqual([second, first]);
					expect(rows.map((c) => c.title)).toEqual([
						'Budget review',
						'Draft the Kismis quote\nwith two lines'
					]);
					expect(rows.map((c) => c.id)).not.toContain(other);
					expect(Number.isNaN(Date.parse(rows[0]!.at))).toBe(false);
					expect(rows.every((c) => c.status === 'idle')).toBe(true);
					const models = yield* s.api.agent.models();
					expect(models).toEqual({
						models: [{ id: 'default', label: 'default' }],
						default: 'default',
						mcp: []
					});
					// the list is the panel's only source: there is no polling endpoint and no second stream
					expect((yield* s.request('/__bolt/agent/conversations')).status).toBe(404);
					expect((yield* s.request(`/__bolt/agent/stream?conversation=${first}`)).status).toBe(404);
				})
			)
	);

	it.live(
		'a sent message is on screen before the server answers: the new conversation and the post follow behind it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const s = yield* setup(() => Effect.succeed(reply('Hi.')));
					try {
						sessionStorage.clear();
					} catch {
						/* none */
					}
					const held = yield* Deferred.make<void>();
					// every write waits until the test opens it: the panel has no server answer yet
					const slow: typeof globalThis.fetch = (input, init) =>
						s.run(
							(init?.method === 'POST' ? Deferred.await(held) : Effect.void).pipe(
								Effect.andThen(s.request(input, init))
							)
						);
					const target = document.createElement('div');
					document.body.append(target);
					const v = mount(Agent, {
						target,
						props: {
							api: shellApi(slow, { base: ORIGIN }),
							bolt: s.bolt,
							t: (k: string) => k,
							request: {},
							onClose: () => {}
						}
					});
					try {
						const box = target.querySelector('textarea')!;
						box.value = 'where is the van?';
						box.dispatchEvent(new Event('input', { bubbles: true }));
						flushSync();
						box.dispatchEvent(
							new KeyboardEvent('keydown', {
								key: 'Enter',
								bubbles: true,
								cancelable: true,
								ctrlKey: true
							})
						);
						flushSync();
						expect(
							[...target.querySelectorAll('[data-role="user"] [data-text]')].map(
								(e) => e.textContent
							)
						).toEqual(['where is the van?']);
						expect(box.value).toBe('');
						yield* Deferred.succeed(held, undefined);
						yield* until(() =>
							[...target.querySelectorAll('[data-role="assistant"]')].some((a) =>
								(a.textContent ?? '').includes('Hi.')
							)
						);
						expect(target.querySelectorAll('[data-role="user"]')).toHaveLength(1); // the stored row replaced it, never both
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

	it.live(
		'Stop while a turn runs, a queued message is removable, Resume once stopped, and the context meter after a reply',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const release = yield* Deferred.make<AiResponse>();
					let calls = 0;
					const s = yield* setup(() =>
						Effect.suspend(() =>
							++calls === 1 ? Deferred.await(release) : Effect.succeed(reply('Resumed.'))
						)
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
						props: { api: s.api, bolt: s.bolt, t: (k: string) => k, request: {}, onClose: () => {} }
					});
					const box = () => target.querySelector('textarea')!;
					const enter = (body: string) => {
						box().value = body;
						box().dispatchEvent(new Event('input', { bubbles: true }));
						flushSync();
						box().dispatchEvent(
							new KeyboardEvent('keydown', {
								key: 'Enter',
								bubbles: true,
								cancelable: true,
								ctrlKey: true
							})
						);
					};
					try {
						enter('first question');
						yield* until(() => target.querySelector('[data-agent-stop]') !== null);
						yield* until(() => box().value === '');
						enter('a follow-up');
						yield* until(() =>
							(target.querySelector('[data-agent-queue]')?.textContent ?? '').includes(
								'a follow-up'
							)
						);
						// shown at once; removable once stored
						yield* until(
							() => target.querySelector('[data-agent-queue] button[aria-label="Remove"]') !== null
						);
						target
							.querySelector<HTMLButtonElement>('[data-agent-queue] button[aria-label="Remove"]')!
							.click();
						yield* until(() => target.querySelector('[data-agent-queue]') === null);
						target.querySelector<HTMLButtonElement>('[data-agent-stop]')!.click();
						yield* until(() => document.querySelector('[data-confirm]') !== null); // Stop asks first (staging)
						document.querySelector<HTMLButtonElement>('[data-confirm]')!.click();
						yield* Deferred.succeed(release, reply('Too late.'));
						yield* until(() => target.querySelector('[data-agent-resume]') !== null);
						expect(target.querySelector('[data-stopped]')).not.toBeNull();
						target.querySelector<HTMLButtonElement>('[data-agent-resume]')!.click();
						yield* until(() =>
							[...target.querySelectorAll('[data-role="assistant"]')].some((a) =>
								(a.textContent ?? '').includes('Resumed.')
							)
						);
						yield* s.t.settled();
						yield* until(() =>
							(
								target.querySelector('[data-context-meter]')?.getAttribute('aria-label') ?? ''
							).includes('1.5k / 200.0k')
						);
						// the selector names the conversation by its first message
						expect((yield* listOf(s.fetch))[0]?.title).toBe('first question');
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

	it.live(
		'while a turn runs the orb spins and the placeholder counts seconds; plain Tab toggles plan mode (L-BOLT-436, 541, 548)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const release = yield* Deferred.make<AiResponse>();
					const s = yield* setup(() => Deferred.await(release));
					try {
						sessionStorage.clear();
					} catch {
						/* none */
					}
					const target = document.createElement('div');
					document.body.append(target);
					const v = mount(Agent, {
						target,
						props: { api: s.api, bolt: s.bolt, t: (k: string) => k, request: {}, onClose: () => {} }
					});
					const box = () => target.querySelector('textarea')!;
					try {
						box().dispatchEvent(
							new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
						);
						flushSync();
						expect(target.querySelector('[data-mode="plan"]')).not.toBeNull();
						box().dispatchEvent(
							new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
						);
						flushSync();
						expect(target.querySelector('[data-mode]')).toBeNull();
						box().value = 'think hard';
						box().dispatchEvent(new Event('input', { bubbles: true }));
						flushSync();
						box().dispatchEvent(
							new KeyboardEvent('keydown', {
								key: 'Enter',
								bubbles: true,
								cancelable: true,
								ctrlKey: true
							})
						);
						yield* until(() => target.querySelector('[data-accretion-disc]') !== null);
						expect(target.querySelector('[data-accretion-disc]')?.getAttribute('aria-label')).toBe(
							'Working…'
						);
						yield* until(() =>
							/Thinking… [1-9]\d*s/.test(target.querySelector('[data-thinking]')?.textContent ?? '')
						);
						yield* Deferred.succeed(release, reply('Done.'));
						yield* until(() => target.querySelector('[data-accretion-disc]') === null);
						expect(target.querySelector('[data-thinking]')).toBeNull();
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

	it.live(
		'groups the picker by where each conversation happens and opens an envoy thread read-only',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const s = yield* setup(() => Effect.succeed(reply('Done.')), envoyManifest);
					const handle = '6590000001@s.whatsapp.net';
					yield* s.t.receive('whatsapp', {
						id: 'w1',
						thread: handle,
						sentAt: s.t.clock.now(),
						from: { handle, name: 'Kim' },
						text: 'hello?',
						attachments: []
					});
					// a group chat carries its name (WhatsApp's group subject), and the picker heads its conversation with it
					yield* s.t.receive('whatsapp', {
						id: 'g1',
						thread: '120363000000000001@g.us',
						sentAt: s.t.clock.now(),
						from: { handle, name: 'Kim' },
						text: 'crew update',
						group: true,
						title: 'Site crew',
						attachments: []
					});
					yield* s.t.settled();
					const thread = conversationId('whatsapp', handle);
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
							api: s.api,
							bolt: s.bolt,
							t: (k: string) => k,
							request: {},
							onClose: () => {},
							admin: true,
							envoys: { field_ops: 'Norbius' }
						}
					});
					try {
						// the live list is here once the picker stops saying there are none
						yield* until(
							() =>
								!(
									target.querySelector('[data-agent-head] [role="combobox"]')?.textContent ?? ''
								).includes('No conversations yet')
						);
						yield* press(target.querySelector<HTMLElement>('[data-agent-head] [role="combobox"]')!);
						yield* until(
							() => document.querySelector(`[role="option"][data-value="${thread}"]`) !== null
						);
						// no segment tabs: the picker's own headings say where each conversation happens, DMs before groups
						expect(target.querySelector('[data-agent-groups]')).toBeNull();
						expect(
							[...document.querySelectorAll('li[role="presentation"].text-overline')].map((x) =>
								x.textContent?.trim()
							)
						).toEqual(['Norbius (DM)', 'Norbius (Group: Site crew)']);
						// choosing opens the thread, with no composer
						yield* press(
							document.querySelector<HTMLElement>(`[role="option"][data-value="${thread}"] button`)!
						);
						yield* until(() => target.querySelector('[data-agent-read-only]') !== null);
						expect(target.querySelector('textarea')).toBeNull();
						expect(target.querySelector('[data-role="user"] [data-text]')?.textContent).toBe(
							'hello?'
						);
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

	it.live(
		'a scale mark closes each triaged batch and opens, for an administrator, to what the decider received and answered',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const s = yield* setup(() => Effect.succeed(reply('Done.')), envoyManifest);
					const handle = '6590000001@s.whatsapp.net';
					yield* s.t.receive('whatsapp', {
						id: 'w1',
						thread: handle,
						sentAt: s.t.clock.now(),
						from: { handle, name: 'Kim' },
						text: 'hello?',
						attachments: []
					});
					yield* s.t.settled();
					s.t.clock.advance('2s'); // the triage debounce elapses: the decision is made and its event written
					yield* s.t.runDue();
					yield* s.t.settled();
					const thread = conversationId('whatsapp', handle);
					yield* s.t.db.write({
						text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`,
						params: []
					});
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
							api: s.api,
							bolt: s.bolt,
							t: (k: string) => k,
							request: { conversation: thread },
							onClose: () => {},
							admin: true
						}
					});
					try {
						yield* until(() => target.querySelector('[data-agent-read-only]') !== null);
						// the mark follows the message it decided, inline in the transcript (no tab)
						yield* until(() => target.querySelector('[data-decision-toggle]') !== null);
						const mark = target.querySelector('[data-role="decision"]')!;
						expect(mark.previousElementSibling?.getAttribute('data-role')).toBe('user');
						expect(mark.getAttribute('data-action')).toBe('respond');
						yield* press(target.querySelector<HTMLElement>('[data-decision-toggle]')!);
						yield* until(() => target.querySelector('[data-decision-matrix]') !== null);
						const d = target.querySelector('[data-decision-matrix]')!;
						const m0 = [...d.querySelectorAll('[data-decision-row="m0"] td')].map((x) =>
							x.textContent?.trim()
						);
						expect(m0).toEqual(['Kim: hello?', 'yes', 'yes']);
						expect(
							d.querySelector('[data-decision-row="wait"] td:nth-child(2)')?.textContent?.trim()
						).toBe('0 (1)');
						expect(d.querySelector('[data-decision-context]')?.textContent).toContain('Help.'); // the directive the decider was given
						expect(d.querySelector('[data-decision-context]')?.textContent).toContain('Norbius'); // the assistant it was asked about
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

	it.live(
		'a decided reply not written yet says so beside its mark, live, until the reply lands',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const release = yield* Deferred.make<AiResponse>();
					const s = yield* setup(() => Deferred.await(release), envoyManifest);
					const handle = '6590000001@s.whatsapp.net';
					yield* s.t.receive('whatsapp', {
						id: 'w1',
						thread: handle,
						sentAt: s.t.clock.now(),
						from: { handle, name: 'Kim' },
						text: 'hello?',
						attachments: []
					});
					yield* s.t.settled();
					s.t.clock.advance('2s');
					yield* Effect.forkScoped(s.t.runDue()); // the turn starts and holds on the model
					const thread = conversationId('whatsapp', handle);
					yield* s.t.db.write({
						text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`,
						params: []
					});
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
							api: s.api,
							bolt: s.bolt,
							t: (k: string) => k,
							request: { conversation: thread },
							onClose: () => {},
							admin: true
						}
					});
					try {
						yield* until(
							() =>
								target.querySelector(
									'[data-role="decision"][data-awaiting] [data-reply-pending]'
								) !== null
						);
						yield* Deferred.succeed(release, reply('On my way.'));
						yield* until(
							() =>
								target.querySelector('[data-role="assistant"]') !== null &&
								target.querySelector('[data-reply-pending]') === null
						);
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

	it.live(
		'messages the decider left fold into one "not for the assistant" block that carries their decision; an empty message is not drawn',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const no: Ai['Service']['ask'] = (r) =>
						Effect.sync(() => {
							return {
								costUsd: 0,
								provider: 'test',
								answers: Object.fromEntries(
									Object.entries(r.questions).map(([id, q]): readonly [string, DecisionAnswer] => [
										id,
										q.type === 'choice'
											? { type: 'choice', choice: 'no', confidence: 1, probabilities: {} }
											: {
													type: 'score',
													score: 0,
													level: 0,
													confidence: 1,
													probabilities: {},
													legend: {}
												}
									])
								)
							};
						});
					const group = Result.getOrThrow(
						decodeManifest({
							...envoyManifest,
							envoys: {
								field_ops: {
									...envoyManifest.envoys['field_ops'],
									groupMessages: 'mention_or_reply'
								}
							}
						})
					);
					const s = yield* setup(() => Effect.succeed(reply('Done.')), group, no);
					const handle = '6590000001@s.whatsapp.net',
						thread = '1203@g.us';
					for (const [id, text] of [
						['w1', 'lunch?'],
						['w2', ''],
						['w3', 'the usual place']
					] as const)
						yield* s.t.receive('whatsapp', {
							id,
							thread,
							group: true,
							sentAt: s.t.clock.now(),
							from: { handle, name: 'Kim' },
							text,
							attachments: []
						});
					yield* s.t.settled();
					s.t.clock.advance('2s');
					yield* s.t.runDue();
					yield* s.t.settled();
					yield* s.t.db.write({
						text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`,
						params: []
					});
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
							api: s.api,
							bolt: s.bolt,
							t: (k: string) => k,
							request: { conversation: conversationId('whatsapp', thread) },
							onClose: () => {},
							admin: true
						}
					});
					try {
						yield* until(
							() => target.querySelector('[data-role="ignored"] [data-decision-toggle]') !== null
						);
						const block = target.querySelector('[data-role="ignored"]')!;
						expect([...block.querySelectorAll('[data-text]')].map((x) => x.textContent)).toEqual([
							'lunch?',
							'the usual place'
						]);
						expect(block.getAttribute('data-action')).toBe('ignore');
						expect(target.querySelectorAll('[data-role="ignored"]')).toHaveLength(1);
						expect(target.querySelector('[data-role="decision"]')).toBeNull(); // no divider of its own
						yield* press(block.querySelector<HTMLElement>('[data-decision-toggle]')!);
						yield* until(() => block.querySelector('[data-decision-matrix]') !== null);
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

	it.live('a member who is not an administrator sees no decision marks', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const s = yield* setup(() => Effect.succeed(reply('Done.')), envoyManifest);
				const handle = '6590000001@s.whatsapp.net';
				yield* s.t.receive('whatsapp', {
					id: 'w1',
					thread: handle,
					sentAt: s.t.clock.now(),
					from: { handle, name: 'Kim' },
					text: 'hello?',
					attachments: []
				});
				yield* s.t.settled();
				const thread = conversationId('whatsapp', handle);
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
						api: s.api,
						bolt: s.bolt,
						t: (k: string) => k,
						request: { conversation: thread },
						onClose: () => {}
					}
				});
				try {
					yield* until(() => target.querySelector('[data-agent-read-only]') !== null);
					yield* until(() => target.querySelector('[data-role="user"]') !== null);
					expect(target.querySelector('[data-decision-toggle]')).toBeNull();
					expect(target.querySelector('[role="tab"]')).toBeNull();
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
});
