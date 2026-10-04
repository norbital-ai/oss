// @vitest-environment happy-dom
// The real workspace shell over the handler and a test-kit workspace on PGlite (§5.10): the hero renders a page's
// AppShell identity and actions; a generated form's file field uploads to `<collection>.<field>` and the submit waits
// for it; the sweep mounts every representation in the record sheet, whose module imports `$bolt`.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import type { Window as HappyWindow } from 'happy-dom';
import { flushSync, unmount, type Component } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineManifest } from '../src/engine/contracts.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { loadKeys, mint, type IdentityHost } from '../src/engine/identity/session.ts';
import { filesHandler } from '../src/protocol/files.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { shellHost } from '../src/shell/host.ts';
import { mountShell, type ShellMountConfig } from '../src/shell/mount.ts';
import { COOKIES } from '../src/shell/nav.ts';
import { sweep } from '../src/test/browser.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';
import Hero from './support/shell-hero.svelte';
import Upload from './support/shell-upload.svelte';
import PageTabs from './support/shell-tabs.svelte';
import Rep from './support/shell-rep.svelte';
import NoisyRep from './support/shell-rep-noisy.svelte';
import BadRead from './support/shell-bad-read.svelte';
import ScopedPage from './support/shell-scoped-page.svelte';
import ScopedShellPage from './support/shell-scoped-shell-page.svelte';
import ScopedRep from './support/shell-scoped-rep.svelte';

const ORIGIN = 'http://localhost';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en', apps: ['desk'], agent: { triage: false } }, // hook:decisions
	models: { docs: { description: 'A document', label: 'title', fields: {
		title: { kind: 'text' }, scan: { kind: 'file', accept: ['text/plain'], max: '1MiB', optional: true } } } },
	relationships: {},
	collections: { docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'scan'] } } } },
	policies: { clerk: { description: 'Files documents', capabilities: { apps: ['desk'] }, grants: { docs: { read: true, create: true } } } },
	apps: { desk: { title: 'Desk', description: 'd', icon: 'i', pages: { hero: { title: 'Hero' }, upload: { title: 'Upload' } } } },
	agent: { skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {},
} as unknown as EngineManifest;
const page = (c: Component) => async () => ({ default: c });

const views: (() => void)[] = [];
afterEach(async () => { for (const off of views.splice(0)) off(); (window as unknown as HappyWindow).happyDOM.setWindowSize({ width: 1024, height: 768 }); });
const tick = async () => { await new Promise((r) => setTimeout(r, 5)); flushSync(); };
const until = async (ok: () => boolean | Promise<boolean>, n = 600) => { for (let i = 0; i < n && !await ok(); i++) await tick(); expect(await ok()).toBe(true); };

