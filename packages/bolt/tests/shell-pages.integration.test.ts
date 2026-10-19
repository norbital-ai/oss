// @vitest-environment happy-dom
// Studio mounted over a fake shell API: it restores live to a recorded commit through the host port.
import './setup-happy-dom.js';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { shellApi } from '../src/shell/runtime.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { beforeEach, afterEach, expect, it, vi } from '@effect/vitest';
import type { LogQuery, LogRow } from '../src/shell/logs/data.ts';
import type { ShellApi } from '../src/shell/api-types.ts';
import type { StudioMergeRequest, StudioOp, StudioView } from '../src/shell/studio/model.ts';
import type { StudioTab } from '../src/shell/nav.ts';
import Studio from '../src/shell/studio/Studio.svelte';
import LivePane from '../src/shell/studio/LivePane.svelte';

const views: (() => Promise<void>)[] = [];
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
	dispose = mountEdge(ManagedRuntime.make(Layer.empty));
});
afterEach(async () => {
	for (const close of views.splice(0)) await close();
	await dispose?.();
});
function show(
	C: typeof Studio,
	api: Partial<ShellApi>,
	more: { tab?: StudioTab; onTab?: (tab: StudioTab) => void; admin?: boolean } = {}
) {
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(C, {
		target,
		props: {
			api: { ...shellApi(async () => Response.json({ value: null })), ...api },
			t: (k: string) => k,
			...more
		}
	});
	views.push(async () => {
		await unmount(v);
		target.remove();
	});
	return target;
}
const settle = async () => {
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};

/** Studio's runtime log reads `sys_event` through the logs port; an empty page is enough here. */
const logs = () => Effect.succeed<LogRow[]>([]);
const press = async (b: HTMLElement) => {
	b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
	b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
	b.click();
	await settle();
};

it('Studio keeps the tab hierarchy and restores live to a recorded commit through the port', async () => {
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/a.ts': 'x' },
		changes: [],
		log: [],
		preview: null,
		releases: [
			{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true },
			{ commit: 'c1', at: '2026-09-24T00:00:00Z', message: 'one', current: false }
		],
		environments: [
			{ name: 'preview', release: 'r2', url: 'https://acme--preview.example' },
			{ name: 'live', release: 'r1', url: 'https://acme.example' }
		],
		sections: {
			collections: [{ name: 'tasks', path: 'src/data/collection/tasks/+collection.ts' }],
			pipelines: [],
			apps: [],
			kiosks: [],
			policies: [],
			automations: [],
			remotes: [],
			secrets: []
		}
	};
	const ran: StudioOp[] = [];
	vi.stubGlobal('confirm', () => true);
	const el = show(Studio, {
		logs,
		studio: () => Effect.succeed(view),
		studioRun: (op) =>
			Effect.sync(() => {
				ran.push(op);
				return view;
			})
	});
	await settle();
	const tabs = () => [...el.querySelectorAll('[role=tab]')].map((b) => b.textContent?.trim());
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live']);
	const click = (label: string) =>
		press(
			[...el.querySelectorAll<HTMLElement>('[role=tab], button')].find(
				(x) => x.textContent?.trim() === label
			)!
		);
	await click('Changes');
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live', 'Files', 'Manifest', 'Logs']);
	await click('Manifest');
	expect(tabs()).toEqual([
		'Workbench',
		'Changes',
		'Live',
		'Files',
		'Manifest',
		'Logs',
		'Collections',
		'Pipelines',
		'Apps',
		'Kiosks',
		'Policies',
		'Automations',
		'Remotes',
		'Secrets'
	]);
	// levels come from nesting alone: segmented > underline > chips
	expect(
		[...el.querySelectorAll('[data-tabs-variant]')].map((x) => x.getAttribute('data-tabs-variant'))
	).toEqual(['segmented', 'underline', 'chips']);
	await click('Live');
	expect(tabs()).toEqual(['Workbench', 'Changes', 'Live', 'Runtime log', 'Operations']);
	// the rail picks the recorded commit; Roll back returns live to it (a source rollback)
	await press(
		[...el.querySelectorAll<HTMLElement>('aside button')].find((x) =>
			x.textContent?.includes('one')
		)!
	);
	await click('Roll back');
	expect(ran).toEqual([{ op: 'rollback', commit: 'c1' }]);
	// Operations (L-BOLT-534): the routed environments, live first
	await click('Operations');
	expect([...el.querySelectorAll('li strong')].map((x) => x.textContent)).toEqual([
		'live',
		'preview'
	]);
	vi.unstubAllGlobals();
});

