/// <reference types="@vitest/browser-playwright" />
// Real-browser performance budgets in headless Chromium:
// 1. Cold Shell mount stays under budget and defers heavy panels and non-visited route chunks.
// 2. Navigating away and revisiting a warm route renders from the live cache with zero `/__bolt/q`
//    refetches and zero redundant `/__bolt/live` view registrations.
// 3. A rapid burst of 50 live SSE delta frames patches DOM in place with zero fallback reads and
//    stays under the burst paint budget.
import { afterEach, beforeEach, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { sha256_hex } from '@norbital-ai/store/hash';
import { page } from 'vitest/browser';
import { mount_shell, type ShellMountConfig } from '../src/shell/mount.ts';
import type { EventSourceLike } from '../src/page/stream.ts';
import type { Json } from '../src/decl/values.ts';
import { PATHS, type Frame } from '../src/protocol/wire.ts';
import { LiveBody } from '../src/protocol/schema.ts';
import { SHELL, type ShellBoot } from '../src/shell/nav.ts';
import PerfOrdersPage from './support/perf-orders-page.svelte';
import PerfCustomersPage from './support/perf-customers-page.svelte';
import './support/shell.css';

const COLD_MOUNT_BUDGET_MS = 2500;
const DELTA_BURST_BUDGET_MS = 1500;

const INITIAL_ORDERS = {
	orders: {
		rows: [{ id: '0199a000-0000-7000-8000-000000000001', title: 'Order #1', amount: 100 }],
		next: null,
		total: 1
	}
};

const manifest: ShellMountConfig['manifest'] = {
	workspace: { locale: 'en', tz: 'UTC', landing: { app: 'sales' } },
	apps: {
		sales: {
			title: 'Sales',
			description: 'Sales workspace',
			icon: 'lucide:briefcase',
			pages: {
				orders: { title: 'Orders', icon: 'lucide:list' },
				customers: { title: 'Customers', icon: 'lucide:users' }
			}
		}
	}
};

const boot: ShellBoot = {
	workspace: { name: 'Perf Fixture', locale: 'en', tz: 'UTC' },
	actor: {
		kind: 'member',
		id: 'u1',
		email: 'ada@example.test',
		phone: null,
		external: false,
		teams: [],
		team_path: [],
		admin: true,
		party: null
	},
	name: 'Ada',
	admin: true,
	preview: null,
	nav: [
		{
			kind: 'app',
			name: 'sales',
			title: 'Sales',
			description: 'Sales workspace',
			icon: 'lucide:briefcase',
			href: '/app/sales/orders',
			pages: [
				{ name: 'orders', title: 'Orders', icon: 'lucide:list', href: '/app/sales/orders' },
				{
					name: 'customers',
					title: 'Customers',
					icon: 'lucide:users',
					href: '/app/sales/customers'
				}
			]
		}
	],
	inbox: 0,
	kiosks: [],
	startable: [],
	envoys: {},
	search: [],
	contract: 'perf-fixture',
	push: null,
	visitor: null,
	automations: {},
	read_catalog: {
		orders: {
			default: {
				orders: {
					model: 'orders',
					many: true,
					list_fields: ['id', 'title', 'amount'],
					fields: {
						id: { kind: 'text' },
						title: { kind: 'text' },
						amount: { kind: 'int' }
					}
				}
			}
		}
	},
	operation_outputs: { automations: {} },
	surfaces: { inbox: true, runs: true, settings: true, agent: true, studio: true },
	catalog: {
		orders: {
			record_label: 'record.title',
			label: ['title'],
			fields: { id: { kind: 'text' }, title: { kind: 'text' }, amount: { kind: 'int' } }
		}
	}
};

let cleanup: (() => Promise<void>) | undefined;
let initialUrl = '';

beforeEach(async () => {
	initialUrl = `${location.pathname}${location.search}${location.hash}`;
	history.replaceState(null, '', '/app/sales/orders');
	await page.viewport(1280, 800);
});

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	history.replaceState(null, '', initialUrl);
});

