// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { it as effect_it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime, Queue, Schema, Stream } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { register_control } from '@norbital-ai/ui/behaviors';
import { create_bolt, page_live_mode } from '../src/page/bolt.ts';
import type { PageSnapshotHost } from '../src/page/index.ts';
import {
	clientPageAction,
	fillField,
	pageClickable,
	pageField,
	pageFieldLabel,
	pageLabel,
	pageMark,
	pageScreen
} from '../src/shell/agent/page.ts';

describe('the current-tab page bridge', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		Object.defineProperty(HTMLElement.prototype, 'getClientRects', {
			configurable: true,
			value: () => ({ length: 1 })
		});
	});
	it('finds a board card, a button and a same-page link by visible text, never the shell chrome', () => {
		document.body.innerHTML = `<main>
			<div data-board-card="p1">GREY_RUBBER_0001</div>
			<button>Delete</button>
			<a href="/app/x">Open project</a>
		</main><button>Outside</button>`;
		expect(pageClickable('GREY_RUBBER_0001')?.getAttribute('data-board-card')).toBe('p1');
		expect(pageClickable('delete')?.tagName).toBe('BUTTON');
		expect(pageClickable('open project')?.getAttribute('href')).toBe('/app/x');
		expect(pageClickable('outside')).toBeNull();
	});
	it('never reaches an approval decision, in a panel or a held card', () => {
		document.body.innerHTML = `<main>
			<button>Save</button>
			<div data-view="approval">
				<button>Approve</button>
				<button>Reject</button>
				<label>Reason <input aria-label="Reason" /></label>
			</div>
			<div data-approval="held"><button>Request changes</button></div>
		</main>`;
		expect(pageClickable('save')?.textContent).toBe('Save');
		expect(pageClickable('Approve')).toBeNull();
		expect(pageClickable('Reject')).toBeNull();
		expect(pageClickable('Request changes')).toBeNull();
		expect(pageField('Reason')).toBeNull();
	});
	it('shows the control and field a person would read, in their own case', () => {
		document.body.innerHTML = `<main>
			<button aria-label="Delete project">Delete</button>
			<label>Customer reference / S/no <input aria-label="Customer reference / S/no" /></label>
		</main>`;
		const control = pageClickable('delete');
		const field = pageField('Customer reference / S/no');
		if (control === null || field === null) throw new Error('the control or field is missing');
		expect(pageLabel(control)).toBe('Delete project');
		expect(pageFieldLabel(field)).toBe('Customer reference / S/no');
	});
	it('finds a field in a page sheet, and never in the Norbius panel', () => {
		document.body.innerHTML = `<main></main>
			<div role="dialog" aria-label="New project">
				<label>Customer reference / S/no <input aria-label="Customer reference / S/no" /></label>
			</div>
			<div role="dialog" aria-label="Norbius"><input aria-label="Composer" /></div>`;
		expect(pageField('Customer reference / S/no')).not.toBeNull();
		expect(pageField('Composer')).toBeNull();
	});
	it('fills a visible text field with native events and never a password or file field', () => {
		document.body.innerHTML = `<main>
			<label>Colour code <input aria-label="Colour code" /></label>
			<input type="password" aria-label="Password" />
			<input type="file" aria-label="Attachment" />
		</main>`;
		const field = pageField('Colour code');
		if (field === null || !(field instanceof HTMLInputElement))
			throw new Error('the colour field is missing');
		expect(pageField('Password')).toBeNull();
		expect(pageField('Attachment')).toBeNull();
		const events: string[] = [];
		field.addEventListener('input', () => events.push('input'));
		field.addEventListener('change', () => events.push('change'));
		fillField(field, 'GREY-42', false);
		expect(field.value).toBe('GREY-42');
		expect(events).toEqual(['input', 'change']);
	});
	it('includes registered UI control states in pageScreen for Norbius', () => {
		document.body.innerHTML = `<main><h1>Settings</h1></main>`;
		const stop = register_control({
			id: 'tabs:settings',
			kind: 'tabs',
			label: 'Settings tabs',
			state: () => ({ active: 'change_log', items: ['general', 'change_log'] })
		});
		try {
			expect(pageScreen()).toContain('Settings');
			expect(pageScreen()).toContain('tabs:Settings tabs(active=change_log items=[general,change_log])');
		} finally {
			stop();
		}
		expect(pageScreen()).not.toContain('tabs:Settings tabs');
	});
	it('respects data-agent-hidden on clickable controls, fields, marks and screen summaries', () => {
		document.body.innerHTML = `<main>
			<h1>Visible Title</h1>
			<h2 data-agent-hidden>Hidden Heading</h2>
			<button>Public Action</button>
			<button data-agent-hidden>Secret Debug</button>
			<div data-agent-hidden><label>Internal Note <input aria-label="Internal Note" /></label></div>
		</main>`;
		expect(pageClickable('Public Action')).not.toBeNull();
		expect(pageClickable('Secret Debug')).toBeNull();
		expect(pageField('Internal Note')).toBeNull();
		expect(pageMark('Hidden Heading')).toBeNull();
		expect(pageScreen()).toContain('Visible Title');
		expect(pageScreen()).not.toContain('Hidden Heading');
		expect(pageScreen()).not.toContain('Secret Debug');
	});
	it('drives registered UI controls via action.control while refusing approval-scoped controls', async () => {
		document.body.innerHTML = `<main>
			<div id="ctrl-host"></div>
			<div data-view="approval"><div id="approval-host"></div></div>
		</main>`;
		const hostEl = document.getElementById('ctrl-host');
		const approvalEl = document.getElementById('approval-host');
		let opened = false;
		const stopA = register_control({
			id: 'panel:inspector',
			kind: 'disclosure',
			label: 'Inspector panel',
			element: () => hostEl,
			state: () => ({ open: opened }),
			actions: {
				open: () => {
					opened = true;
				}
			}
		});
		const stopB = register_control({
			id: 'approval:decision',
			kind: 'button',
			label: 'Approve decision',
			element: () => approvalEl,
			state: () => ({}),
			actions: {
				open: () => {
					opened = false;
				}
			}
		});
		const reported: Array<{ step: string; ok: boolean; note?: string }> = [];
		const done = Promise.withResolvers<void>();
		const bridge = clientPageAction({
			api: {
				claim_page_action: () =>
					Effect.succeed({ kind: 'committed' as const, output: { claimed: true }, records: [] }),
				page_result: (step, result) =>
					Effect.sync(() => {
						reported.push({ step, ok: result.ok, ...(result.note !== undefined ? { note: result.note } : {}) });
						if (reported.length === 3) done.resolve();
						return { kind: 'committed' as const, output: null, records: [] };
					})
			},
			eligible: () => true,
			navigate: () => {},
			open_external: () => {},
			closePanel: () => {},
			t: (key) => key
		});
		const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
		try {
			bridge.run({ control: { ref: 'Inspector panel', action: 'open' } }, 'c1', 'step-1');
			bridge.run({ control: { ref: 'Approve decision', action: 'open' } }, 'c1', 'step-2');
			bridge.run({ control: { ref: 'Missing control', action: 'open' } }, 'c1', 'step-3');
			await done.promise;
			expect(opened).toBe(true);
			expect(reported.find((r) => r.step === 'step-1')?.ok).toBe(true);
			expect(reported.find((r) => r.step === 'step-2')?.ok).toBe(false);
			expect(reported.find((r) => r.step === 'step-3')?.ok).toBe(false);
		} finally {
			stopA();
			stopB();
			await dispose();
		}
	});
});

