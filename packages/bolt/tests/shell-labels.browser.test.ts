// The command center and approvals name automations, run states and causes, audit operations and record kinds in
// words from the manifest and catalog, never by their handles.
import { afterEach, beforeEach, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import ShellView from './support/shell-view.svelte';
import type { AuditSummary } from '../src/protocol/audit.ts';
import type { Json } from '../src/decl/values.ts';
import { shell_api, shell_bolt } from '../src/shell/runtime.ts';
import './support/shell.css';

const nativeApi = shell_api(async () => Response.json({ value: [] }));
/** The workspace catalog: the shell's `t` and the page client both read it. */
const MESSAGES: Readonly<Record<string, string>> = {
	'models.orders.label': 'Sales orders',
	'models.orders.singular': 'Sales order'
};
const t = (key: string) => MESSAGES[key] ?? key;
let close: (() => Promise<void>) | undefined;
beforeEach(async () => {
	Object.defineProperty(window, 'bolt_live_mode', { value: 'snapshot', configurable: true });
	// the views' tables, not their phone cards
	await page.viewport(1200, 900);
});
afterEach(async () => {
	await close?.();
	close = undefined;
	Reflect.deleteProperty(window, 'bolt_live_mode');
});

/** Mounts one shell view whose every read answers `answer`. */
async function show(
	view: 'runs' | 'audit' | 'inbox',
	answer: Json,
	api: Partial<Pick<typeof nativeApi, 'audit' | 'settings'>> = {}
) {
	const runtime = ManagedRuntime.make(Layer.empty),
		dispose = mount_edge(runtime);
	const scope = Effect.runSync(Scope.make());
	const bolt = await runtime.runPromise(
		shell_bolt(
			{
				workspace: { name: 'Fixture', locale: 'en', tz: 'UTC' },
				actor: null,
				name: null,
				admin: true,
				preview: null,
				nav: [],
				inbox: 0,
				kiosks: [],
				push: null,
				visitor: null,
				automations: {},
				read_catalog: {},
				operation_outputs: { automations: {} },
				surfaces: { inbox: true, runs: true, settings: true, agent: false, studio: false },
				catalog: {
					orders: { record_label: 'record.id', label: ['id'], fields: { id: { kind: 'text' } } }
				}
			},
			{
				messages: MESSAGES,
				fetch: async () => Response.json({ answers: [answer] }),
				open_stream: () => ({ onmessage: null, onerror: null, close() {} })
			}
		).pipe(Effect.provideService(Scope.Scope, scope))
	);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const mounted = mount(ShellView, {
		target,
		props: { api: { ...nativeApi, ...api }, bolt, t, view }
	});
	close = async () => {
		await unmount(mounted);
		await runtime.runPromise(Scope.close(scope, Exit.void));
		await dispose();
		target.remove();
	};
	return target;
}
const cells = (target: HTMLElement) =>
	[...target.querySelectorAll('tbody td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim() ?? '');

it('the queue names an automation, its state and its cause in words', async () => {
	const target = await show('runs', {
		rows: [
			{
				id: 'run-1',
				automation: 'source_health',
				cause: 'cron',
				trigger: { kind: 'system', cause: 'cron' },
				status: 'succeeded',
				due_at: '2026-11-13T00:00:00Z',
				started: '2026-11-13T00:00:01Z',
				progress: null,
				error: null,
				attempt_count: 1
			}
		],
		next: null
	});
	await expect.element(page.getByText('Source health', { exact: true }).first()).toBeVisible();
	const shown = cells(target);
	expect(shown).toContain('Succeeded');
	expect(shown).toContain('Cron');
	expect(shown).toContain('System · Cron');
	for (const raw of ['source_health', 'succeeded', 'cron']) expect(shown).not.toContain(raw);
});

it('an audited write is named after its writes, in the catalog’s words', async () => {
	const event = (id: string, more: Partial<AuditSummary>): AuditSummary => ({
		id,
		operation_id: 'op-1',
		at: '2026-11-13T00:00:00Z',
		category: 'write',
		action: 'orders.update',
		status: 'committed',
		actor: { kind: 'member', id: 'u1', label: 'Ada' },
		subject: null,
		invocation: null,
		transaction: null,
		run: null,
		approval: null,
		recorded_at: '2026-11-13T00:00:00Z',
		payload_bytes: 0,
		...more
	});
	const target = await show(
		'audit',
		{},
		{
			settings: () => Effect.never,
			audit: () =>
				Effect.succeed({
					rows: [
						event('e1', {}),
						event('e2', { subject: { model: 'orders', id: 'o1', revision: 2 } }),
						event('e3', { action: 'orders.update, lines.create' })
					],
					next: null
				})
		}
	);
	await expect.element(page.getByText('Updated Sales orders', { exact: true }).first()).toBeVisible();
	const rows = [...target.querySelectorAll('tbody tr')].map(
		(row) => row.textContent?.replace(/\s+/g, ' ') ?? ''
	);
	expect(rows.some((row) => row.includes('orders.update'))).toBe(false);
	await expect
		.element(page.getByText('Updated Sales orders, Created Lines', { exact: true }).first())
		.toBeVisible();
	expect(rows.every((row) => row.includes('Sales orders'))).toBe(true);
	// the Who column names the person from the event's label while the directory has not answered
	expect(rows.every((row) => row.includes('Ada'))).toBe(true);
});

it('the approvals table heads its record kind in words and shows the model’s label', async () => {
	const target = await show('inbox', {
		rows: [],
		unread: 0,
		requests: [
			{
				id: 'r1',
				model: 'orders',
				record: 'o1',
				action: 'update',
				requestor: 'member:u1',
				step: 0,
				at: '2026-11-13T00:00:00Z',
				by: 'Ada',
				label: 'TR-1',
				status: 'Pending',
				steps: [{ name: 'Commercial review', teams: ['commercial_managers'], users: [] }],
				mine: false,
				canDecide: true,
				canSupersede: false,
				moves: []
			}
		]
	});
	await expect.element(page.getByText('TR-1', { exact: true }).first()).toBeVisible();
	const heads = [...target.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
	expect(heads).not.toContain('Model');
	expect(heads).toContain('Record type');
	expect(cells(target)).toContain('Sales orders');
});
