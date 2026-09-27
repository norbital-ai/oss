// @vitest-environment happy-dom
// P4 and G5 in a DOM over the real handler and a test-kit workspace on PGlite: the shell's in-app agent panel (post,
// confirmation card, live settle, receipts); `sweep()` per policy and per public app as a visitor, finding a
// page's console error; the location picker with zero providers; Table paging and count; a 50-row Matrix page of a
// month within 300 KiB.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { createBolt } from '../src/client/bolt.ts';
import type { EventSourceLike } from '../src/client/stream.ts';
import type { AiPort, AiResponse, EngineManifest } from '../src/engine/contracts.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { PATHS } from '../src/protocol/wire.ts';
import Agent from '../src/shell/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { sweep } from '../src/test/browser.ts';
import { testWorkspace, respondSystem1 } from '../src/test/index.ts'; // hook:decisions
import { DEFAULT_BASEMAP, DEFAULT_GEOCODER } from '../../ui/src/kinds/context.js';
import Point from './support/p4-point.svelte';
import Views from './support/p4-views.svelte';
import SweepPage from './support/sweep-page.svelte';
import Noisy from './support/sweep-noisy.svelte';

const views: (() => void)[] = [];
afterEach(async () => { for (const off of views.splice(0)) off(); });
function show<P extends Record<string, unknown>>(C: Component<P>, props: P): HTMLElement {
	const target = document.createElement('div');
	document.body.append(target);
	const v = mount(C, { target, props });
	views.push(() => { void unmount(v); target.remove(); });
	return target;
}
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await tick(); expect(ok()).toBe(true); };