function createHarness() {
	let stream: EventSourceLike | null = null;
	let version = 1;
	let qCalls = 0;
	let ordersAdds = 0;
	let fullAnswers = 0;
	let sameAnswers = 0;
	let activeOrdersView: string | null = null;
	const loads = { orders: 0, customers: 0 };

	const push = (frame: Frame) => {
		stream?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
	};

	const answerFor = (read: { readonly m: string; readonly a: readonly unknown[] }): Json => {
		if (read.m === 'inbox') return { rows: [], unread: 0 };
		if (read.m !== 'query') return { rows: [], next: null };
		const first = read.a[0];
		if (typeof first !== 'object' || first === null || Array.isArray(first)) return {};
		if ('orders' in first) return INITIAL_ORDERS;
		const out: Record<string, Json> = {};
		for (const [key, spec] of Object.entries(first)) {
			if (typeof spec === 'object' && spec !== null && 'aggregate' in spec) {
				out[key] = { count: 0 };
			} else if (typeof spec === 'object' && spec !== null && 'id' in spec) {
				out[key] = null;
			} else {
				out[key] = { rows: [], next: null };
			}
		}
		return out;
	};
	const isOrdersRead = (read: { readonly m: string; readonly a: readonly unknown[] }) =>
		read.m === 'query' &&
		typeof read.a[0] === 'object' &&
		read.a[0] !== null &&
		!Array.isArray(read.a[0]) &&
		'orders' in read.a[0];

	const fetchMock: typeof fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const pathname = new URL(url, location.origin).pathname;
		if (pathname === SHELL) return Response.json({ value: boot });
		if (pathname === PATHS.q) {
			qCalls++;
			return Response.json({ answers: [INITIAL_ORDERS] });
		}
		if (pathname === PATHS.live) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(LiveBody))(
				await new Response(init?.body).text()
			);
			for (const entry of body.add ?? []) {
				const isOrders = isOrdersRead(entry.read);
				const payload = answerFor(entry.read);
				const payloadHash = sha256_hex(JSON.stringify(payload));
				if (isOrders) {
					activeOrdersView = entry.view;
					ordersAdds++;
				}
				if (entry.known === payloadHash) {
					if (isOrders) sameAnswers++;
					queueMicrotask(() => push({ t: 'same', view: entry.view, v: ++version, known: payloadHash }));
				} else {
					if (isOrders) fullAnswers++;
					queueMicrotask(() => push({ t: 'answer', view: entry.view, v: ++version, value: payload }));
				}
			}
			return Response.json({ errors: [] });
		}
		return Response.json({ value: null });
	};

	const target = document.createElement('div');
	document.body.replaceChildren(target);

	const start = performance.now();
	const unmountShell = mount_shell(target, {
		manifest,
		fetch: fetchMock,
		open_stream: () => {
			let handler: ((event: MessageEvent<string>) => void) | null = null;
			let greeted = false;
			const source: EventSourceLike = {
				get onmessage() {
					return handler;
				},
				set onmessage(fn) {
					handler = fn;
					if (fn !== null && !greeted) {
						greeted = true;
						queueMicrotask(() => push({ t: 'hello', conn: 'perf-conn', v: version }));
					}
				},
				onerror: null,
				close: () => {
					if (stream === source) stream = null;
				}
			};
			stream = source;
			return source;
		},
		pages: {
			'sales/orders': async () => {
				loads.orders++;
				return { default: PerfOrdersPage };
			},
			'sales/customers': async () => {
				loads.customers++;
				return { default: PerfCustomersPage };
			}
		}
	});

	cleanup = async () => {
		await unmountShell();
		target.remove();
	};

	return {
		target,
		start,
		loads,
		push,
		nextVersion: () => ++version,
		activeOrdersView: () => activeOrdersView,
		metrics: () => ({ qCalls, ordersAdds, fullAnswers, sameAnswers })
	};
}

it('mounts the cold shell within budget and defers lazy panels and unvisited route chunks', async () => {
	const h = createHarness();
	await expect.element(page.getByTestId('orders-count')).toHaveTextContent('1');
	const mountMs = performance.now() - h.start;

	expect(mountMs).toBeLessThan(COLD_MOUNT_BUDGET_MS);
	expect(h.loads).toEqual({ orders: 1, customers: 0 });
	expect(h.metrics().qCalls).toBe(0);
	expect(h.metrics().fullAnswers).toBe(1);
	// Heavy panels (Agent rail, Finder dialog, Studio slot, Settings/Inbox) stay unmounted on cold boot.
	expect(h.target.querySelector('[data-testid="agent-rail"]')).toBeNull();
	expect(h.target.querySelector('[data-testid="studio-slot"]')).toBeNull();
	expect(h.target.querySelector('[role="dialog"]')).toBeNull();
});

it('revisits a warm route with zero /__bolt/q refetches and zero redundant view registrations', async () => {
	const h = createHarness();
	await expect.element(page.getByTestId('orders-count')).toHaveTextContent('1');
	expect(h.metrics()).toEqual({ qCalls: 0, ordersAdds: 1, fullAnswers: 1, sameAnswers: 0 });

	await page.getByRole('link', { name: 'Customers', exact: true }).click();
	await expect.element(page.getByTestId('perf-customers-page')).toBeVisible();
	expect(h.loads).toEqual({ orders: 1, customers: 1 });

	const revisitStart = performance.now();
	await page.getByRole('link', { name: 'Orders', exact: true }).click();
	await expect.element(page.getByTestId('orders-count')).toHaveTextContent('1');
	expect(performance.now() - revisitStart).toBeLessThan(500);
	expect(h.metrics().qCalls).toBe(0);
	expect(h.metrics().ordersAdds).toBe(1);
	expect(h.metrics().fullAnswers).toBe(1);
});

it('applies a 50-frame live SSE delta burst in place within budget and with zero fallback reads', async () => {
	const h = createHarness();
	await expect.element(page.getByTestId('orders-count')).toHaveTextContent('1');
	const view = h.activeOrdersView();
	expect(view).not.toBeNull();
	if (view === null) return;

	const burstStart = performance.now();
	for (let i = 2; i <= 51; i++) {
		h.push({
			t: 'delta',
			view,
			v: h.nextVersion(),
			ops: [
				{
					op: 'upsert',
					path: ['orders'],
					index: i - 1,
					row: {
						id: `0199a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
						title: `Order #${i}`,
						amount: i * 100
					}
				}
			]
		});
	}

	await expect.element(page.getByTestId('orders-count')).toHaveTextContent('51');
	await expect.element(page.getByTestId('orders-latest')).toHaveTextContent('Order #51');
	const burstMs = performance.now() - burstStart;

	expect(burstMs).toBeLessThan(DELTA_BURST_BUDGET_MS);
	expect(h.metrics().qCalls).toBe(0);
	expect(h.metrics().fullAnswers).toBe(1);
});
