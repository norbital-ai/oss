/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Agent from '../src/shell/agent/Agent.svelte';
import { create_bolt } from '../src/page/bolt.ts';
import { QBody, type AgentConversation, type AgentRow } from '../src/protocol/schema.ts';
import { shell_api } from '../src/shell/runtime.ts';
import type { FinderRead } from '../src/shell/finder/model.ts';
import { view_client } from '../src/page/view-client.ts';
import AgentSheet from './support/agent-sheet.svelte';
import './support/shell.css';

const taskNames = [
	'Docs metadata and release notes for the workspace migration',
	'Control permissions',
	'Read API',
	'Public templates',
	'Private templates',
	'API compatibility',
	'Failed transcript',
	'Pending transcript'
];
const reportBody =
	'The workspace migration notes are ready.\nPermissions and API changes are included.';
const imageFixtures = new Map([
	['image-input', new URL('./fixtures/files/photo.png', import.meta.url).href],
	['image-output', new URL('./fixtures/files/photo.jpg', import.meta.url).href]
]);
const row = (id: string, seq: number, text: string): AgentRow => ({
	id,
	seq,
	role: 'user',
	text,
	state: null,
	tag: null
});
const fixture = (preview = false) => {
	const at = new Date(Date.now() - 178_000).toISOString();
	const conversation: AgentConversation = {
		id: 'rail-root',
		title: 'Workspace migration',
		at,
		status: 'idle',
		model: 'default',
		plan: null,
		envoy: null,
		integration: null,
		kind: null,
		thread: null,
		peer: null
	};
	const conversations: AgentConversation[] = [
		conversation,
		...['alpha', 'zulu'].map((envoy) => ({
			...conversation,
			id: `envoy-${envoy}`,
			title: `${envoy} updates`,
			envoy,
			integration: 'chat',
			kind: 'dm' as const,
			thread: envoy,
			peer: envoy
		}))
	];
	const children = taskNames.map((name, index) => {
		const id = `rail-child-${index}`;
		const rows: AgentRow[] = [{ ...row(`${id}-task`, 1, name), at }];
		if (index < 3)
			rows.push({
				...row(`${id}-step`, 2, ''),
				role: 'tool',
				at,
				tool: { behavior: {}, name: 'read', failed: false, args: '{"documents":{}}', ms: 200 }
			});
		else
			rows.push({
				...row(`${id}-answer`, 2, 'Finished reviewing the templates.'),
				role: 'assistant',
				tag: 'reply',
				at
			});
		return { id, rows, status: index === 5 ? 'stopped' : index < 3 ? 'running' : 'idle' };
	});
	const rows: AgentRow[] = [{ ...row('rail-prompt', 1, 'Coordinate the workspace migration.'), files: [
		{ id: 'image-input', name: 'workspace-reference.png', mime: 'image/png' },
		{ id: 'input', name: 'workspace-migration-requirements.pdf', mime: 'application/pdf' }
	] }];
	for (const [index, child] of children.entries())
		rows.push({
			...row(`spawn-${index}`, index + 2, ''),
			role: 'tool',
			at,
			tool: { behavior: {},
				name: 'subagent',
				failed: false,
				child: child.id,
				ms: 20,
				args: JSON.stringify({ task: taskNames[index] })
			}
		});
	for (const [index, [name, args]] of ([
		['subagent_message', { conversation: 'rail-child-0', text: 'Please include permissions.' }],
		['subagent_stop', { conversation: 'rail-child-5' }]
	] as const).entries())
		rows.push({
			...row(`subagent-action-${index}`, index + 10, ''),
			role: 'tool',
			at,
			tool: { behavior: {}, name, failed: false, ms: 20, args: JSON.stringify(args) }
		});
	rows.push({
		...row(
			'rail-report',
			12,
			`Sub-agent "Public templates" (conversation rail-child-3) finished: ${reportBody}`
		),
		at,
		state: 'queued',
		tag: 'report',
		report: { conversation: 'rail-child-3' }
	});
	if (preview)
		rows.push({
			...row('preview-ready', 14, ''),
			role: 'tool',
			tool: { behavior: {},
				name: 'workspace_preview',
				studio: 'preview',
				failed: false,
				preview: 'about:blank',
				about: { commit: 'preview-version' }
			}
		});
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).pathname.endsWith('/models'))
			return Response.json({
				value: { models: [{ id: 'default', label: 'Default' }], default: 'default', mcp: [] }
			});
		const { reads } = Schema.decodeUnknownSync(QBody)(await request.json());
		const read = reads[0];
		// the open list holds every conversation; the archived read, none
		if (read?.m === 'conversations')
			return Response.json({ answers: [{ rows: read.a.length === 0 ? conversations : [] }] });
		const id = read?.a[0];
		if (id === conversation.id)
			return Response.json({
				answers: [
					{
						rows,
						inputs: [
							{
								id: 'input',
								name: 'workspace-migration-requirements.pdf',
								mime: 'application/pdf'
							},
							{ id: 'image-input', name: 'workspace-reference.png', mime: 'image/png' }
						],
						outputs: [
							{ id: 'output', name: 'migration-plan.md', mime: 'text/markdown' },
							{ id: 'image-output', name: 'migration-preview.jpg', mime: 'image/jpeg' }
						]
					}
				]
			});
		if (id === 'rail-child-6')
			return Response.json(
				{
					error: { code: 'refused', message: 'This transcript is unavailable.' }
				},
				{ status: 403 }
			);
		if (id === 'rail-child-7')
			return new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener('abort', () => reject(request.signal.reason), {
					once: true
				});
			});
		const child = children.find((child) => child.id === id);
		if (child === undefined) throw new Error(`Unexpected rail read: ${String(id)}`);
		return Response.json({ answers: [{ rows: child.rows, status: child.status }] });
	};
	return fetch;
};

