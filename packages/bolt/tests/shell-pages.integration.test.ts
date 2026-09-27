// @vitest-environment happy-dom
// The shell's admin pages mounted over a fake shell API: the workspace log renders only the rows in view and pages
// older rows by cursor; Studio restores live to a recorded commit through the host port.
import './setup-happy-dom.js';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { LogQuery, LogRow } from '../src/shell/data.ts';
import type { ShellApi } from '../src/shell/runtime.ts';
import type { StudioMergeRequest, StudioOp, StudioView } from '../src/shell/studio.ts';
import type { StudioTab } from '../src/shell/nav.ts';
import Logs from '../src/shell/Logs.svelte';
import Studio from '../src/shell/Studio.svelte';

const views: (() => void)[] = [];
afterEach(() => { for (const v of views.splice(0)) v(); });
function show(C: typeof Logs | typeof Studio, api: Partial<ShellApi>, more: { tab?: StudioTab; onTab?: (tab: StudioTab) => void; admin?: boolean } = {}) {
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(C, { target, props: { api: api as ShellApi, t: (k: string) => k, ...more } });
	views.push(() => { void unmount(v); target.remove(); });
	return target;
}
const settle = async () => { for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };

it('the log renders only the rows in view and loads the older page before its oldest row', async () => {
	// 1,000 events, ids 1..1000; a page is 200, newest first
	const asked: LogQuery[] = [];
	const logs = async (x: LogQuery) => {
		asked.push(x);
		const top = x.before === undefined ? 1000 : Number(x.before) - 1;
		const value: LogRow[] = x.after !== undefined ? [] : Array.from({ length: Math.min(200, top) }, (_, i) => ({ id: String(top - i), at: '2026-09-25T00:00:00Z',
			severity: 'info', event: `e${top - i}`, invocation: 'i', run: null, conversation: null, turn: null, attributes: {} }));
		return { ok: true as const, value };
	};
	const el = show(Logs, { logs });
	await settle();
	const port = el.querySelector('[role=log]')!;
	const rendered = port.querySelectorAll('time').length;
	expect(rendered).toBeGreaterThan(0);
	expect(rendered).toBeLessThan(200);
	port.dispatchEvent(new Event('scroll'));
	await settle();
	expect(asked.map((x) => x.before)).toEqual([undefined, '801']);
});

/** Studio's runtime log reads `sys_event` through the logs port; an empty page is enough here. */
const logs = async () => ({ ok: true as const, value: [] as LogRow[] });
const press = async (b: HTMLElement) => {
	b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
	b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
	b.click();
	await settle();
};

it('Studio keeps the tab hierarchy and restores live to a recorded commit through the port', async () => {
	const view: StudioView = { commit: 'c2', files: { 'src/a.ts': 'x' }, changes: [], log: [], preview: null,
		releases: [{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true }, { commit: 'c1', at: '2026-09-24T00:00:00Z', message: 'one', current: false }],
		environments: [{ name: 'preview', release: 'r2', url: 'https://acme--preview.example' }, { name: 'live', release: 'r1', url: 'https://acme.example' }],
		sections: { collections: [{ name: 'tasks', path: 'src/data/collection/tasks/+collection.ts' }], pipelines: [], apps: [], policies: [], envoys: [], automations: [], remotes: [], environment: [] } };
	const ran: StudioOp[] = [];
	vi.stubGlobal('confirm', () => true);
	const el = show(Studio, { logs, studio: async () => ({ ok: true, value: view }), studioRun: async (op) => (ran.push(op), { ok: true, value: view }) });
	await settle();
	const tabs = () => [...el.querySelectorAll('[role=tab]')].map((b) => b.textContent?.trim());
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live']);
	const click = (label: string) => press([...el.querySelectorAll<HTMLElement>('[role=tab], button')].find((x) => x.textContent?.trim() === label)!);
	await click('Changes');
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live', 'Files', 'Manifest', 'Logs']);
	await click('Manifest');
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live', 'Files', 'Manifest', 'Logs', 'Collections', 'Pipelines', 'Apps', 'Policies', 'Envoys', 'Automations', 'Remotes', 'Environment']);
	// levels come from nesting alone: segmented > underline > chips
	expect([...el.querySelectorAll('[data-tabs-variant]')].map((x) => x.getAttribute('data-tabs-variant'))).toEqual(['segmented', 'underline', 'chips']);
	await click('Live');
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live', 'Runtime log', 'Operations']);
	// the rail picks the recorded commit; Restore returns live to it
	await press([...el.querySelectorAll<HTMLElement>('aside button')].find((x) => x.textContent?.includes('one'))!);
	await click('Restore');
	expect(ran).toEqual([{ op: 'restore', commit: 'c1' }]);
	// Operations (L-BOLT-534): the routed environments, live first
	await click('Operations');
	expect([...el.querySelectorAll('li strong')].map((x) => x.textContent)).toEqual(['live', 'preview']);
	vi.unstubAllGlobals();
});