/** The shell at `path` as a signed-in administrator; `gate` holds each upload's answer until it resolves. */
async function open(t: TestWorkspace, path: string, pages: ShellMountConfig['pages'], gate?: Promise<void>, representations?: ShellMountConfig['representations']) {
	const m = t.manifest;
	t.clock.set(new Date().toISOString()); // the page's client stamps acts with the browser's clock
	const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db),
		mail: { send: async () => ({ providerId: 'x' }), subscribe: () => () => {} }, devSink: true, publicUrl: ORIGIN };
	const shell = shellHost({ manifest: m, identity, authorities: new Authorities(m, 'shell-ui'), workspace: { name: 'Acme', handle: 'acme' }, ip: () => '203.0.113.9', secure: false });
	const bindings = () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: m.workspace.tz, params: {} });
	const bolt = boltHandler({ engine: t.engine, session: shell.authority, uuid: () => randomUUID(), bindings });
	const files = filesHandler({ engine: t.engine, session: shell.authority, bindings });
	const id = randomUUID();
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, $2, 'Ada', 'staff', true)`, params: [id, `ada-${id}@x.test`] });
	const s = await mint(identity, id);
	if (!s.ok) throw new Error(s.message);
	const puts: string[] = [];
	const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const r = new Request(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ORIGIN), init);
		r.headers.set('cookie', `${COOKIES.session}=${encodeURIComponent(s.value.token)}`);
		if (r.method === 'PUT') { puts.push(decodeURIComponent(new URL(r.url).pathname)); await gate; }
		return await shell.handle(r) ?? await files(r) ?? await bolt(r) ?? new Response(null, { status: 404 });
	}) as typeof globalThis.fetch;
	history.replaceState(null, '', path);
	const target = document.body.appendChild(document.createElement('div'));
	const v = mountShell(target, { manifest: m as never, pages, fetch, openStream: () => ({ onmessage: null, onerror: null, close() {} }), ...(representations === undefined ? {} : { representations }) });
	views.push(() => { void unmount(v); target.remove(); });
	return { target, puts };
}

describe('the shell renders a page (§5.10)', () => {
	it('hoists mobile page identity into navigation and restores the desktop hero on resize', async () => {
		const resize = (width: number) =>
			(window as unknown as HappyWindow).happyDOM.setWindowSize({ width, height: 812 });
		resize(375);
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/hero', { 'desk/hero': page(Hero) });
		await until(() => target.querySelector('[data-export]') !== null);
		// Prime happy-dom's change listener at its initial matching viewport before resizing away.
		window.dispatchEvent(new Event('resize'));
		const hero = () => target.querySelector('[data-layout=app-media-header]')!;
		const nav = () => target.querySelector('main header');
		await until(() => nav() !== null);
		expect(nav()!.textContent).toContain('Dispatch board');
		expect(nav()!.textContent).toContain('Every job due today');
		expect(hero().textContent).not.toContain('Dispatch board');
		expect(hero().textContent).not.toContain('Every job due today');
		expect(hero().querySelector('[data-layout=frame]')).not.toBeNull();
		expect(hero().querySelector('[data-export]')).not.toBeNull();
		(target.querySelector('[data-export]') as HTMLButtonElement).click();
		await until(() => nav()!.textContent!.includes('Dispatch overview'));
		expect(nav()!.textContent).toContain('All jobs this week');
		expect(target.textContent).not.toContain('Every job due today');
		expect(hero().textContent).not.toContain('Dispatch overview');
		resize(1024);
		await until(() => nav() === null);
		expect(hero().textContent).toContain('Dispatch overview');
		expect(hero().textContent).toContain('All jobs this week');
		resize(375);
		await until(() => nav() !== null);
		expect(nav()!.textContent).toContain('Dispatch overview');
		expect(nav()!.textContent).toContain('All jobs this week');
		expect(hero().textContent).not.toContain('All jobs this week');
		expect(hero().querySelector('[data-export]')).not.toBeNull();
	});

	it('shows the AppShell identity and its actions in the hero above the page', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/hero', { 'desk/hero': page(Hero) });
		await until(() => target.querySelector('[data-body]') !== null);
		await until(() => target.querySelector('[data-layout=app-media-header]') !== null);
		const hero = target.querySelector('[data-layout=app-media-header]')!;
		expect(hero.textContent).toContain('Dispatch board');
		expect(hero.textContent).toContain('Every job due today');
		expect(hero.querySelector('[data-export]')).not.toBeNull();
		// the actions read the dark tokens on the scrim (A7); a phone shows two lines of description (A15)
		expect(hero.querySelector('[data-export]')!.closest('.dark')).not.toBeNull();
		expect([...hero.querySelectorAll('p')].find((p) => p.textContent?.includes('Every job due today'))!.classList).toContain('line-clamp-2');
		expect(hero.querySelector('[data-layout=frame]')).not.toBeNull(); // the icon chip
	});

	it('a page\'s own Tabs render at level 2 under the app pages strip (A8)', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/upload', { 'desk/upload': page(PageTabs) });
		await until(() => target.querySelector('[data-body]') !== null);
		expect(target.querySelector('nav[aria-label=Pages]')).not.toBeNull();
		expect(target.querySelector('[data-tabs-variant]')!.getAttribute('data-tabs-variant')).toBe('underline');
	});

	it('a generated form uploads a file to <collection>.<field>, and its submit waits for the upload', async () => {
		const t = await testWorkspace({ manifest });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { target, puts } = await open(t, '/app/desk/upload', { 'desk/upload': page(Upload) }, gate);
		await until(() => target.querySelector('input[type=file]') !== null);
		const title = target.querySelector<HTMLInputElement>('[data-field=title] input')!;
		title.value = 'Lease';
		title.dispatchEvent(new Event('input', { bubbles: true }));
		const input = target.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { configurable: true, value: [new File(['signed'], 'lease.txt', { type: 'text/plain' })] });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await until(() => puts.length === 1);
		expect(puts).toEqual(['/__bolt/files/docs.scan']);
		// submitted while the upload is in flight: the act carries the stored file, never a draft without it
		target.querySelector<HTMLFormElement>('form')!.requestSubmit();
		await tick();
		release();
		const rows = async () => (await t.db.read([{ text: 'SELECT title, scan FROM docs', params: [] }]))[0]!.rows;
		await until(async () => (await rows()).length === 1);
		const [row] = await rows();
		expect(row!['title']).toBe('Lease');
		expect(row!['scan']).toMatchObject({ name: 'lease.txt', mime: 'text/plain' });
	});
});

describe('the record sheet keeps the opening page\'s create scope', () => {
	it('a Table\'s New opens the sheet with the page\'s contexts above its representation', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/hero', { 'desk/hero': page(ScopedPage as Component) }, undefined,
			{ docs: page(ScopedRep as Component) as never });
		await until(() => target.querySelector('[data-view-new]') !== null || [...target.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'New'));
		const button = target.querySelector<HTMLButtonElement>('[data-view-new]') ?? [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New')!;
		button.click();
		await until(() => target.querySelector('[data-scoped-rep]') !== null);
		expect(target.querySelector('[data-scoped-rep]')!.textContent).toBe('create: Scoped lease');
	});

	it('a sheet opened by the URL (a reload, a link) takes the scope of the page it opens over', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/hero?record=docs/new', { 'desk/hero': page(ScopedPage as Component) }, undefined,
			{ docs: page(ScopedRep as Component) as never });
		await until(() => target.querySelector('[data-scoped-rep]')?.textContent === 'create: Scoped lease');
	});

	it('the page\'s own AppShell carries its scope when no view of the collection is on screen', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/hero?record=docs/new', { 'desk/hero': page(ScopedShellPage as Component) }, undefined,
			{ docs: page(ScopedRep as Component) as never });
		await until(() => target.querySelector('[data-scoped-rep]')?.textContent === 'create: Scoped lease');
	});
});

describe('a record sheet closes through its ?record= entry', () => {
	it('Esc pops only the top sheet and its ?record= entry; a later URL read never reopens it', async () => {
		const doc = randomUUID();
		const t = await testWorkspace({ manifest, seed: { docs: [{ id: doc, title: 'Lease' }] } });
		const { target } = await open(t, `/app/desk/hero?record=docs/${doc}&record=docs/new`, { 'desk/hero': page(Hero) });
		const sheets = () => target.querySelectorAll('[data-sheet-side]').length;
		const stack = () => new URL(location.href).searchParams.getAll('record');
		await until(() => sheets() === 2);
		const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		window.dispatchEvent(esc);
		expect(esc.defaultPrevented).toBe(true);
		await until(() => sheets() === 1);
		expect(stack()).toEqual([`docs/${doc}`]);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await until(() => sheets() === 0);
		expect(stack()).toEqual([]);
		// the next navigation reads the URL again (openRecord's popstate): nothing reopens
		window.dispatchEvent(new PopStateEvent('popstate'));
		await tick();
		expect(sheets()).toBe(0);
	});

	it('a phone drawer\'s grabber expands it on a tap, resizes it on a drag, and closes it dragged low', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/app/desk/hero?record=docs/new', { 'desk/hero': page(Hero) });
		const sheet = () => target.querySelector<HTMLElement>('[data-sheet-side]');
		await until(() => sheet() !== null);
		const grab = sheet()!.querySelector<HTMLElement>('[data-sheet-grabber]')!;
		grab.click();
		flushSync();
		expect(sheet()!.dataset['fullscreen']).toBe('true');
		const drag = (dy: number) => {
			grab.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientY: 600, bubbles: true }));
			window.dispatchEvent(new PointerEvent('pointermove', { clientY: 600 + dy }));
			window.dispatchEvent(new PointerEvent('pointerup', {}));
			grab.click(); // the click after a drag is no tap
			flushSync();
		};
		drag(-300);
		expect(sheet()!.dataset['fullscreen']).toBeUndefined();
		expect(sheet()!.style.getPropertyValue('--sheet-h')).toBe('300px');
		drag(100);
		await until(() => sheet() === null);
	});
});

describe('sweep() mounts representations (§3.7, X-20)', () => {
	it('opens a new and a stored record of each represented collection; a representation importing $bolt boots', async () => {
		const doc = randomUUID();
		const t = await testWorkspace({ manifest, seed: { docs: [{ id: doc, title: 'Lease' }] } });
		const report = await sweep(t, { as: [{ admin: true }], pages: { 'desk/hero': page(Hero), 'desk/upload': page(Upload) },
			representations: { docs: page(Rep as Component) as never } });
		expect(report.visited.map((v) => v.path)).toEqual(expect.arrayContaining([`/app/desk/hero?record=docs/new`, `/app/desk/hero?record=docs/${doc}`]));
		expect(report.findings).toEqual([]);
	});

	it('finds a live read the host refuses as malformed, which no console shows', async () => {
		const t = await testWorkspace({ manifest });
		await expect(sweep(t, { as: [{ admin: true }], pages: { 'desk/hero': page(BadRead as Component), 'desk/upload': page(Hero) } }))
			.rejects.toThrow(/administrator \/app\/desk\/hero read: .*invalid/);
	});

	it('finds what a representation logs', async () => {
		const t = await testWorkspace({ manifest });
		await expect(sweep(t, { as: [{ admin: true }], pages: { 'desk/hero': page(Hero) }, representations: { docs: page(NoisyRep as Component) as never } }))
			.rejects.toThrow(/administrator \/app\/desk\/hero\?record=docs\/new console: representation mounted: create/);
	});
});

describe('system collections render in ui\'s Table (Settings, Automations, Inbox)', () => {
	const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
	const press = (b: HTMLElement) => {
		b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		b.click();
	};

	it('/runs moves to Settings → Automations, whose runs are a Table row each with Stop on a queued run', async () => {
		const t = await testWorkspace({ manifest });
		await t.db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('r1', 'nightly', '{}', now(), 'schedule', 0)`, params: [] });
		const { target } = await open(t, '/runs', {});
		await until(() => location.pathname === '/settings/automations');
		await until(() => target.querySelector('[data-view=table] [data-status=queued]') !== null);
		expect(target.querySelector('[data-view=table]')!.textContent).toContain('nightly');
		expect(button(target, 'Stop')).toBeDefined();
	});

	it('Settings → Integrations issues an API key in a dialog that shows it once, and lists it in the keys Table', async () => {
		const t = await testWorkspace({ manifest });
		const { target } = await open(t, '/settings/integrations', {});
		await until(() => button(target, 'New') !== undefined);
		button(target, 'New')!.click();
		await until(() => document.body.querySelector<HTMLInputElement>('[role=dialog] input') !== null);
		const name = document.body.querySelector<HTMLInputElement>('[role=dialog] input')!;
		name.value = 'CI';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		document.body.querySelector<HTMLFormElement>('[role=dialog] form')!.requestSubmit();
		await until(() => (document.body.querySelector('[role=dialog]')?.textContent ?? '').includes('nbk_'));
		await until(() => [...target.querySelectorAll('[data-view=table]')].some((x) => x.textContent?.includes('CI')));
		const [key] = (await t.db.read([{ text: `SELECT name, revoked_at FROM sys_api_key`, params: [] }]))[0]!.rows;
		expect(key).toMatchObject({ name: 'CI', revoked_at: null });
	});

	it('Settings → People reads a role by its label and a last-seen instant without seconds', async () => {
		const t = await testWorkspace({ manifest });
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('u2', 'bo@x.test', 'Bo', 'external')`, params: [] });
		const { target } = await open(t, '/settings/people', {});
		await until(() => (target.querySelector('[data-view=table]')?.textContent ?? '').includes('Bo'));
		const text = target.querySelector('[data-view=table]')!.textContent!;
		expect(text).toContain('Staff');
		expect(text).toContain('External');
		expect(text).not.toMatch(/\bstaff\b|\bexternal\b/);
		expect(text).toContain(String(new Date().getFullYear())); // Ada's session: her last-seen time is drawn
		expect(text).not.toMatch(/\d:\d\d:\d\d/);
	});

	it('Settings → Envoy edits the persisted envoy and its channel bindings', async () => {
		const t = await testWorkspace({ manifest: { ...manifest, channels: { field_ops: { transport: 'telegram', name: 'Field ops' }, personal: { transport: 'email', owner: 'personal-user' } }, envoys: { field_bot: { name: 'Field assistant', channel: 'field_ops', audience: 'private', policies: ['clerk'], delegation: 'disabled', task: 'Help the team.' } } } as unknown as EngineManifest });
		// the connection stream is the browser's own `EventSource` (runtime.ts), which happy-dom lacks: a silent one
		vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; addEventListener() {} close() {} });
		const { target } = await open(t, '/settings/envoy', {});
		await until(() => (target.querySelector('[data-view=table]')?.textContent ?? '').includes('Field ops'));
		expect(target.querySelector('[data-view=table] tbody tr')?.textContent).toContain('Field assistant');
		expect(target.querySelector('[data-view=table]')?.textContent).not.toContain('Personal');
		target.querySelector<HTMLElement>('[data-view=table] tbody tr')!.click();
		await until(() => document.body.querySelector('[role=dialog]') !== null);
		const sheet = document.body.querySelector('[role=dialog]')!;
		expect(sheet.textContent).toContain('Configure envoy');
		expect(sheet.querySelector('textarea')?.value).toBe('Help the team.');
		expect(sheet.textContent).toContain('Field ops');
		expect(sheet.textContent).not.toContain('personal');
		const textarea = sheet.querySelector('textarea')!;
		textarea.value = 'Updated at runtime.'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
		sheet.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		for (let i = 0; i < 20; i++) await tick();
		expect(sheet.querySelector('[role=alert]')?.textContent ?? '').toBe('');
		await until(() => document.body.querySelector('[role=dialog]') === null);
		expect((await t.db.read([{ text: "SELECT task, revision FROM sys_envoy WHERE id = 'field_bot'", params: [] }]))[0]!.rows).toEqual([{ task: 'Updated at runtime.', revision: 2 }]);
		vi.unstubAllGlobals();
	});

	it('Settings → People → Teams draws the hierarchy with Svelte Flow; a node opens the team', async () => {
		const t = await testWorkspace({ manifest });
		await t.db.write({ text: `INSERT INTO sys_team (id, name, parent) VALUES ('ops', 'Ops', NULL), ('hr', 'HR', 'ops')`, params: [] });
		const { target } = await open(t, '/settings/people', {});
		await until(() => [...target.querySelectorAll('[role=tab]')].some((x) => x.textContent?.trim() === 'Teams'));
		press([...target.querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.trim() === 'Teams')!);
		await until(() => target.querySelectorAll('.svelte-flow__node').length === 2);
		(target.querySelector<HTMLElement>('.svelte-flow__node[data-id=hr]') ?? target.querySelectorAll<HTMLElement>('.svelte-flow__node')[1]!).click();
		await until(() => (document.body.querySelector('[role=dialog]')?.textContent ?? '').includes('Parent team'));
	});
});


describe('workspace boot error recovery', () => {
	it.each([403, 404, 429, 500, 503])('shows the reason and retry control for HTTP %s', async (status) => {
		history.replaceState(null, '', '/app/desk/hero');
		const target = document.body.appendChild(document.createElement('div'));
		const v = mountShell(target, { manifest: manifest as never, pages: {}, fetch: async () => new Response('proxy error', { status }) });
		views.push(() => { void unmount(v); target.remove(); });
		await until(() => target.querySelector('[role=alert]') !== null);
		expect(target.textContent).toContain(`HTTP ${status}`);
		expect(target.textContent).toContain('Unable to open the workspace');
		expect(target.textContent).not.toContain('could not be reached');
		expect([...target.querySelectorAll('button')].some((button) => button.textContent?.includes('Try again'))).toBe(true);
	});
});