/** A test EventSource over the handler's SSE body, counting its bytes. */
function sse(fetch: (url: string) => Promise<Response>, url: string, bytes: { n: number }): EventSourceLike {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const source: EventSourceLike = { onmessage: null, close: () => void reader?.cancel() };
	void (async () => {
		reader = (await fetch(url)).body!.getReader();
		const text = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
			if (done) return;
			bytes.n += value.byteLength;
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

describe('the in-app agent panel (§5.9)', () => {
	it('posts, shows the confirmation card, runs the call when confirmed, and shows the reply with its receipt', async () => {
		const manifest = {
			workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
			models: { quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } } },
			relationships: {},
			collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
				actions: { mark: { description: 'Mark a quote', input: { title: { kind: 'text' } }, output: { kind: 'text' }, agent: 'confirm' } } } },
			policies: { rep: { description: 'Rep', grants: { quotes: { read: true, create: true, actions: ['mark'] } } } },
			agent: { internal: 'Staff brief.', skills: {} },
			integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
		} as unknown as EngineManifest;
		const guest = { source: `export default { collection: { quotes: { bodies: { actions: {
			mark: async (input, ctx) => (await ctx.act('quotes.create', { title: input.title })).records[0].id } } } } };` };
		const steps: (() => AiResponse)[] = [
			() => ({ content: '', toolCalls: [{ id: 'k1', name: 'act', input: { callable: 'quotes.mark', input: { title: 'Chair' } } }], finish: 'tool', usage: { input: 10, output: 5 } }),
			() => ({ content: 'Marked the chair.', toolCalls: [], finish: 'stop', usage: { input: 10, output: 5 } }),
		];
		let i = 0;
		const ai: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], infer: async () => steps[i++]!() } };
		const t = await testWorkspace({ manifest, guest, ai });
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`, params: [] });
		await t.db.write({ text: `INSERT INTO sys_assignment (id, principal_type, principal, policy) VALUES ('a1', 'sys_user', 'ann', 'rep')`, params: [] });
		const ann = (await new Authorities(manifest, 'test').member(t.db, 'ann'))!;
		const handle = boltHandler({ engine: t.engine, session: async () => ann, uuid: randomUUID,
			bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
		const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
			await handle(new Request(new URL(String(url), 'http://cell'), init)) ?? new Response(null, { status: 404 })) as typeof globalThis.fetch;
		const target = show(Agent as Component<Record<string, unknown>>, { api: shellApi(fetch), bolt: liveBolt(fetch), t: (k: string) => k, request: { prompt: 'mark a chair' }, onClose: () => {} });
		target.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
		await until(() => target.querySelector('[data-role="confirm"]') !== null);
		expect(target.querySelector('[data-role="user"] [data-text]')?.textContent).toBe('mark a chair');
		expect(target.querySelector('[data-role="confirm"] pre')?.textContent).toContain('quotes.mark');
		[...target.querySelectorAll<HTMLButtonElement>('[data-role="confirm"] button')].find((b) => b.textContent?.trim() === 'Confirm')!.click();
		await until(() => (target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes('Marked the chair.'));
		expect(target.querySelector('[data-receipt]')?.textContent).toContain('quotes.mark');
		expect(target.querySelector('[data-role="confirm"]')).toBeNull();
		await handle.settled();
		expect((await t.db.read([{ text: 'SELECT title FROM quotes', params: [] }]))[0]!.rows).toEqual([{ title: 'Chair' }]);
	});
});

describe('sweep() (§3.7, G5)', () => {
	const manifest = {
		workspace: { tz: 'UTC', locale: 'en', apps: ['sales', 'careers'], agent: { triage: false } }, // hook:decisions
		models: { quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } } },
		relationships: {},
		collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } } },
		policies: {
			rep: { description: 'Rep', capabilities: { apps: ['sales'] }, grants: { quotes: { read: true } } },
			applicant: { description: 'Apply', grants: { quotes: { read: { fields: ['title'] } } } },
		},
		apps: {
			sales: { title: 'Sales', description: 'd', icon: 'i', pages: { deals: { title: 'Deals' }, report: { title: 'Report' } } },
			careers: { title: 'Careers', description: 'Jobs', icon: 'i', audience: { public: ['applicant'] }, pages: { apply: { title: 'Apply' } } },
		},
		agent: { skills: {} },
		integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {},
	} as unknown as EngineManifest;
	const page = (c: Component) => async () => ({ default: c });

	it('visits every page per policy and per public app as its visitor, with no console error and no over-budget view', async () => {
		const t = await testWorkspace({ manifest, seed: { quotes: [{ id: randomUUID(), title: 'Desk' }] } });
		const report = await sweep(t, { pages: { 'sales/deals': page(SweepPage), 'sales/report': page(SweepPage), 'careers/apply': page(SweepPage) } });
		expect(report.visited).toEqual(expect.arrayContaining([
			{ who: 'member [rep]', path: '/app/sales/deals' }, { who: 'member [rep]', path: '/app/sales/report' }, { who: 'member [rep]', path: '/inbox' },
			{ who: 'visitor of careers', path: '/app/careers/apply' },
		]));
		expect(report.visited.some((v) => v.who === 'member [applicant]' && v.path.startsWith('/app/'))).toBe(false);
		expect(report.findings).toEqual([]);
	});

	it('reports a page that logs a console error', async () => {
		const t = await testWorkspace({ manifest });
		await expect(sweep(t, { as: [{ policies: ['rep'] }], pages: { 'sales/deals': page(SweepPage), 'sales/report': page(Noisy) } }))
			.rejects.toThrow(/member \[rep\] \/app\/sales\/report console: the page could not render its chart/);
	});
});

describe('G5 UI', () => {
	it('the location picker: one address box the value follows, typed and located points, a keyless map and geocoder', async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...a: unknown[]) => errors.push(a);
		try {
			Object.defineProperty(navigator, 'geolocation', { configurable: true,
				value: { getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) => ok({ coords: { latitude: 1.3521234, longitude: 103.8198765 } }) } });
			const got: Json[] = [];
			const geocoder = { search: async () => [{ point: { lat: 1.304, lng: 103.832 }, address: 'Orchard Road, Singapore' }], reverse: async () => 'Bishan, Singapore' };
			const picker = show(Point as Component<Record<string, unknown>>, { kinds: { geocoder }, onChange: (v: Json) => got.push(v) });
			flushSync();
			const box = picker.querySelector<HTMLInputElement>('input')!;
			expect(picker.querySelectorAll('input')).toHaveLength(1); // one search box, no latitude/longitude pair
			picker.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
			flushSync();
			expect(got.at(-1)).toEqual({ lat: 1.352123, lng: 103.819877 });
			box.value = '1.29, 103.85';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			expect(got.at(-1)).toEqual({ lat: 1.29, lng: 103.85 });
			box.value = 'orchard';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			await until(() => JSON.stringify(got.at(-1)) === JSON.stringify({ lat: 1.304, lng: 103.832 })); // the value follows the typing
			expect(DEFAULT_BASEMAP.url).not.toMatch(/key=|token=|\?/);
			expect(DEFAULT_GEOCODER.reverse).toBeDefined();
			for (let i = 0; i < 20; i++) await tick(); // the map's lazy load settles, or fails quietly
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	const month = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
	const people = Array.from({ length: 60 }, (_, i) => ({ id: randomUUID(), name: `P${String(i + 1).padStart(2, '0')}` }));
	const manifest = {
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
		models: {
			people: { description: 'An employee', label: 'name', fields: { name: { kind: 'text' } } },
			entries: { description: 'A time entry', label: 'day', fields: { day: { kind: 'date' }, hours: { kind: 'decimal', scale: 2 } } },
		},
		relationships: { 'entries.person': { to: 'people', inverse: 'entries' } },
		collections: { people: { read: { fields: 'all' } }, entries: { read: { fields: 'all' } } },
		policies: {}, integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	} as unknown as EngineManifest;
	const kinds = { catalog: {
		people: { label: ['name'], fields: { name: { kind: 'text' } } },
		entries: { label: ['day'], fields: { day: { kind: 'date' }, hours: { kind: 'decimal', scale: 2 }, person: { kind: 'id', of: 'people' } } },
	} } as never;
	async function mounted(view: 'table' | 'matrix', seed: Parameters<typeof testWorkspace>[0]['seed']) {
		const t = await testWorkspace({ manifest, ...(seed === undefined ? {} : { seed }) });
		const handle = boltHandler({ engine: t.engine, session: async () => t.engine.authority(t.admin), uuid: randomUUID,
			bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
		const bytes = { n: 0 }, reads: string[] = [];
		const fetch = async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url) === PATHS.q) reads.push(String(init?.body));
			const res = await handle(new Request(`http://cell${String(url)}`, init)) ?? new Response(null, { status: 404 });
			if (String(url) !== PATHS.live || init?.method === 'POST') bytes.n += (await res.clone().arrayBuffer()).byteLength;
			return res;
		};
		const bolt = createBolt({ actor: null, locale: 'en', fetch: fetch as typeof globalThis.fetch, openStream: (url) => sse(fetch, url, bytes) });
		const target = show(Views as Component<Record<string, unknown>>, { bolt, kinds, view, cols: month });
		return { target, bytes, reads };
	}

	const people23 = () => ({ people: Array.from({ length: 23 }, (_, i) => ({ id: randomUUID(), name: `N${String(i + 1).padStart(2, '0')}` })) });
	it('the Table shows its first page with the count, read once per scope', async () => {
		const { target, reads } = await mounted('table', people23());
		const range = () => target.querySelector('[data-range]')?.textContent ?? '';
		await until(() => range() === 'rows 1–10 of 23');
		expect(target.textContent).toContain('N10');
		expect(target.textContent).not.toContain('N11');
		const next = [...target.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Next')!;
		expect(next.disabled).toBe(false);
		expect(reads.filter((b) => b.includes('"aggregate"'))).toHaveLength(1);
	});

	// a cursor page is not liveable (rule 64): Table reads it once and keeps the first page live
	it('the Table pages forward by keyset link', async () => {
		const { target } = await mounted('table', people23());
		const range = () => target.querySelector('[data-range]')?.textContent ?? '';
		await until(() => range() === 'rows 1–10 of 23');
		const next = () => [...target.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Next')!;
		next().click();
		await until(() => range() === 'rows 11–20 of 23', 200);
		next().click();
		await until(() => range() === 'rows 21–23 of 23', 200);
		expect(next().disabled).toBe(true);
	});

	it('a 50-row Matrix page of a month moves at most 300 KiB', async () => {
		// the densest nihon month: one work day per employee per calendar day (the bank's January averages under ten)
		const entries = people.flatMap((p) => month.map((day) => ({ id: randomUUID(), person: p.id, day, hours: '7.50' })));
		const { target, bytes } = await mounted('matrix', { people, entries });
		// the rows are windowed (virtualized past 20): the first rows render, the page's 50 arrive on the wire
		await until(() => (target.textContent ?? '').includes('P01') && (target.textContent ?? '').includes('7.5'), 2000);
		for (let i = 0; i < 20; i++) await tick();
		expect(target.textContent).not.toContain('P51');
		expect(bytes.n).toBeLessThanOrEqual(300 * 1024);
		expect(bytes.n).toBeGreaterThan(50 * 30 * 60); // the page's cells did arrive
	}, 60_000);
});
