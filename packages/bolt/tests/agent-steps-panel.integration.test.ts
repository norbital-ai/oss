// @vitest-environment happy-dom
// The agent panel folds each run of consecutive tool steps into one quiet group ("Worked for 1s · 3 steps"), Codex-style,
// marked when a step failed and closed once the turn settled; a reply ends it. Each step is a row (verb, target,
// duration) opening to its input and result behind one tab each, the failing call's icon an alert. Staging's failing loop
// was a wall of rows.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { expect, it } from 'vitest';
import type { AiPort, AiResponse, EngineManifest } from '../src/engine/contracts.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import Agent from '../src/shell/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: { quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } } }, relationships: {},
	collections: { quotes: { read: { fields: 'all' } } }, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await tick(); expect(ok()).toBe(true); };
const use = (name: string, input: object): AiResponse => ({ content: '', toolCalls: [{ id: randomUUID(), name, input: input as never }], finish: 'tool', usage: { input: 1, output: 1 } });

it('a run of tool steps is one collapsed "Worked for" group with a failure mark; a reply ends it', async () => {
	const script: AiResponse[] = [use('history', { query: 'quote' }), use('read', { collection: 'quotes', where: { month: 'x' } }), use('read', { collection: 'quotes', where: { year: 'x' } }),
		{ content: 'No month field on quotes.', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } }];
	const ai: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], async infer() { return script.shift()!; } } };
	const t = await testWorkspace({ manifest, ai });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name, admin) VALUES ('ann', 'ann@x.test', 'Ann', true)`, params: [] });
	const ann = (await new Authorities(manifest, 'test').member(t.db, 'ann'))!;
	const handle = boltHandler({ engine: t.engine, session: async () => ann, uuid: randomUUID, bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => await handle(new Request(new URL(String(url), 'http://cell'), init)) ?? new Response(null, { status: 404 })) as typeof globalThis.fetch;
	try { sessionStorage.clear(); } catch { /* none */ }
	const target = document.createElement('div');
	document.body.append(target);
	const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: shellApi(fetch), bolt: liveBolt(fetch), t: (k: string) => k, request: { prompt: 'why?' }, onClose: () => {} } });
	try {
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await until(() => target.querySelector('[data-role="assistant"]')?.textContent?.includes('No month field') === true);
		const runs = target.querySelectorAll('[data-role="steps"]');
		expect(runs).toHaveLength(1);
		await until(() => runs[0]!.querySelector('[data-working]') === null);
		expect(runs[0]!.querySelector('summary')!.textContent).toMatch(/Worked for \d+s\s*· 3 steps/);
		expect(runs[0]!.hasAttribute('data-failed')).toBe(true);
		expect(runs[0]!.querySelector('details')!.open).toBe(false);
		const steps = [...target.querySelectorAll('[data-step]')];
		expect(steps.map((e) => e.getAttribute('data-step-state'))).toEqual(['done', 'failed', 'failed']);
		expect(steps.map((e) => e.querySelector('summary')!.textContent!.replace(/\s+/g, ' ').trim().replace(/ \d+(\.\d)?s$/, ''))).toEqual(['History quote', 'Read quotes', 'Read quotes']);
		// a step opens to its input and result, one tab each, rendered only once opened
		expect(steps[1]!.querySelector('[role="tabpanel"]')).toBeNull();
		steps[1]!.querySelector('details')!.open = true;
		await until(() => steps[1]!.querySelector('[role="tabpanel"]') !== null);
		expect([...steps[1]!.querySelectorAll('[role="tab"]')].map((e) => [e.textContent, e.getAttribute('aria-selected')])).toEqual([['Input', 'true'], ['Output', 'false']]);
		expect(steps[1]!.querySelector('[role="tabpanel"]')!.textContent).toContain('"month"');
		(steps[1]!.querySelector('[data-pane="output"]') as HTMLElement).click();
		await until(() => steps[1]!.querySelector('[aria-selected="true"]')?.textContent === 'Output');
		expect(steps[1]!.querySelector('[role="tabpanel"]')!.textContent).toContain('error');		// the run sits between the question and the reply
		expect([...target.querySelectorAll('ol[aria-live] > li')].map((e) => e.getAttribute('data-role'))).toEqual(['user', 'steps', 'assistant']);
	} finally { void unmount(v); target.remove(); }
});