it('Studio lists the workspace as a file tree: folders fold, a file opens by its full path (L-BOLT-748)', async () => {
	const view: StudioView = { commit: 'c2', files: { 'src/a.ts': 'x', 'src/app/sales/+app.ts': 'y', 'package.json': '{}' }, changes: [], log: [], preview: null, releases: [], sections: null };
	const el = show(Studio, { studio: async () => ({ ok: true, value: view }), studioRun: async () => ({ ok: true, value: view }) });
	await settle();
	const tree = el.querySelector('[data-file-tree]')!;
	const rows = () => [...tree.querySelectorAll('button')].map((b) => b.getAttribute('title'));
	// folders first and closed; opening one lists its folders, then its files
	expect(rows()).toEqual(['src', 'package.json']);
	await press(tree.querySelector<HTMLButtonElement>('button[title="src"]')!);
	expect(rows()).toEqual(['src', 'src/app', 'src/a.ts', 'package.json']);
	await press(tree.querySelector<HTMLButtonElement>('button[title="src/a.ts"]')!);
	expect(el.querySelector('[aria-label="src/a.ts"]')?.textContent).toBe('x');
});

it('Studio opens the tab its deep link names, reports tab moves, and shows the diagnosis by severity (L-BOLT-528, 530)', async () => {
	const view: StudioView = { commit: 'c2', files: { 'src/a.ts': 'x' }, changes: [], log: [], preview: null, releases: [], sections: null,
		diagnostics: [{ code: 'types/TS2322', path: 'src/a.ts', line: 3, message: 'bad' }, { code: 'doctor/LIVE1', path: 'src/a.ts', message: 'poll', severity: 'warn' }] };
	const moved: StudioTab[] = [];
	const el = show(Studio, { logs, studio: async () => ({ ok: true, value: view }), studioRun: async () => ({ ok: true, value: view }) }, { tab: 'live', onTab: (x) => moved.push(x) });
	await settle();
	expect(el.querySelector('[role=tab][data-state=active]')?.textContent?.trim()).toBe('Live');
	await press([...el.querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.trim() === 'Workbench')!);
	expect(moved).toEqual(['workbench']);
	expect([...el.querySelectorAll('[data-diagnosis] li')].map((x) => x.getAttribute('data-severity'))).toEqual(['error', 'warn']);
	const first = [...el.querySelectorAll('[data-diagnosis] button')][0]!.querySelectorAll('span');
	expect([first[0]?.textContent, first.item(first.length - 1)?.textContent]).toEqual(['Error · types/TS2322', 'src/a.ts:3']);
});

it('Studio shows a member who is not an administrator their own draft and merge request only: no publish, review, merge, restore or live-data preview', async () => {
	const mr = (id: string, branch: string): StudioMergeRequest => ({ id, title: `mr ${id}`, state: 'ready', openedBy: 'x', contributors: [], branch, base: 'c1', head: 'c2', behind: 0,
		decision: null, comments: [], preview: null, log: [], createdAt: '2026-09-25T00:00:00Z', readyAt: null, updatedAt: '2026-09-25T00:00:00Z' });
	const view: StudioView = { commit: 'c2', files: { 'src/a.ts': 'x' }, changes: [{ path: 'src/a.ts', change: 'modified' }], log: [], preview: null, sections: null, branch: 'u/rep',
		target: 'workbench', releases: [{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true }, { commit: 'c1', at: '2026-09-24T00:00:00Z', message: 'one', current: false, checkpoint: '2026-09-24T00:00:00Z' }],
		mergeRequests: [mr('1', 'u/rep'), mr('2', 'u/ada')] };
	const el = show(Studio, { studio: async () => ({ ok: true, value: view }), studioRun: async () => ({ ok: true, value: view }) }, { admin: false });
	await settle();
	const buttons = () => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
	expect(buttons()).toContain('Open merge request');
	expect(buttons()).not.toContain('Publish');
	// the target picker offers the member's own merge request, never another's
	await press(el.querySelector<HTMLElement>('[role=combobox][aria-label=Target]')!);
	expect([...document.querySelectorAll('[role=option]')].map((o) => o.getAttribute('data-value'))).toEqual(['workbench', '1']);
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await settle();
	const open = (label: string) => press([...el.querySelectorAll<HTMLElement>('[role=tab], button')].find((x) => x.textContent?.trim() === label || x.textContent?.trim().startsWith(`${label} `))!);
	await open('Live');
	expect(buttons()).not.toContain('Restore');
	await open('Changes');
	await open('!1 mr 1');
	expect(buttons()).toEqual(expect.arrayContaining(['Edit', 'Close']));
	await open('Conversation');
	expect(buttons()).toContain('Comment');
	expect(buttons()).not.toContain('Approve');
	expect(buttons()).not.toContain('Merge');
	await open('!2 mr 2');
	expect(buttons()).not.toContain('Edit');
	expect(buttons()).not.toContain('Close');
	await open('Conversation');
	expect(buttons()).not.toContain('Comment');
});
