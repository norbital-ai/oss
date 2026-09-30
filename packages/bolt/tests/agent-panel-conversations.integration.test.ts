// @vitest-environment happy-dom
// The agent panel's restored pieces (§5.9, §5.10) over the real handler: the live `conversations` read lists the
// member's own root in-app conversations and the envoy channel threads they may read, most recently active first,
// titled by the engine or the first message; the selector segments them by source and opens a thread read-only; the
// raw-context tab shows an administrator the state a triage decision was made from. While a turn runs the
// panel offers Stop, a message sent meanwhile waits in the queue (removable), a stopped conversation offers Resume, and a
// settled reply feeds the context meter (the last call's context against the model's window).
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { AiPort, AiResponse, EngineManifest } from '../src/engine/contracts.ts';
import { conversationId } from '../src/engine/channels/store.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { AgentConversation } from '../src/protocol/wire.ts';
import Agent from '../src/shell/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { events, type LogQuery } from '../src/shell/data.ts';
import { shellApi, type ShellApi } from '../src/shell/runtime.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
/** The same workspace with a public whatsapp envoy and triage on, so an inbound message becomes a channel thread with a decision. */
const envoyManifest = {
	...manifest,
	workspace: { tz: 'UTC', locale: 'en', agent: {} },
	policies: { rep: { description: 'Rep', grants: {} } },
	channels: { whatsapp: { transport: 'whatsapp' } },
	envoys: { field_ops: { channel: 'whatsapp', audience: 'public', name: 'Norbius', policies: ['rep'], triage: {}, groupMessages: 'disabled', delegation: 'disabled', task: 'Help.' } },
} as unknown as EngineManifest;
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await tick(); expect(ok()).toBe(true); };
const press = async (b: HTMLElement) => {
	b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
	b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
	b.click();
	await tick();
};
const reply = (content: string): AiResponse => ({ content, toolCalls: [], finish: 'stop', usage: { input: 1_500, output: 20 } });