it('Studio lists the workspace as a file tree: folders fold, a file opens by its full path (L-BOLT-748)', async () => {
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/a.ts': 'x', 'src/app/sales/+app.ts': 'y', 'package.json': '{}' },
		changes: [],
		log: [],
		preview: null,
		releases: [],
		sections: null
	};
	const el = show(Studio, {
		studio: () => Effect.succeed(view),
		studioRun: () => Effect.succeed(view)
	});
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
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/a.ts': 'x' },
		changes: [],
		log: [],
		preview: null,
		releases: [],
		sections: null,
		diagnostics: [
			{ code: 'types/TS2322', path: 'src/a.ts', line: 3, message: 'bad' },
			{ code: 'doctor/LIVE1', path: 'src/a.ts', message: 'poll', severity: 'warn' }
		]
	};
	const moved: StudioTab[] = [];
	const el = show(
		Studio,
		{ logs, studio: () => Effect.succeed(view), studioRun: () => Effect.succeed(view) },
		{ tab: 'live', onTab: (x) => moved.push(x) }
	);
	await settle();
	expect(el.querySelector('[role=tab][data-state=active]')?.textContent?.trim()).toBe('Live');
	await press(
		[...el.querySelectorAll<HTMLElement>('[role=tab]')].find(
			(x) => x.textContent?.trim() === 'Workbench'
		)!
	);
	expect(moved).toEqual(['workbench']);
	expect(
		[...el.querySelectorAll('[data-diagnosis] li')].map((x) => x.getAttribute('data-severity'))
	).toEqual(['error', 'warn']);
	const first = [...el.querySelectorAll('[data-diagnosis] button')][0]!.querySelectorAll('span');
	expect([first[0]?.textContent, first.item(first.length - 1)?.textContent]).toEqual([
		'Error · types/TS2322',
		'src/a.ts:3'
	]);
});

it('Studio rolls back across a schema change only after naming the data lost, and opens a build log', async () => {
	const view: StudioView = {
		commit: 'c3',
		files: {},
		changes: [],
		log: [],
		preview: null,
		releases: [
			{
				commit: 'c3',
				at: '2026-09-26T00:00:00Z',
				message: 'Rolled back to c1: one',
				current: true,
				rollback: 'c1',
				checkpoint: '2026-09-26T00:00:00Z'
			},
			{
				commit: 'c1',
				at: '2026-09-24T00:00:00Z',
				message: 'one',
				current: false,
				checkpoint: '2026-09-24T00:00:00Z',
				discards: '2026-09-24T00:00:00Z'
			}
		],
		builds: [
			{
				commit: 'c1',
				at: '2026-09-24T00:00:00Z',
				status: 'built',
				message: 'one',
				deployed: true,
				live: true,
				lines: 1,
				diagnostics: 0
			}
		],
		sections: null
	};
	const ran: StudioOp[] = [],
		asked: string[] = [],
		read: string[] = [];
	vi.stubGlobal('confirm', (text: string) => (asked.push(text), true));
	const el = show(Studio, {
		logs,
		studio: () => Effect.succeed(view),
		studioRun: (op) => Effect.sync(() => (ran.push(op), view)),
		studioBuild: (commit) =>
			Effect.sync(() => {
				read.push(commit);
				return {
					build: view.builds![0]!,
					log: [{ at: '2026-09-24T00:00:01Z', level: 'info' as const, message: 'compiled one' }],
					diagnostics: []
				};
			})
	});
	await settle();
	const button = (label: string) =>
		[...el.querySelectorAll<HTMLElement>('[role=tab], button')].find((x) =>
			x.textContent?.trim().startsWith(label)
		)!;
	await press(button('Live'));
	expect(el.textContent).toContain('Rolled back to c1');
	await press(
		[...el.querySelectorAll<HTMLElement>('aside button')].find(
			(x) => x.textContent?.includes('one') && !x.textContent.includes('Rolled')
		)!
	);
	await press(button('Roll back'));
	expect(asked[0]).toContain('will be lost');
	expect(ran).toEqual([{ op: 'rollback', commit: 'c1', discardDataSince: '2026-09-24T00:00:00Z' }]);
	await press(button('Build log of'));
	await settle();
	expect(read).toEqual(['c1']);
	expect(document.body.textContent).toContain('compiled one');
});