effect_it.effect('a fleet snapshot exposes an awaited refresh bridge and removes it on teardown', () =>
	Effect.gen(function* () {
		yield* Effect.acquireRelease(
			Effect.sync(() => mount_edge(ManagedRuntime.make(Layer.empty))),
			(dispose) => Effect.promise(dispose)
		);
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				const previous = Object.getOwnPropertyDescriptor(window, 'bolt_live_mode');
				Object.defineProperty(window, 'bolt_live_mode', { configurable: true, value: 'snapshot' });
				return previous;
			}),
			(previous) => Effect.sync(() => {
				if (previous === undefined) Reflect.deleteProperty(window, 'bolt_live_mode');
				else Object.defineProperty(window, 'bolt_live_mode', previous);
			})
		);
		expect(page_live_mode()).toBe('snapshot');
		const host: PageSnapshotHost = window;
		expect(host.bolt_live_mode).toBe('snapshot');
		let count = 1;
		const seen: number[] = [];
		yield* Effect.scoped(Effect.gen(function* () {
			const delivered = yield* Queue.unbounded<number>();
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				policies: [],
				locale: 'en',
				base: 'https://workspace.test',
				fetch: async () => Response.json({ answers: [{ jobs: { count } }] }),
				open_stream: () => { throw new Error('A fleet snapshot must not open a live stream.'); }
			});
			yield* bolt.observe(
				{ read: { m: 'query', a: [{ jobs: { aggregate: { count: true } } }] } },
				Schema.Struct({ jobs: Schema.Struct({ count: Schema.Number }) })
			).pipe(
				Stream.runForEach((answer) => Effect.sync(() => { seen.push(answer.jobs.count); }).pipe(Effect.andThen(Queue.offer(delivered, answer.jobs.count)))),
				Effect.forkScoped
			);
			expect(yield* Queue.take(delivered)).toBe(1);
			const bridge = host.bolt_refresh;
			if (bridge === undefined) throw new Error('The fleet refresh bridge is missing.');
			expect(Object.getOwnPropertyDescriptor(window, 'bolt_refresh')).toMatchObject({
				value: bridge, configurable: true, writable: false
			});
			count = 2;
			const refreshed = bridge();
			expect(refreshed).toBeInstanceOf(Promise);
			yield* Effect.promise(() => refreshed);
			expect(seen).toEqual([1, 2]);
		}));
		expect(host.bolt_refresh).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(window, 'bolt_refresh')).toBeUndefined();
	})
);
