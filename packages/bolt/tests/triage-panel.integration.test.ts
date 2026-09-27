// @vitest-environment happy-dom
// G5's in-app triage cases (rule 60a) in a DOM over the real handler and a test-kit workspace: plain-Enter parts show the
// "waiting for more…" state and are answered as one turn; respond-now and Cmd/Ctrl+Enter start the turn at once with
// every pending row and no decision call; without the port each post starts a turn as before.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, EngineManifest } from '../src/engine/contracts.ts';
import type { System1Port, System1Request } from '../src/engine/decisions/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import Agent from '../src/shell/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' }, models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;

const views: (() => void)[] = [];
afterEach(() => { for (const off of views.splice(0)) off(); });
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await tick(); expect(ok()).toBe(true); };
/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) => (typeof c === 'string' ? c : String((c as { text?: Json } | null)?.text ?? '')).replace(/^\[[^\]]*\]\s*/, '');

async function panel(o: { triage: boolean }) {
	const inputs: System1Request[] = [];
	const system1: System1Port = { async ask(r) { inputs.push(r);
		return { answers: { action: { type: 'choice', choice: 'wait', confidence: 1, probabilities: { wait: 1 } },
			wait: { type: 'score', score: 10, level: 10, confidence: 1, probabilities: {}, legend: {} } }, costUsd: 0, provider: 'scripted' }; } };
	const turns: string[][] = [];
	const ai: AiPort = { sys_1: system1, sys_2: { models: ['default'], async infer(r) {
		turns.push(r.messages.filter((m) => m.role === 'user' && !text(m.content).startsWith('Now: ')).map((m) => text(m.content)));
		return { content: 'On it.', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } };
	} } };
	const t = await testWorkspace({ manifest: o.triage ? manifest : { ...manifest, workspace: { ...manifest.workspace, agent: { triage: false } } }, ai });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`, params: [] });
	const ann = (await new Authorities(manifest, 'test').member(t.db, 'ann'))!;
	const handle = boltHandler({ engine: t.engine, session: async () => ann, uuid: randomUUID,
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
		await handle(new Request(new URL(String(url), 'http://cell'), init)) ?? new Response(null, { status: 404 })) as typeof globalThis.fetch;
	try { sessionStorage.clear(); } catch { /* none */ }
	const target = document.createElement('div');
	document.body.append(target);
	const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: shellApi(fetch), bolt: liveBolt(fetch), t: (k: string) => k, request: {}, onClose: () => {} } });
	views.push(() => { void unmount(v); target.remove(); });
	const box = () => target.querySelector('textarea')!;
	const enter = async (body: string, mod: { metaKey?: boolean; ctrlKey?: boolean } = {}) => {
		box().value = body;
		box().dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mod }));
		await until(() => box().value === '');
		await until(() => [...target.querySelectorAll('[data-role="user"] [data-text]')].some((e) => e.textContent === body));
	};
	return { t, target, inputs, turns, enter, handle };
}

describe('the agent panel with triage (G5, rule 60a)', () => {
	it('two plain-Enter parts wait for more, and respond-now answers them as one turn with no decision call', async () => {
		const p = await panel({ triage: true });
		await p.enter('draft a note');
		await p.enter('for the Kismis job');
		await until(() => p.target.querySelector('[data-role="waiting"]') !== null);
		expect(p.target.querySelectorAll('[data-pending]')).toHaveLength(2);
		expect(p.turns).toHaveLength(0);
		p.target.querySelector<HTMLButtonElement>('[data-role="waiting"] button')!.click();
		await until(() => (p.target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes('On it.'));
		await p.handle.settled();
		expect(p.turns).toEqual([['draft a note', 'for the Kismis job']]);
		expect(p.inputs).toHaveLength(0);
		expect(p.target.querySelector('[data-role="waiting"]')).toBeNull();
	});

	it('Cmd/Ctrl+Enter sends now with every pending row; the decider is never asked', async () => {
		const p = await panel({ triage: true });
		await p.enter('first part');
		await p.enter('second part', { ctrlKey: true });
		await until(() => (p.target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes('On it.'));
		await p.handle.settled();
		expect(p.turns).toEqual([['first part', 'second part']]);
		await p.t.runDue(); // the decision the first part queued finds nothing pending
		expect(p.inputs).toHaveLength(0);
	});

	it('without the port each post starts a turn', async () => {
		const p = await panel({ triage: false });
		await p.enter('hello');
		await until(() => (p.target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes('On it.'));
		expect(p.target.querySelector('[data-role="waiting"]')).toBeNull();
	});
});