it('Studio shows a member who is not an administrator their own draft and merge request only: no publish, review, merge, restore or live-data preview', async () => {
	const mr = (id: string, branch: string): StudioMergeRequest => ({
		id,
		title: `mr ${id}`,
		state: 'ready',
		openedBy: 'x',
		contributors: [],
		branch,
		base: 'c1',
		head: 'c2',
		behind: 0,
		decision: null,
		comments: [],
		preview: null,
		log: [],
		createdAt: '2026-09-25T00:00:00Z',
		readyAt: null,
		updatedAt: '2026-09-25T00:00:00Z'
	});
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/a.ts': 'x' },
		changes: [{ path: 'src/a.ts', change: 'modified' }],
		log: [],
		preview: null,
		sections: null,
		branch: 'u/rep',
		target: 'workbench',
		releases: [
			{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true },
			{
				commit: 'c1',
				at: '2026-09-24T00:00:00Z',
				message: 'one',
				current: false,
				checkpoint: '2026-09-24T00:00:00Z'
			}
		],
		mergeRequests: [mr('1', 'u/rep'), mr('2', 'u/ada')]
	};
	const el = show(
		Studio,
		{ studio: () => Effect.succeed(view), studioRun: () => Effect.succeed(view) },
		{ admin: false }
	);
	await settle();
	const buttons = () => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
	expect(buttons()).toContain('Open merge request');
	expect(buttons()).not.toContain('Publish');
	// the target picker offers the member's own merge request, never another's
	await press(el.querySelector<HTMLElement>('[role=combobox][aria-label=Target]')!);
	expect(
		[...document.querySelectorAll('[role=option]')].map((o) => o.getAttribute('data-value'))
	).toEqual(['workbench', '1']);
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await settle();
	const open = (label: string) =>
		press(
			[...el.querySelectorAll<HTMLElement>('[role=tab], button')].find(
				(x) => x.textContent?.trim() === label || x.textContent?.trim().startsWith(`${label} `)
			)!
		);
	await open('Live');
	expect(buttons()).not.toContain('Roll back');
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

it("Live scopes the runtime log to the selected deployment's live window, and narrows it by run", async () => {
	const releases = [
		{ commit: 'c3', at: '2026-09-26T00:00:00Z', message: 'three', current: false },
		{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true },
		{ commit: 'c1', at: '2026-09-24T00:00:00Z', message: 'one', current: false }
	];
	const view: StudioView = {
		commit: 'c2',
		files: {},
		changes: [],
		log: [],
		preview: null,
		releases,
		sections: null
	};
	const asked: LogQuery[] = [];
	const api: ShellApi = {
		...shellApi(async () => Response.json({ value: null })),
		logs: (x) =>
			Effect.sync(() => {
				asked.push(x);
				return [];
			})
	};
	const pane = (release: StudioView['releases'][number]) => {
		const target = document.body.appendChild(document.createElement('div'));
		const v = mount(LivePane, {
			target,
			props: {
				api,
				view,
				release,
				admin: true,
				busy: false,
				sub: 'runtime',
				onsub: () => {},
				onrestore: () => {},
				t: (k: string) => k
			}
		});
		views.push(async () => {
			await unmount(v);
			target.remove();
		});
		return target;
	};
	const read = async () => {
		await new Promise((r) => setTimeout(r, 400));
		await settle();
		return asked.at(-1);
	};
	pane(releases[2]!);
	// an earlier deployment: from its time to the next one's
	expect(await read()).toEqual({ since: '2026-09-24T00:00:00Z', until: '2026-09-25T00:00:00Z' });
	const live = pane(releases[1]!);
	// the serving one: open-ended
	expect(await read()).toEqual({ since: '2026-09-25T00:00:00Z' });
	const run = live.querySelector<HTMLInputElement>('input[aria-label="Filter by run"]')!;
	run.value = 'r-7';
	run.dispatchEvent(new Event('input', { bubbles: true }));
	expect(await read()).toEqual({ run: 'r-7', since: '2026-09-25T00:00:00Z' });
});
