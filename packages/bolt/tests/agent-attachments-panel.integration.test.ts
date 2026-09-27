// @vitest-environment happy-dom
// The agent panel's file control: a picked file uploads to `/__bolt/files/sys_message.files` on send and the posted
// row carries it, shown by name in the transcript.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { expect, it } from 'vitest';
import type { EngineManifest } from '../src/engine/contracts.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { filesHandler } from '../src/protocol/files.ts';
import { boltHandler } from '../src/protocol/http.ts';
import Agent from '../src/shell/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await tick(); expect(ok()).toBe(true); };

it('a picked file uploads on send and the posted row carries it', async () => {
	const t = await testWorkspace({ manifest, ai: { sys_1: respondSystem1, sys_2: { models: ['default'], async infer() { return { content: 'Seen.', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } }; } } } });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`, params: [] });
	const ann = (await new Authorities(manifest, 'test').member(t.db, 'ann'))!;
	const bindings = () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} });
	const handle = boltHandler({ engine: t.engine, session: async () => ann, uuid: randomUUID, bindings });
	const files = filesHandler({ engine: t.engine, session: async () => ann, bindings }); // the host's file route
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const r = new Request(new URL(String(url), 'http://cell'), init);
		return await files(r) ?? await handle(r) ?? new Response(null, { status: 404 });
	}) as typeof globalThis.fetch;
	try { sessionStorage.clear(); } catch { /* none */ }
	const target = document.createElement('div');
	document.body.append(target);
	const v = mount(Agent as Component<Record<string, unknown>>, { target, props: { api: shellApi(fetch), bolt: liveBolt(fetch), t: (k: string) => k, request: {}, onClose: () => {} } });
	try {
		const input = target.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array([1, 2, 3])], 'pump.png', { type: 'image/png' })] });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(target.querySelector('[data-attached]')?.textContent).toContain('pump.png');
		const box = target.querySelector('textarea')!;
		box.value = 'what is this?';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await until(() => (target.querySelector('[data-attachment]')?.textContent ?? '').includes('pump.png'));
		await handle.settled();
		const [row] = (await t.db.read([{ text: `SELECT files FROM sys_message WHERE role = 'user'`, params: [] }]))[0]!.rows;
		expect(row!['files']).toMatchObject([{ name: 'pump.png', mime: 'image/png', bytes: 3 }]);
		expect(target.querySelector('[data-attached]')).toBeNull();
	} finally { void unmount(v); target.remove(); }
});