const element = <T extends HTMLElement = HTMLElement>(target: HTMLElement, selector: string) => {
	const found = target.querySelector<T>(selector);
	if (found === null) throw new Error(`Missing rail element: ${selector}`);
	return found;
};

const settleMotion = async (target: HTMLElement) => {
	for (let pass = 0; pass < 2; pass++) {
		await tick();
		const settled = await Promise.allSettled(
			target
				.getAnimations({ subtree: true })
				.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
				.map((animation) => animation.finished)
		);
		for (const result of settled) {
			if (result.status !== 'rejected') continue;
			const failure: unknown = result.reason;
			if (!(failure instanceof DOMException && failure.name === 'AbortError')) throw failure;
		}
	}
};
const withComposer = async (
	sheet: boolean,
	check: (target: HTMLElement) => Promise<void>,
	preview = false
) => {
	const previous = {
		width: innerWidth,
		height: innerHeight
	};
	await page.viewport(1440, 900);
	sessionStorage.clear();
	const target = document.createElement('div');
	if (!sheet) target.style.cssText = 'height:100dvh;padding:16px;box-sizing:border-box';
	document.body.replaceChildren(target);
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mount_edge(runtime);
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fetch = fixture(preview);
					const client = yield* create_bolt({
						actor: null,
						operation_outputs: { automations: {} },
						locale: 'en',
						base: location.origin,
						fetch,
						live: 'snapshot'
					});
					const api = shell_api(fetch, { base: location.origin });
					// the rail searches no records: a finder read over no models
					const view = view_client(client, {}, {});
					const bolt: typeof client = {
						...client,
						file_url: (file, options) => imageFixtures.get(file.id) ?? client.file_url(file, options)
					};
					yield* Effect.promise(async () => {
						const props = {
							api,
							bolt,
							read: (request: Parameters<FinderRead>[0]) => view.query(request)
						};
						const view = sheet
							? mount(AgentSheet, { target, props })
							: mount(Agent, {
									target,
									props: {
										...props,
										ctx: { ui: { kinds: {} } },
										t: (key: string) => key,
										request: { conversation: 'rail-root' }
									}
								});
						try {
							await expect
								.element(page.getByRole('textbox', { name: 'Message', exact: true }))
								.toBeVisible();
							await expect
								.poll(() => target.querySelectorAll('[data-step][data-tool^="subagent"]').length)
								.toBe(10);
							await document.fonts.ready;
							await settleMotion(target);
							await check(target);
						} finally {
							await unmount(view);
						}
					});
				})
			)
		);
	} finally {
		await dispose();
		target.remove();
		await page.viewport(previous.width, previous.height);
	}
};

