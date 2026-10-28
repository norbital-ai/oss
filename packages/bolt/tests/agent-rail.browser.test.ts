/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import Agent from '../src/shell/agent/Agent.svelte';
import { createBolt } from '../src/page/bolt.ts';
import { QBody, type AgentConversation, type AgentRow } from '../src/protocol/schema.ts';
import { shellApi } from '../src/shell/runtime.ts';
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
const fixture = () => {
	const at = new Date(Date.now() - 178_000).toISOString();
	const conversation: AgentConversation = {
		id: 'rail-root',
		title: 'Workspace migration',
		at,
		status: 'idle',
		model: 'default',
		plan: null,
		goals: null,
		envoy: null,
		integration: null,
		kind: null,
		thread: null,
		peer: null
	};
	const children = taskNames.map((name, index) => {
		const id = `rail-child-${index}`;
		const rows: AgentRow[] = [{ ...row(`${id}-task`, 1, name), at }];
		if (index < 3)
			rows.push({
				...row(`${id}-step`, 2, ''),
				role: 'tool',
				at,
				tool: { name: 'read', failed: false, args: '{"documents":{}}', ms: 200 }
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
	const rows: AgentRow[] = [row('rail-prompt', 1, 'Coordinate the workspace migration.')];
	for (const [index, child] of children.entries())
		rows.push({
			...row(`spawn-${index}`, index + 2, ''),
			role: 'tool',
			at,
			tool: {
				name: 'subagent',
				failed: false,
				child: child.id,
				ms: 20,
				args: JSON.stringify({ action: 'spawn', task: taskNames[index] })
			}
		});
	for (const [index, args] of [
		{ action: 'message', conversation: 'rail-child-0', text: 'Please include permissions.' },
		{ action: 'stop', conversation: 'rail-child-5' }
	].entries())
		rows.push({
			...row(`subagent-action-${index}`, index + 10, ''),
			role: 'tool',
			at,
			tool: { name: 'subagent', failed: false, ms: 20, args: JSON.stringify(args) }
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
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).pathname.endsWith('/models'))
			return Response.json({
				value: { models: [{ id: 'default', label: 'Default' }], default: 'default', mcp: [] }
			});
		const { reads } = Schema.decodeUnknownSync(QBody)(await request.json());
		const read = reads[0];
		if (read?.m === 'conversations') return Response.json({ answers: [{ rows: [conversation] }] });
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
		return Response.json({ answers: [child] });
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
const withComposer = async (sheet: boolean, check: (target: HTMLElement) => Promise<void>) => {
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
	const dispose = mountEdge(runtime);
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fetch = fixture();
					const client = yield* createBolt({
						actor: null,
						locale: 'en',
						base: location.origin,
						fetch,
						poll: '1 hour'
					});
					const bolt: typeof client = {
						...client,
						fileUrl: (file, options) => imageFixtures.get(file.id) ?? client.fileUrl(file, options)
					};
					yield* Effect.promise(async () => {
						const props = { api: shellApi(fetch, { base: location.origin }), bolt };
						const view = sheet
							? mount(AgentSheet, { target, props })
							: mount(Agent, {
									target,
									props: {
										...props,
										t: (key: string) => key,
										request: { conversation: 'rail-root' },
										onClose: () => {}
									}
								});
						try {
							await expect
								.element(page.getByRole('textbox', { name: 'Message', exact: true }))
								.toBeVisible();
							await expect
								.poll(() => target.querySelectorAll('[data-step][data-tool="subagent"]').length)
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
