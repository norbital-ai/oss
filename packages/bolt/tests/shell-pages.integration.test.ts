// @vitest-environment happy-dom
// Studio mounted over a fake shell API: it restores live to a recorded commit through the host port.
import './setup-happy-dom.js';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { shellApi } from '../src/shell/runtime.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { beforeEach, afterEach, expect, it, vi } from '@effect/vitest';
import type { ShellApi } from '../src/shell/api-types.ts';
import type { StudioInspectInput, StudioInspection } from '../src/shell/studio/inspection.ts';
import type { WorkspaceOperation } from '@norbital-ai/ui';
import type { StudioChangeSet, StudioOp, StudioView } from '../src/shell/studio/model.ts';
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
	api: Partial<ShellApi> & Pick<ShellApi, 'studio'>,
	more: { tab?: StudioTab; onTab?: (tab: StudioTab) => void; admin?: boolean } = {}
) {
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(C, {
		target,
		props: {
			api: {
				...shellApi(async () => Response.json({ value: null })),
				studioInspect: (input: StudioInspectInput) =>
					api.studio().pipe(Effect.map((view) => inspection(view, input))),
				...api
			},
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

/** The host's curated operational DTO: no source files or edit state crosses this boundary. */
const inspection = (view: StudioView, input: StudioInspectInput) =>
	({
		canInspect: true,
		asOf: '2026-09-26T00:00:00Z',
		usage: [],
		members: [],
		studio: {
			commit: view.commit,
			message: view.message ?? '',
			builds: view.builds ?? [],
			releases: view.releases,
			environments: view.environments ?? [],
			changes: (view.changeSets ?? []).map((change) => ({
				id: change.id,
				title: change.title,
				state: change.state,
				head: change.head,
				createdAt: change.createdAt,
				updatedAt: change.updatedAt,
				behind: change.behind,
				...(change.merge === undefined ? {} : { merge: change.merge }),
				preview: change.preview
			})),
			log: view.log,
			diagnostics: view.diagnostics ?? [],
			build: null
		},
		logs: [],
		bundles: null,
		cache: null,
		errors: null,
		filters: {
			level: input.level ?? null,
			text: input.text ?? '',
			run: input.run ?? '',
			build: input.build ?? null
		}
	}) satisfies StudioInspection;
/** Answers the open in-app confirmation (never `window.confirm`, which WebViews suppress); its text is returned. */
const answer = async (accept: boolean) => {
	await vi.waitFor(() =>
		expect(document.querySelector('[data-confirm-dialog][data-state=open]')).not.toBeNull()
	);
	const dialog = document.querySelector<HTMLElement>('[data-confirm-dialog][data-state=open]')!;
	const text = dialog.textContent ?? '';
	dialog
		.querySelector<HTMLButtonElement>(accept ? '[data-confirm-accept]' : '[data-confirm-cancel]')!
		.click();
	await settle();
	return text;
};
const press = async (b: HTMLElement) => {
	b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
	b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
	b.click();
	await settle();
};

it('Studio restores live to a recorded commit through the port after confirmation', async () => {
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/a.ts': { bytes: 1 } },
		changes: [],
		log: [],
		preview: null,
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
		environments: [
			{ name: 'preview', release: 'r2', url: 'https://acme--preview.example' },
			{ name: 'live', release: 'r1', url: 'https://acme.example' }
		],
		sections: {
			models: [{ name: 'tasks', path: 'src/data/model/tasks/+model.ts' }],
			apps: [],
			kiosks: [],
			policies: [],
			automations: [],
			remotes: [],
			secrets: []
		}
	};
	const ran: StudioOp[] = [];
	const inspected: StudioInspectInput[] = [];
	const el = show(Studio, {
		studioInspect: (input: StudioInspectInput) =>
			Effect.sync(() => {
				inspected.push(input);
				return inspection(view, input);
			}),
		studio: () => Effect.succeed(view),
		studioRun: (op) =>
			Effect.sync(() => {
				ran.push(op);
				return view;
			})
	});
	await settle();
	const click = (label: string) =>
		press(
			[...el.querySelectorAll<HTMLElement>('[role=tab], button')].find(
				(x) => x.textContent?.trim() === label
			)!
		);
	await click('Live');
	await click('Activity');
	const entry = () => el.querySelector<HTMLElement>('[data-release-timeline] [data-commit="c1"]')!;
	await press(entry().querySelector<HTMLElement>('button[title="c1"]')!);
	expect(inspected.at(-1)).toMatchObject({ build: 'c1' });
	const rollback = () =>
		[...entry().querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent?.trim() === 'Roll back'
		)!;
	await press(rollback());
	expect(ran).toEqual([]);
	await answer(false);
	expect(ran).toEqual([]);
	await press(rollback());
	await answer(true);
	expect(ran).toEqual([{ op: 'rollback', commit: 'c1' }]);
	// Shared operations confirm once, then delegate directly to the native Studio port.
	expect(document.querySelector('[data-confirm-dialog][data-state=open]')).toBeNull();
});

it('Studio lists the workspace as a file tree: folders fold, a file opens by its full path (L-BOLT-748)', async () => {
	const view: StudioView = {
		commit: 'c2',
		files: {
			'src/a.ts': { bytes: 1 },
			'src/app/sales/+app.ts': { bytes: 1 },
			'package.json': { bytes: 2 },
			'assets/logo.png': { bytes: 2048 },
			'seed/big.json': { bytes: 3_145_728 }
		},
		changes: [],
		log: [],
		preview: null,
		releases: [],
		sections: null
	};
	// the state carries only the tree; a file's text is read when it opens, once per commit
	const read: string[] = [];
	const el = show(Studio, {
		studio: () => Effect.succeed(view),
		studioRun: () => Effect.succeed(view),
		studioFile: (commit, path) =>
			Effect.sync(() => {
				read.push(`${commit}:${path}`);
				return path === 'assets/logo.png'
					? { binary: true as const, bytes: 2048 }
					: path === 'seed/big.json'
						? { text: '[', truncated: { limit: 1_048_576, bytes: 3_145_728 } }
						: { text: path === 'src/a.ts' ? 'x' : 'y' };
			})
	});
	await settle();
	const tree = el.querySelector('[data-file-tree]')!;
	const rows = () => [...tree.querySelectorAll('button')].map((b) => b.getAttribute('title'));
	const open = (path: string) => {
		const row = tree.querySelector<HTMLButtonElement>(`button[title="${path}"]`);
		if (row === null) throw new Error(`no tree row ${path}`);
		return press(row);
	};
	// folders first and closed; opening one lists its folders, then its files
	expect(rows()).toEqual(['assets', 'seed', 'src', 'package.json']);
	expect(read).toEqual([]);
	await open('src');
	expect(rows()).toEqual(['assets', 'seed', 'src', 'src/app', 'src/a.ts', 'package.json']);
	await open('src/a.ts');
	await settle();
	expect(el.querySelector('[aria-label="src/a.ts"]')?.textContent).toBe('x');
	await open('package.json');
	await settle();
	await open('src/a.ts');
	await settle();
	expect(read).toEqual(['c2:src/a.ts', 'c2:package.json']);
	// a binary file and a file past the host's bound open read-only, saying why
	await open('assets');
	await open('assets/logo.png');
	await settle();
	expect(el.querySelector('[data-file-note]')?.textContent).toBe('Not a text file · 2K');
	expect(el.querySelector('[aria-label="assets/logo.png"]')?.getAttribute('contenteditable')).toBe(
		'false'
	);
	await open('seed');
	await open('seed/big.json');
	await settle();
	expect(el.querySelector('[data-file-note]')?.textContent).toBe(
		'Shown up to 1M of 3M · read-only here'
	);
	expect(el.querySelector('[aria-label="seed/big.json"]')?.textContent).toBe('[');
});

it('Studio opens the tab its deep link names, reports tab moves, and shows the diagnosis by severity (L-BOLT-528, 530)', async () => {
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/a.ts': { bytes: 1 } },
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
		{ studio: () => Effect.succeed(view), studioRun: () => Effect.succeed(view) },
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

it('Studio inspects a retained timeline build and confirms schema rollback once', async () => {
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
	const el = show(Studio, {
		studio: () => Effect.succeed(view),
		studioRun: (op) => Effect.sync(() => (ran.push(op), view)),
		studioInspect: (input: StudioInspectInput) =>
			Effect.sync(() => {
				const result = inspection(view, input);
				if (input.build !== 'c1') return result;
				read.push(input.build);
				const retained = view.builds?.find((build) => build.commit === input.build);
				if (retained === undefined) throw new Error('Missing retained fixture build');
				return {
					...result,
					studio: {
						...result.studio,
						build: {
							build: retained,
							log: [{ at: '2026-09-24T00:00:01Z', level: 'info', message: 'compiled one' }],
							diagnostics: []
						}
					}
				} satisfies StudioInspection;
			})
	});
	await settle();
	const button = (label: string) =>
		[...el.querySelectorAll<HTMLElement>('[role=tab], button')].find((x) =>
			x.textContent?.trim().startsWith(label)
		)!;
	await press(button('Live'));
	await press(button('Activity'));
	const entry = () => el.querySelector<HTMLElement>('[data-release-timeline] [data-commit="c1"]')!;
	await press(entry().querySelector<HTMLElement>('button[title="c1"]')!);
	expect(read).toEqual(['c1']);
	expect(el.querySelector('[aria-label="Selected build"]')?.textContent).toContain('compiled one');
	const rollback = [...entry().querySelectorAll<HTMLButtonElement>('button')].find(
		(button) => button.textContent?.trim() === 'Roll back'
	)!;
	await press(rollback);
	asked.push(await answer(true));
	expect(asked).toHaveLength(1);
	expect(asked[0]).toContain('will be lost');
	expect(ran).toEqual([{ op: 'rollback', commit: 'c1', discardDataSince: '2026-09-24T00:00:00Z' }]);
	expect(document.querySelector('[data-confirm-dialog][data-state=open]')).toBeNull();
});

it('Studio opens another change and merges a previewed head through the port; non-administrators cannot merge or roll back', async () => {
	const change = (id: string, title: string): StudioChangeSet => ({
		id,
		title,
		state: 'open',
		openedBy: 'ada@example.com',
		contributors: ['ada@example.com'],
		branch: `change/${id}`,
		base: 'c1',
		head: `h${id}`,
		behind: 0,
		preview: {
			url: `https://workspace--change-${id}.example`,
			commit: `h${id}`,
			artifact: 'a',
			stale: false,
			destructive: ['drop column leave.days'],
			impact: {
				durationMs: 1200,
				steps: [
					{ id: 'create:table:leave_types', hazard: 'additive', rows: 0, summary: '' },
					{ id: 'drop:column:leave.days', hazard: 'destructive', rows: 331, summary: '' }
				]
			}
		},
		log: [],
		createdAt: '2026-09-25T00:00:00Z',
		updatedAt: '2026-09-25T00:00:00Z'
	});
	const view: StudioView = {
		commit: 'h1',
		files: { 'src/a.ts': { bytes: 1 } },
		changes: [{ path: 'src/a.ts', change: 'modified', text: 'b', baseline: 'a' }],
		log: [],
		preview: null,
		sections: null,
		change: '1',
		branch: 'change/1',
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
		changeSets: [change('1', 'Leave rules'), change('2', 'Payslip footer')]
	};
	const ran: StudioOp[] = [];
	let current = view;
	const studio = (admin: boolean) =>
		show(
			Studio,
			{
				studio: () => Effect.succeed(current),
				studioRun: (op) =>
					Effect.sync(() => {
						ran.push(op);
						if (op.op === 'change.open' && 'id' in op) {
							const opened = current.changeSets?.find((change) => change.id === op.id);
							if (opened === undefined) throw new Error('The selected fixture change is missing.');
							current = {
								...current,
								commit: opened.head,
								change: opened.id,
								branch: opened.branch
							};
						}
						return current;
					})
			},
			{ admin }
		);
	const el = studio(true);
	await settle();
	const open = (label: string) =>
		press(
			[...el.querySelectorAll<HTMLElement>('[role=tab], button')].find(
				(x) => x.textContent?.trim() === label || x.textContent?.trim().startsWith(`${label} `)
			)!
		);
	// the toolbar names the change the viewer works on; nothing ships but Merge
	expect(el.querySelector('[data-change="1"]')?.textContent).toContain('Leave rules');
	await open('Changes');
	await open('!2 Payslip footer');
	await open('Work on it');
	expect(ran).toEqual([{ op: 'change.open', id: '2' }]);
	expect(el.querySelector('[data-change="2"]')?.textContent).toContain('Payslip footer');
	// working on it went back to the Workbench; the merge is the Changes pane's
	await open('Changes');
	await open('!1 Leave rules');
	// the review says, in plain words, what the preview measured merging does to the data
	expect(el.textContent).toContain('Drops column leave.days — 331 rows with a value');
	expect(el.textContent).not.toContain('Adds leave_types');
	await open('Work on it');
	expect(ran.at(-1)).toEqual({ op: 'change.open', id: '1' });
	expect(el.querySelector('[data-change="1"]')?.textContent).toContain('Leave rules');
	await open('Merge');
	// the merge accepts the destructive steps its current preview names, after the person read them
	const asked = await answer(true);
	expect(asked).toContain('drop column leave.days');
	expect(asked).toContain(
		'Drops column leave.days — 331 rows with a value. Expected downtime about 1 s (measured on the preview).'
	);
	expect(ran.at(-1)).toEqual({ op: 'change.merge', id: '1', accept: ['drop column leave.days'] });
	const member = studio(false);
	await settle();
	const theirs = () => [...member.querySelectorAll('button')].map((b) => b.textContent?.trim());
	expect(theirs()).not.toContain('Merge');
	await press(
		[...member.querySelectorAll<HTMLElement>('[role=tab]')].find(
			(x) => x.textContent?.trim() === 'Live'
		)!
	);
	expect(theirs()).not.toContain('Roll back');
});

it('Live delegates run and resource scope to the shared inspection without exposing source edits', async () => {
	const view: StudioView = {
		commit: 'c2',
		files: { 'src/private.ts': { bytes: 12 } },
		changes: [],
		log: [],
		preview: null,
		releases: [],
		sections: null
	};
	const asked: StudioInspectInput[] = [];
	const operated: WorkspaceOperation[] = [];
	const api: ShellApi = {
		...shellApi(async () => Response.json({ value: null })),
		studioInspect: (input: StudioInspectInput) =>
			Effect.sync(() => {
				asked.push(input);
				return {
					...inspection(view, input),
					logs: [
						{
							id: 'line-1',
							at: '2026-09-25T00:00:00Z',
							severity: 'info',
							event: 'run.finished',
							invocation: 'invocation-1',
							run: 'r-7',
							conversation: null,
							turn: null,
							attributes: {}
						}
					]
				} satisfies StudioInspection;
			})
	};
	const target = document.body.appendChild(document.createElement('div'));
	const v = mount(LivePane, {
		target,
		props: {
			api,
			view,
			admin: true,
			busy: false,
			sub: 'runtime',
			onsub: () => {},
			onoperate: (operation: WorkspaceOperation) =>
				Effect.sync(() => {
					operated.push(operation);
				}),
			t: (key: string) => key
		}
	});
	views.push(async () => {
		await unmount(v);
		target.remove();
	});
	await settle();
	expect(asked.at(-1)).toEqual({ range: '7d', build: null, run: null });
	await press(target.querySelector<HTMLElement>('[role="combobox"][aria-label="Automation run"]')!);
	await press(
		[...document.querySelectorAll<HTMLElement>('[role="option"]')]
			.find((option) => option.textContent?.trim() === 'r-7')!
			.querySelector<HTMLButtonElement>('button')!
	);
	expect(asked.at(-1)).toMatchObject({ run: 'r-7' });
	await press(
		[...target.querySelectorAll<HTMLElement>('[role="tab"]')].find(
			(tab) => tab.textContent?.trim() === 'Resources'
		)!
	);
	await press(
		[...target.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent?.trim() === '24h'
		)!
	);
	expect(asked.at(-1)).toMatchObject({ range: '24h', run: 'r-7' });
	expect(operated).toEqual([]);
	expect(target.querySelector('[data-file-tree], [contenteditable="true"]')).toBeNull();
});