it.each(['MacIntel', 'Win32'])(
	'conversation footer cycles views and preserves search on %s',
	async (platform) => {
		const platformMock = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
		try {
			await withComposer(false, async (target) => {
				const picker = page.getByRole('combobox', { name: 'Conversations', exact: true });
				await picker.click();
				const footer = () => element(document.body, '[data-agent-views]');
				const currentView = () => element(footer(), '[data-agent-view]').textContent;
				const search = element<HTMLInputElement>(
					document.body,
					'[data-slot="popover-content"] input'
				);
				expect(footer().textContent).toContain(platform === 'Win32' ? 'Ctrl+→' : '⌘→');
				const cycle = async (key = 'ArrowRight', primary = true, from: Element = search) => {
					const apple = platform === 'MacIntel';
					const event = new KeyboardEvent('keydown', {
						key,
						bubbles: true,
						cancelable: true,
						metaKey: primary ? apple : !apple,
						ctrlKey: primary ? !apple : apple
					});
					from.dispatchEvent(event);
					await tick();
					return event.defaultPrevented;
				};
				expect(document.activeElement).toBe(search);
				expect(currentView()).toContain('Web UI');
				expect(await cycle('ArrowRight', false)).toBe(false);
				expect(currentView()).toContain('Web UI');
				for (const key of ['ArrowLeft', '<', '>', ',', '.']) {
					expect(await cycle(key)).toBe(false);
					expect(currentView()).toContain('Web UI');
				}
				expect(await cycle()).toBe(true);
				expect(currentView()).toContain('Alpha');
				expect(await cycle()).toBe(true);
				expect(currentView()).toContain('Zulu');
				expect(currentView()).toContain('Read only');
				expect(await cycle()).toBe(true);
				expect(currentView()).toContain('Web UI');
				expect(await cycle()).toBe(true);
				expect(currentView()).toContain('Alpha');
				await page.getByPlaceholder(/^Search/).fill('zulu');
				expect(currentView()).toMatch(/Alpha\s*0/);
				expect(await cycle()).toBe(true);
				expect(currentView()).toMatch(/Zulu\s*1/);
				expect(search.value).toBe('zulu');
				const web = page.getByRole('button', { name: 'Switch to Web UI', exact: true });
				web.element().focus();
				expect(await cycle('ArrowRight', true, web.element())).toBe(false);
				expect(await cycle()).toBe(false);
				expect(currentView()).toContain('Zulu');
				await userEvent.keyboard('{Enter}');
				await expect.element(web).toHaveAttribute('aria-pressed', 'true');
				await expect.element(picker).toHaveAttribute('aria-expanded', 'true');
				expect(currentView()).toContain('Web UI');
				expect(search.value).toBe('zulu');

				await userEvent.keyboard('{Escape}');
				await expect.element(picker).toHaveAttribute('aria-expanded', 'false');
				expect(element(target, '[data-agent-head]').textContent).toContain('Workspace migration');
			});
		} finally {
			platformMock.mockRestore();
		}
	}
);

