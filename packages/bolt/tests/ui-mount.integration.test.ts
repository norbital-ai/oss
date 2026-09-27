// @vitest-environment happy-dom
// Mount smoke test (§3.5, §3.6, rules 64–67): the ui next Table, Form and RecordShell over the real `$bolt` client,
// the /__bolt handler and a test-kit workspace on PGlite. A write paints every live view at once and lifts on the
// outcome: a commit stays (the stream carries it), a refusal un-paints.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createBolt, type Bolt } from '../src/client/bolt.ts';
import type { EventSourceLike } from '../src/client/stream.ts';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { PATHS } from '../src/protocol/wire.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';
import View from './support/ui-mount.svelte';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { tasks: { description: 'A task', label: 'title', fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } } } },
	relationships: {},
	collections: { tasks: { read: { fields: 'all' }, create: { input: { columns: ['title'] } }, update: { input: { columns: ['title'] } } } },
	policies: { editor: { description: 'Edits titles, creates nothing', grants: { tasks: { read: true, update: true } } } },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const kinds = { catalog: { tasks: { label: ['title'], fields: { title: { kind: 'text' } }, create: { columns: ['title'] }, update: { columns: ['title'] } } } } as never;

/** A test EventSource over the handler's SSE body. */
function sse(fetch: (url: string) => Promise<Response>, url: string): EventSourceLike {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const source: EventSourceLike = { onmessage: null, close: () => void reader?.cancel() };
	void (async () => {
		reader = (await fetch(url)).body!.getReader();
		const text = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
			if (done) return;
			buffer += text.decode(value, { stream: true });
			for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
				const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
				buffer = buffer.slice(i + 2);
				if (data !== '') source.onmessage?.(new MessageEvent('message', { data }));
			}
		}
	})();
	return source;
}

let t: TestWorkspace, bolt: Bolt, id: string, target: HTMLElement, view: ReturnType<typeof mount>;
/** Acts wait here until the test lets them through, so the paint can be seen before the outcome. */
let gate: Promise<void> = Promise.resolve(), open = () => {};
const hold = () => { gate = new Promise((r) => (open = r)); };

beforeEach(async () => {
	t = await testWorkspace({ manifest });
	const o = await t.as(t.admin).act('tasks.create', { title: 'Original' });
	id = (o as Extract<Outcome, { kind: 'committed' }>).records[0]!.id;
	const editor = t.engine.authority(t.member(['editor']));
	const handle = boltHandler({ engine: t.engine, session: async () => editor, uuid: randomUUID,
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const fetch = async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url) === PATHS.act) await gate;
		return await handle(new Request(`http://cell${String(url)}`, init)) ?? new Response(null, { status: 404 });
	};
	bolt = createBolt({ actor: null, locale: 'en', now: () => t.clock.now(), fetch: fetch as typeof globalThis.fetch, openStream: (url) => sse(fetch, url) });
	target = document.createElement('div');
	document.body.append(target);
	view = mount(View, { target, props: { bolt, kinds, id } });
	await until(() => text('table').includes('Original') && text('record').includes('Original'));
});
afterEach(async () => {
	open();
	await unmount(view);
	target.remove();
});

const text = (section: string) => target.querySelector(`[data-test="${section}"]`)?.textContent ?? '';
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean) => {
	for (let i = 0; i < 400 && !ok(); i++) await tick();
	expect(ok()).toBe(true);
};

it('a committed update paints Table and RecordShell before the reply, and stays after it', async () => {
	hold();
	const outcome = bolt.act('tasks.update', { target: id, set: { title: 'Renamed' } });
	await until(() => text('table').includes('Renamed') && text('record').includes('Renamed'));
	expect(text('table')).not.toContain('Original');
	open();
	expect((await outcome).kind).toBe('committed');
	for (let i = 0; i < 20; i++) await tick();
	expect(text('table')).toContain('Renamed');
	expect(text('record')).toContain('Renamed');
});

it('a refused update un-paints both views back to the stored row', async () => {
	hold();
	const outcome = bolt.act('tasks.update', { target: id, set: { title: 'Sneaky', note: 'not in the allowlist' } });
	await until(() => text('table').includes('Sneaky') && text('record').includes('Sneaky'));
	open();
	expect((await outcome).kind).toBe('refused');
	await until(() => text('table').includes('Original') && text('record').includes('Original'));
	expect(text('table')).not.toContain('Sneaky');
});

it('a create from the Form paints a pending Table row, and a refusal removes it and shows the reason', async () => {
	const input = target.querySelector<HTMLInputElement>('[data-test="form"] [data-field="title"] input')!;
	input.value = 'Brand new';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	hold();
	target.querySelector<HTMLButtonElement>('[data-test="form"] button[type="submit"]')!.click();
	await until(() => text('table').includes('Brand new'));
	open();
	await until(() => !text('table').includes('Brand new'));
	await until(() => target.querySelector('[data-test="form"] [role="alert"]') !== null);
	expect((await t.as(t.admin).read('tasks', { all: true })).rows.map((r) => r['title'])).toEqual(['Original']);
});