async function setup(infer: () => Promise<AiResponse>, m: EngineManifest = manifest, sys1: AiPort['sys_1'] = respondSystem1) {
	const ai: AiPort = { sys_1: sys1, sys_2: { models: ['default'], infer } };
	const t = await testWorkspace({ manifest: m, ai });
	for (const id of ['ann', 'bob']) await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ($1, $2, $1)`, params: [id, `${id}@x.test`] });
	const authorities = new Authorities(m, 'test');
	let as = 'ann';
	const handle = boltHandler({ engine: t.engine, session: async (r) => authorities.member(t.db, r.headers.get('x-user') ?? as), uuid: randomUUID,
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
		await handle(new Request(new URL(String(url), 'http://cell'), init)) ?? new Response(null, { status: 404 })) as typeof globalThis.fetch;
	// the handler alone serves no shell routes; the panel's raw-context read runs the real `events` on the same db and authority
	const api = { ...shellApi(fetch), logs: async (x: LogQuery) => {
		const a = await authorities.member(t.db, as);
		if (a === null) return { ok: false as const, error: { code: 'unauthenticated', message: 'Sign in first.' }, status: 401 };
		const r = await events(t.db, a, x);
		return r.ok ? { ok: true as const, value: r.value } : { ok: false as const, error: { code: r.code, message: r.message }, status: 403 };
	} } as ShellApi;
	return { t, handle, fetch, api, as: (who: string) => { as = who; } };
}
/** The member's conversation list as the panel reads it: the live `conversations` read's current answer. */
async function listOf(fetch: typeof globalThis.fetch): Promise<AgentConversation[]> {
	const live = liveBolt(fetch).live<{ rows: AgentConversation[] }>({ read: { m: 'conversations', a: [] },
		then: (ok, bad) => Promise.reject<{ rows: AgentConversation[] }>(new Error('live only')).then(ok, bad) });
	let value: { rows: AgentConversation[] } | undefined;
	const off = live.subscribe((v) => { value = v; });
	try { await until(() => value !== undefined); return value!.rows; } finally { off(); }
}

describe('the agent panel restored', () => {
	it('lists only the member\'s own root conversations, newest first, titled by the engine or the first message', async () => {
		const s = await setup(async () => reply('Done.'));
		const start = async (title?: string) => { const r = await s.api.agent.start(title); if (!r.ok || r.value.kind !== 'committed') throw new Error('start'); return String((r.value.output as { id: string }).id); };
		const first = await start();
		await s.api.agent.post(first, 'Draft the Kismis quote\nwith two lines', true);
		await s.handle.settled();
		const second = await start('Budget review');
		await s.api.agent.post(second, 'numbers please', true);
		await s.handle.settled();
		await s.t.engine.agents.start({ owner: 'ann', parent: first, title: 'a sub-agent' }); // a child is never a root
		s.as('bob');
		const other = await start('Bob only');
		s.as('ann');
		const rows = await listOf(s.fetch);
		expect(rows.map((c) => c.id)).toEqual([second, first]);
		expect(rows.map((c) => c.title)).toEqual(['Budget review', 'Draft the Kismis quote\nwith two lines']);
		expect(rows.map((c) => c.id)).not.toContain(other);
		expect(Number.isNaN(Date.parse(rows[0]!.at))).toBe(false);
		expect(rows.every((c) => c.status === 'idle')).toBe(true);
		const models = await s.api.agent.models();
		expect(models.ok && models.value).toEqual({ models: [{ id: 'default', label: 'default' }], default: 'default' });
		// the list is the panel's only source: there is no polling endpoint and no second stream
		expect((await s.fetch('/__bolt/agent/conversations')).status).toBe(404);
		expect((await s.fetch(`/__bolt/agent/stream?conversation=${first}`)).status).toBe(404);
	});

	it('a sent message is on screen before the server answers: the new conversation and the post follow behind it', async () => {
		const s = await setup(() => Promise.resolve(reply('Hi.')));
		try { sessionStorage.clear(); } catch { /* none */ }
		let open!: () => void;
		const held = new Promise<void>((r) => { open = r; });
		// every write waits until the test opens it: the panel has no server answer yet
		const slow = (async (url: string | URL | Request, init?: RequestInit) => { if (init?.method === 'POST') await held; return s.fetch(url, init); }) as typeof globalThis.fetch;
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: shellApi(slow), bolt: liveBolt(s.fetch), t: (k: string) => k, request: {}, onClose: () => {} } });
		try {
			const box = target.querySelector('textarea')!;
			box.value = 'where is the van?';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ctrlKey: true }));
			flushSync();
			expect([...target.querySelectorAll('[data-role="user"] [data-text]')].map((e) => e.textContent)).toEqual(['where is the van?']);
			expect(box.value).toBe('');
			open();
			await until(() => [...target.querySelectorAll('[data-role="assistant"]')].some((a) => (a.textContent ?? '').includes('Hi.')));
			expect(target.querySelectorAll('[data-role="user"]')).toHaveLength(1); // the stored row replaced it, never both
		} finally {
			unmount(v);
			target.remove();
		}
	});

	it('Stop while a turn runs, a queued message is removable, Resume once stopped, and the context meter after a reply', async () => {
		let release: (r: AiResponse) => void = () => {};
		let calls = 0;
		const s = await setup(() => (++calls === 1 ? new Promise<AiResponse>((resolve) => { release = resolve; }) : Promise.resolve(reply('Resumed.'))));
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: {}, onClose: () => {} } });
		const box = () => target.querySelector('textarea')!;
		const enter = (body: string) => {
			box().value = body;
			box().dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ctrlKey: true }));
		};
		try {
			enter('first question');
			await until(() => target.querySelector('[data-agent-stop]') !== null);
			await until(() => box().value === '');
			enter('a follow-up');
			await until(() => (target.querySelector('[data-agent-queue]')?.textContent ?? '').includes('a follow-up'));
			// shown at once; removable once stored
			await until(() => target.querySelector('[data-agent-queue] button[aria-label="Remove"]') !== null);
			target.querySelector<HTMLButtonElement>('[data-agent-queue] button[aria-label="Remove"]')!.click();
			await until(() => target.querySelector('[data-agent-queue]') === null);
			target.querySelector<HTMLButtonElement>('[data-agent-stop]')!.click();
			await until(() => document.querySelector('[data-confirm]') !== null); // Stop asks first (staging)
			document.querySelector<HTMLButtonElement>('[data-confirm]')!.click();
			release(reply('Too late.'));
			await until(() => target.querySelector('[data-agent-resume]') !== null);
			expect(target.querySelector('[data-stopped]')).not.toBeNull();
			target.querySelector<HTMLButtonElement>('[data-agent-resume]')!.click();
			await until(() => [...target.querySelectorAll('[data-role="assistant"]')].some((a) => (a.textContent ?? '').includes('Resumed.')));
			await s.handle.settled();
			await until(() => (target.querySelector('[data-context-meter]')?.getAttribute('aria-label') ?? '').includes('1.5k / 200.0k'));
			// the selector names the conversation by its first message
			expect((await listOf(s.fetch))[0]?.title).toBe('first question');
		} finally { void unmount(v); target.remove(); }
	});

	it('while a turn runs the orb spins and the placeholder counts seconds; plain Tab toggles plan mode (L-BOLT-436, 541, 548)', async () => {
		let release: (r: AiResponse) => void = () => {};
		const s = await setup(() => new Promise<AiResponse>((resolve) => { release = resolve; }));
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: {}, onClose: () => {} } });
		const box = () => target.querySelector('textarea')!;
		try {
			box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			flushSync();
			expect(target.querySelector('[data-mode="plan"]')).not.toBeNull();
			box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			flushSync();
			expect(target.querySelector('[data-mode]')).toBeNull();
			box().value = 'think hard';
			box().dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ctrlKey: true }));
			await until(() => target.querySelector('[data-accretion-disc]') !== null);
			expect(target.querySelector('[data-accretion-disc]')?.getAttribute('aria-label')).toBe('Working…');
			await until(() => /Thinking… [1-9]\d*s/.test(target.querySelector('[data-thinking]')?.textContent ?? ''));
			release(reply('Done.'));
			await until(() => target.querySelector('[data-accretion-disc]') === null);
			expect(target.querySelector('[data-thinking]')).toBeNull();
		} finally { void unmount(v); target.remove(); }
	});

	it('groups the picker by where each conversation happens and opens an envoy channel thread read-only', async () => {
		const s = await setup(async () => reply('Done.'), envoyManifest);
		const handle = '6590000001@s.whatsapp.net';
		await s.t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'whatsapp', message: { id: 'w1', thread: handle, sentAt: s.t.clock.now(),
			from: { handle, name: 'Kim' }, text: 'hello?', attachments: [] } });
		// a group chat carries its name (WhatsApp's group subject), and the picker heads its conversation with it
		await s.t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'whatsapp', message: { id: 'g1', thread: '120363000000000001@g.us', sentAt: s.t.clock.now(),
			from: { handle, name: 'Kim' }, text: 'crew update', group: true, title: 'Site crew', attachments: [] } });
		await s.t.settled();
		const thread = conversationId('whatsapp', handle);
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: {}, onClose: () => {}, admin: true, envoys: { field_ops: 'Norbius' } } });
		try {
			// the live list is here once the picker stops saying there are none
			await until(() => !(target.querySelector('[data-agent-head] [role="combobox"]')?.textContent ?? '').includes('No conversations yet'));
			await press(target.querySelector<HTMLElement>('[data-agent-head] [role="combobox"]')!);
			await until(() => document.querySelector(`[role="option"][data-value="${thread}"]`) !== null);
			// no segment tabs: the picker's own headings say where each conversation happens, DMs before groups
			expect(target.querySelector('[data-agent-groups]')).toBeNull();
			expect([...document.querySelectorAll('li[role="presentation"].text-overline')].map((x) => x.textContent?.trim())).toEqual(['Norbius (DM)', 'Norbius (Group: Site crew)']);
			// choosing opens the thread, with no composer
			await press(document.querySelector<HTMLElement>(`[role="option"][data-value="${thread}"] button`)!);
			await until(() => target.querySelector('[data-agent-read-only]') !== null);
			expect(target.querySelector('textarea')).toBeNull();
			expect(target.querySelector('[data-role="user"] [data-text]')?.textContent).toBe('hello?');
		} finally { void unmount(v); target.remove(); }
	});

	it('a scale mark closes each triaged batch and opens, for an administrator, to what the decider received and answered', async () => {
		const s = await setup(async () => reply('Done.'), envoyManifest);
		const handle = '6590000001@s.whatsapp.net';
		await s.t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'whatsapp', message: { id: 'w1', thread: handle, sentAt: s.t.clock.now(),
			from: { handle, name: 'Kim' }, text: 'hello?', attachments: [] } });
		await s.t.settled();
		s.t.clock.advance('2s'); // the triage debounce elapses: the decision is made and its event written
		await s.t.runDue();
		await s.t.settled();
		const thread = conversationId('whatsapp', handle);
		await s.t.db.write({ text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`, params: [] });
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: { conversation: thread }, onClose: () => {}, admin: true } });
		try {
			await until(() => target.querySelector('[data-agent-read-only]') !== null);
			// the mark follows the message it decided, inline in the transcript (no tab)
			await until(() => target.querySelector('[data-decision-toggle]') !== null);
			const mark = target.querySelector('[data-role="decision"]')!;
			expect(mark.previousElementSibling?.getAttribute('data-role')).toBe('user');
			expect(mark.getAttribute('data-action')).toBe('respond');
			await press(target.querySelector<HTMLElement>('[data-decision-toggle]')!);
			await until(() => target.querySelector('[data-decision-matrix]') !== null);
			const d = target.querySelector('[data-decision-matrix]')!;
			const m0 = [...d.querySelectorAll('[data-decision-row="m0"] td')].map((x) => x.textContent?.trim());
			expect(m0).toEqual(['Kim: hello?', 'yes', 'yes']);
			expect(d.querySelector('[data-decision-row="wait"] td:nth-child(2)')?.textContent?.trim()).toBe('0 (1)');
			expect(d.querySelector('[data-decision-context]')?.textContent).toContain('Help.'); // the directive the decider was given
			expect(d.querySelector('[data-decision-context]')?.textContent).toContain('Norbius'); // the assistant it was asked about
		} finally { void unmount(v); target.remove(); }
	});

	it('a decided reply not written yet says so beside its mark, live, until the reply lands', async () => {
		let release: (r: AiResponse) => void = () => {};
		const s = await setup(() => new Promise<AiResponse>((ok) => { release = ok; }), envoyManifest);
		const handle = '6590000001@s.whatsapp.net';
		await s.t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'whatsapp', message: { id: 'w1', thread: handle, sentAt: s.t.clock.now(),
			from: { handle, name: 'Kim' }, text: 'hello?', attachments: [] } });
		await s.t.settled();
		s.t.clock.advance('2s');
		void s.t.runDue(); // the turn starts and holds on the model
		const thread = conversationId('whatsapp', handle);
		await s.t.db.write({ text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`, params: [] });
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: { conversation: thread }, onClose: () => {}, admin: true } });
		try {
			await until(() => target.querySelector('[data-role="decision"][data-awaiting] [data-reply-pending]') !== null);
			release(reply('On my way.'));
			await until(() => target.querySelector('[data-role="assistant"]') !== null && target.querySelector('[data-reply-pending]') === null);
		} finally { void unmount(v); target.remove(); }
	});

	it('messages the decider left fold into one "not for the assistant" block that carries their decision; an empty message is not drawn', async () => {
		const no: AiPort['sys_1'] = { async ask(r) {
			return { costUsd: 0, provider: 'test', answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, q.type === 'choice'
				? { type: 'choice', choice: 'no', confidence: 1, probabilities: {} } : { type: 'score', score: 0, level: 0, confidence: 1, probabilities: {}, legend: {} }])) } as never;
		} };
		const group = { ...envoyManifest, envoys: { field_ops: { ...(envoyManifest.envoys['field_ops'] as object), groupMessages: 'mention_or_reply' } } } as unknown as EngineManifest;
		const s = await setup(async () => reply('Done.'), group, no);
		const handle = '6590000001@s.whatsapp.net', thread = '1203@g.us';
		for (const [id, text] of [['w1', 'lunch?'], ['w2', ''], ['w3', 'the usual place']] as const)
			await s.t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'whatsapp', message: { id, thread, group: true, sentAt: s.t.clock.now(),
				from: { handle, name: 'Kim' }, text, attachments: [] } });
		await s.t.settled();
		s.t.clock.advance('2s');
		await s.t.runDue();
		await s.t.settled();
		await s.t.db.write({ text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`, params: [] });
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: { conversation: conversationId('whatsapp', thread) }, onClose: () => {}, admin: true } });
		try {
			await until(() => target.querySelector('[data-role="ignored"] [data-decision-toggle]') !== null);
			const block = target.querySelector('[data-role="ignored"]')!;
			expect([...block.querySelectorAll('[data-text]')].map((x) => x.textContent)).toEqual(['lunch?', 'the usual place']);
			expect(block.getAttribute('data-action')).toBe('ignore');
			expect(target.querySelectorAll('[data-role="ignored"]')).toHaveLength(1);
			expect(target.querySelector('[data-role="decision"]')).toBeNull(); // no divider of its own
			await press(block.querySelector<HTMLElement>('[data-decision-toggle]')!);
			await until(() => block.querySelector('[data-decision-matrix]') !== null);
		} finally { void unmount(v); target.remove(); }
	});

	it('a member who is not an administrator sees no decision marks', async () => {
		const s = await setup(async () => reply('Done.'), envoyManifest);
		const handle = '6590000001@s.whatsapp.net';
		await s.t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'whatsapp', message: { id: 'w1', thread: handle, sentAt: s.t.clock.now(),
			from: { handle, name: 'Kim' }, text: 'hello?', attachments: [] } });
		await s.t.settled();
		const thread = conversationId('whatsapp', handle);
		try { sessionStorage.clear(); } catch { /* none */ }
		const target = document.createElement('div');
		document.body.append(target);
		const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: s.api, bolt: liveBolt(s.fetch), t: (k: string) => k, request: { conversation: thread }, onClose: () => {} } });
		try {
			await until(() => target.querySelector('[data-agent-read-only]') !== null);
			await until(() => target.querySelector('[data-role="user"]') !== null);
			expect(target.querySelector('[data-decision-toggle]')).toBeNull();
			expect(target.querySelector('[role="tab"]')).toBeNull();
		} finally { void unmount(v); target.remove(); }
	});
});