it.each([
	{ name: 'full composer', sheet: false },
	{ name: 'side sheet', sheet: true }
])('rail navigation preserves focus and control state in $name', async ({ sheet }) => {
	await withComposer(sheet, async (target) => {
		const toggle = page.getByRole('button', { name: 'Session', exact: true });
		expect(target.querySelector('[data-agent-rail]')).toBeNull();
		await toggle.click();
		await expect
			.poll(() => element(target, '[data-subagent-summary]').textContent)
			.toMatch(/3\s*\/\s*8/);
		await settleMotion(target);
		const railElement = element(target, '[data-agent-rail]');
		const rail = page.getByRole('complementary', { name: 'Session', exact: true });
		if (sheet) expect(element(target, '[data-agent-chat]').hasAttribute('inert')).toBe(true);
		expect(railElement.contains(document.activeElement)).toBe(true);
		await expect.element(rail.getByRole('button', { name: 'Close', exact: true })).toHaveFocus();
		if (sheet) {
			await page.getByRole('button', { name: 'Full screen', exact: true }).click();
			await expect
				.poll(() => element(target, '[data-agent-chat]').hasAttribute('inert'))
				.toBe(false);
			await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
			await expect
				.poll(() => element(target, '[data-agent-chat]').hasAttribute('inert'))
				.toBe(true);
		}
		const completed = rail.getByRole('button', { name: 'Completed 2', exact: true });
		await completed.click();
		await settleMotion(target);
		await expect.element(completed).toHaveAttribute('aria-expanded', 'true');
		await completed.click();
		await settleMotion(target);
		await expect.element(completed).toHaveAttribute('aria-expanded', 'false');
		await rail.getByRole('button', { name: /Docs metadata/ }).click();
		await expect
			.poll(
				() => target.querySelector('[data-subagent-detail] [data-subagent-elapsed]')?.textContent
			)
			.toMatch(/Working for \d+:\d{2}/);
		await settleMotion(target);
		await expect
			.element(rail.getByRole('button', { name: 'Back to subagents', exact: true }))
			.toHaveFocus();
		expect(element(target, '[data-subagent-detail] [data-step]').textContent).toContain('Read');
		await rail.getByRole('button', { name: 'Back to subagents', exact: true }).click();
		await settleMotion(target);
		await expect
			.element(rail.getByRole('heading', { name: 'Subagents', exact: true }))
			.toBeVisible();
		await expect.element(rail.getByRole('button', { name: /Docs metadata/ })).toHaveFocus();
		await rail.getByRole('button', { name: 'Close', exact: true }).click();
		await expect.poll(() => target.querySelector('[data-agent-rail]')).toBeNull();
		await expect.element(toggle).toHaveFocus();
		await toggle.click();
		await expect.poll(() => target.querySelector('[data-agent-rail]')).not.toBeNull();
		await userEvent.keyboard('{Escape}');
		await expect.poll(() => target.querySelector('[data-agent-rail]')).toBeNull();
		await expect.element(toggle).toHaveFocus();
		if (sheet) expect(target.querySelector('[data-sheet-side="right"]')).not.toBeNull();
		await toggle.click();
		await expect.poll(() => target.querySelector('[data-agent-rail]')).not.toBeNull();
		element<HTMLButtonElement>(target, '[data-rail-close]').click();
		await tick();
		element<HTMLButtonElement>(target, '[data-rail-toggle]').click();
		await tick();
		await settleMotion(target);
		expect(target.querySelectorAll('[data-agent-rail]')).toHaveLength(1);
		await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
		await rail.getByRole('button', { name: 'Close', exact: true }).click();
		await expect.poll(() => target.querySelector('[data-agent-rail]')).toBeNull();
	});
});

it('Preview opens as a separate panel, Session stays separate, and Escape restores focus', async () => {
	await withComposer(
		false,
		async (target) => {
			await page.getByRole('button', { name: 'New preview', exact: true }).click();
			await expect
				.element(page.getByRole('complementary', { name: 'Preview', exact: true }))
				.toBeVisible();
			expect(target.querySelector('[data-agent-rail]')).toBeNull();
			await expect
				.element(page.getByRole('button', { name: 'Close preview', exact: true }))
				.toHaveFocus();
			await userEvent.keyboard('{Escape}');
			await expect.poll(() => target.querySelector('[data-agent-preview]')).toBeNull();
			await expect
				.element(page.getByRole('button', { name: 'Preview', exact: true }))
				.toHaveFocus();
			await page.getByRole('button', { name: 'Session', exact: true }).click();
			await expect
				.element(page.getByRole('complementary', { name: 'Session', exact: true }))
				.toBeVisible();
			expect(target.querySelector('[data-agent-preview]')).toBeNull();
		},
		true
	);
});


it('shows compact attachment cards with independent preview and download controls', async () => {
	await withComposer(false, async (target) => {
		const card = element(target, '[data-role="user"] [data-attachment="workspace-reference.png"]');
		const image = element<HTMLImageElement>(card, 'img');
		await expect.poll(() => image.complete && image.naturalWidth > 0).toBe(true);
		expect(image.getBoundingClientRect().height).toBeLessThanOrEqual(100);
		expect(image.getBoundingClientRect().width).toBeLessThanOrEqual(150);
		expect(card.textContent).not.toContain('Attached:');
		const download = page.getByRole('link', { name: 'Download workspace-reference.png', exact: true });
		await expect.element(download).toHaveAttribute('download', 'workspace-reference.png');
		await page.getByRole('button', { name: 'Preview workspace-reference.png', exact: true }).click();
		await expect.element(page.getByRole('dialog', { name: 'workspace-reference.png', exact: true })).toBeVisible();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('button', { name: 'Preview workspace-reference.png', exact: true })).toHaveFocus();
		const viewport = element(target, '[data-agent-transcript]');
		const steps = element(target, '[data-role="steps"] > details');
		expect(steps.getBoundingClientRect().width).toBeGreaterThan(viewport.getBoundingClientRect().width * 0.65);
		expect(steps.getBoundingClientRect().width).toBeLessThanOrEqual(1200);
	});
});
