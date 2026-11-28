/// <reference types="@vitest/browser-playwright" />
// Real-browser Chromium verification for 1D & 2D virtualization and smooth scrolling across
// Table, Board (lane + expanded grid), 2D sticky matrix (HRMS MonthBoard geometry), EventCalendar, and LogLines.
import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import Board from '../../ui/src/board/Board.svelte';
import EventCalendar from '../../ui/src/event-calendar/event-calendar.svelte';
import LogLines from '../../ui/src/logs/LogLines.svelte';
import Table from '../../ui/src/table/Table.svelte';
import type { CalendarEvent } from '../../ui/src/event-calendar/calendar.ts';
import type { LogLine } from '../../ui/src/logs/logs.ts';
import { bare_ctx } from '../../ui/tests/bare-ctx.ts';
import Harness from '../../ui/tests/view-harness.svelte';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import VirtualMatrixHarness from './support/virtual-matrix-harness.svelte';
import { required } from './support/required.ts';
import './support/shell.css';

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const twoFrames = async () => {
	await nextFrame();
	await nextFrame();
};

function visibleItemsIn(port: Element, selector: string): Element[] {
	const box = port.getBoundingClientRect();
	const out: Element[] = [];
	for (const el of port.querySelectorAll(selector)) {
		const r = el.getBoundingClientRect();
		if (r.height > 0 && r.width > 0 && r.bottom > box.top + 1 && r.top < box.bottom - 1) {
			out.push(el);
		}
	}
	return out;
}

function queryLimit(read: { readonly a: readonly unknown[] }, model: string, fallback: number): number {
	const q = read.a[0];
	if (typeof q !== 'object' || q === null || Array.isArray(q) || !(model in q)) return fallback;
	const spec = Reflect.get(q, model);
	if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return fallback;
	const limit = Reflect.get(spec, 'limit');
	return typeof limit === 'number' ? limit : fallback;
}

it('virtualizes Table smoothly across rapid scrolls and flips pages without skeleton flicker', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const catalog = {
		items: {
			record_label: 'record.title',
			label: ['title'],
			fields: {
				title: { kind: 'text' },
				code: { kind: 'text' }
			}
		}
	} satisfies Parameters<typeof scriptedBolt>[0]['catalog'];

	const makeRows = (start: number, count: number) =>
		Array.from({ length: count }, (_, i) => ({
			id: `item-${start + i}`,
			revision: 1,
			title: `Record ${start + i}`,
			code: `C-${String(start + i).padStart(4, '0')}`
		}));

	const page2Gate: { release: (() => void) | null } = { release: null };
	const fixture = await scriptedBolt({
		catalog,
		answer: async (read) => {
			if (read.m !== 'query') return { rows: [], next: null };
			const limit = queryLimit(read, 'items', 200);
			if (limit > 200) {
				await new Promise<void>((resolve) => {
					page2Gate.release = resolve;
				});
				return { items: { rows: makeRows(1, 250), next: null, total: 250 } };
			}
			return { items: { rows: makeRows(1, 200), next: 'p2', total: 250 } };
		}
	});

	const roErrors: string[] = [];
	const onWinError = (event: ErrorEvent) => {
		if (event.message.includes('ResizeObserver')) roErrors.push(event.message);
	};
	window.addEventListener('error', onWinError);

	await page.viewport(1280, 900);
	const target = document.createElement('div');
	target.style.cssText = 'height: 500px; padding: 16px; display: flex; flex-direction: column;';
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: {
			bolt: fixture.bolt,
			catalog,
			part: 'table',
			view: Table,
			props: { of: 'items', columns: ['title', 'code'], page_size: 200, toolbar: false }
		}
	});

	try {
		await expect.element(page.getByText('Record 1', { exact: true })).toBeVisible();
		const scroller = required(target.querySelector<HTMLElement>('[data-table-wide]'));
		await twoFrames();

		expect(getComputedStyle(scroller).overflowAnchor).toBe('none');
		expect(scroller.scrollHeight).toBeGreaterThan(5000);

		const beforeSpacer = () =>
			scroller.querySelector<HTMLElement>('tbody > tr[aria-hidden="true"]:first-child > td');
		expect(beforeSpacer()?.getBoundingClientRect().height ?? -1).toBe(0);

		// Rapid multi-step scroll down and back up: every frame must keep rows visible and spacer accurately sized.
		for (const y of [400, 1200, 2600, 4400, 6200, 3100, 900, 0]) {
			scroller.scrollTop = y;
			scroller.dispatchEvent(new Event('scroll'));
			await tick();
			await nextFrame();

			const renderedRows = scroller.querySelectorAll('tbody > tr:not([aria-hidden="true"])');
			expect(renderedRows.length).toBeGreaterThan(0);
			expect(renderedRows.length).toBeLessThan(80);

			const visible = visibleItemsIn(scroller, 'tbody > tr:not([aria-hidden="true"])');
			expect(visible.length).toBeGreaterThan(0);

			const spacerH = beforeSpacer()?.getBoundingClientRect().height ?? 0;
			if (y >= 1200) {
				expect(spacerH).toBeGreaterThan(200);
			}

			// Sticky header remains pinned at scrollport top.
			const theadRect = required(scroller.querySelector('thead')).getBoundingClientRect();
			const portRect = scroller.getBoundingClientRect();
			expect(Math.abs(theadRect.top - portRect.top)).toBeLessThanOrEqual(2);
		}

		// Flip to Page 2 while the response is in flight: previous rows must stay visible (no skeleton flash).
		scroller.scrollTop = 1800;
		scroller.dispatchEvent(new Event('scroll'));
		await twoFrames();

		await page.getByRole('button', { name: 'Next', exact: true }).click();
		await expect.poll(() => page2Gate.release !== null).toBe(true);
		await tick();

		expect(scroller.getAttribute('aria-busy')).toBe('true');
		expect(target.querySelector('[data-table-skeleton]')).toBeNull();
		expect(scroller.querySelectorAll('tbody > tr:not([aria-hidden="true"])').length).toBeGreaterThan(0);

		// Resolve Page 2: new page renders and scroll rewinds to top.
		page2Gate.release?.();
		await expect.element(page.getByText('Record 201', { exact: true })).toBeVisible();
		await twoFrames();
		expect(scroller.scrollTop).toBe(0);
		expect(scroller.getAttribute('aria-busy')).toBeNull();
		expect(roErrors).toEqual([]);
	} finally {
		window.removeEventListener('error', onWinError);
		await unmount(view);
		await fixture.dispose();
		await dispose();
		target.remove();
	}
});

it('virtualizes Board lane infinite scroll and expanded grid dialog smoothly in Chromium', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const catalog = {
		tasks: {
			record_label: 'record.title',
			label: ['title'],
			fields: {
				title: { kind: 'text' },
				status: { kind: 'enum', values: ['active'] }
			}
		}
	} satisfies Parameters<typeof scriptedBolt>[0]['catalog'];

	const allCards = Array.from({ length: 150 }, (_, i) => ({
		id: `t-${i + 1}`,
		revision: 1,
		title: `Task card ${i + 1}`,
		status: 'active'
	}));

	const requestedLimits: number[] = [];
	const fixture = await scriptedBolt({
		catalog,
		answer: (read) => {
			if (read.m === 'aggregate') {
				return { rows: [{ key: { status: 'active' }, count: allCards.length }], next: null };
			}
			const limit = queryLimit(read, 'tasks', 50);
			requestedLimits.push(limit);
			const slice = allCards.slice(0, limit);
			return {
				tasks: {
					rows: slice,
					next: slice.length < allCards.length ? `after-${slice.length}` : null,
					total: allCards.length
				}
			};
		}
	});

	await page.viewport(1280, 900);
	const target = document.createElement('div');
	target.style.cssText = 'height: 600px; padding: 16px; display: flex; flex-direction: column;';
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: {
			bolt: fixture.bolt,
			catalog,
			part: 'board',
			view: Board,
			props: { of: 'tasks', by: 'status', card: ['title'], page_size: 50, toolbar: false }
		}
	});

	try {
		await expect.element(page.getByText('Task card 1', { exact: true })).toBeVisible();
		const laneScroll = required(target.querySelector<HTMLElement>('[data-lane-scroll]'));
		await twoFrames();

		expect(getComputedStyle(laneScroll).overflowAnchor).toBe('none');
		expect(laneScroll.querySelectorAll('[data-board-card]').length).toBeLessThan(40);

		// Fast-scroll through the lane: prefetch should grow 50 -> 100 -> 150 while cards stay visible every step.
		for (const y of [800, 2200, 3400]) {
			laneScroll.scrollTop = y;
			laneScroll.dispatchEvent(new Event('scroll'));
			await twoFrames();
			const visible = visibleItemsIn(laneScroll, '[data-board-card]');
			expect(visible.length).toBeGreaterThan(0);
			expect(laneScroll.querySelectorAll('[data-board-card]').length).toBeLessThan(65);
		}
		await expect.poll(() => requestedLimits.some((l) => l >= 100)).toBe(true);

		// Continue scrolling deep into the prefetched range.
		laneScroll.scrollTop = 6400;
		laneScroll.dispatchEvent(new Event('scroll'));
		await twoFrames();
		expect(visibleItemsIn(laneScroll, '[data-board-card]').length).toBeGreaterThan(0);
		await expect.poll(() => requestedLimits.some((l) => l >= 150)).toBe(true);

		// Open expanded lane dialog and verify row-chunked grid virtualization (>36 cards).
		await page.getByRole('button', { name: 'Expand Active' }).click();
		const dialog = required(document.querySelector<HTMLElement>('[role="dialog"]'));
		const dialogScroll = required(dialog.querySelector<HTMLElement>('[data-lane-scroll]'));
		await expect
			.poll(() => dialogScroll.querySelectorAll('[data-board-card]').length)
			.toBeGreaterThan(0);
		await twoFrames();

		expect(getComputedStyle(dialogScroll).overflowAnchor).toBe('none');
		// Should virtualize grid rows instead of mounting all 50 cards at once.
		expect(dialogScroll.querySelectorAll('[data-board-card]').length).toBeLessThan(50);

		dialogScroll.scrollTop = 900;
		dialogScroll.dispatchEvent(new Event('scroll'));
		await twoFrames();
		expect(visibleItemsIn(dialogScroll, '[data-board-card]').length).toBeGreaterThan(0);
	} finally {
		await unmount(view);
		await fixture.dispose();
		await dispose();
		target.remove();
	}
});

it('keeps 2D sticky matrix aligned and flicker-free across rapid vertical, horizontal and diagonal scrolls', async () => {
	await page.viewport(1280, 900);
	const target = document.createElement('div');
	target.style.cssText = 'padding: 16px;';
	document.body.replaceChildren(target);
	const view = mount(VirtualMatrixHarness, { target, props: { rowCount: 120, colCount: 31 } });

	try {
		await twoFrames();
		const port = required(target.querySelector<HTMLElement>('[data-matrix-port]'));
		expect(getComputedStyle(port).overflowAnchor).toBe('none');

		// Verify scroll extents match 120 rows × 61px + 40px header and 160px + 31 × 72px columns.
		expect(port.scrollHeight).toBeGreaterThan(7000);
		expect(port.scrollWidth).toBeGreaterThan(2300);

		const sweeps: readonly (readonly [number, number])[] = [
			[0, 0],
			[1200, 0],
			[1200, 600],
			[3600, 1200],
			[6000, 1600],
			[2400, 400],
			[0, 0]
		];

		for (const [y, x] of sweeps) {
			port.scrollTop = y;
			port.scrollLeft = x;
			port.dispatchEvent(new Event('scroll'));
			await tick();
			await nextFrame();

			const rows = port.querySelectorAll<HTMLElement>('[data-matrix-row]');
			const cols = port.querySelectorAll<HTMLElement>('[data-matrix-col]');
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.length).toBeLessThan(48);
			expect(cols.length).toBeGreaterThan(0);
			expect(cols.length).toBeLessThan(31);
			if (y === 0 && x === 0) {
				expect(rows.length).toBeLessThanOrEqual(24);
				expect(cols.length).toBeLessThanOrEqual(20);
			}

			const visibleRows = visibleItemsIn(port, '[data-matrix-row]');
			expect(visibleRows.length).toBeGreaterThan(0);

			// Spacer row grows to push rows down accurately (never locked at 0px).
			const rowSpacer = required(port.querySelector<HTMLElement>('[data-row-spacer-before] > td'));
			if (y >= 1200) {
				expect(rowSpacer.getBoundingClientRect().height).toBeGreaterThan(400);
			} else if (y === 0) {
				expect(rowSpacer.getBoundingClientRect().height).toBe(0);
			}

			// Sticky corner, top headers, and left column stay pinned to viewport edges.
			const portRect = port.getBoundingClientRect();
			const cornerRect = required(port.querySelector('[data-matrix-corner]')).getBoundingClientRect();
			expect(Math.abs(cornerRect.top - portRect.top)).toBeLessThanOrEqual(2);
			expect(Math.abs(cornerRect.left - portRect.left)).toBeLessThanOrEqual(2);

			const sampleRow = required(visibleRows[0]);
			const personRect = required(sampleRow.querySelector('[data-matrix-person]')).getBoundingClientRect();
			expect(Math.abs(personRect.left - portRect.left)).toBeLessThanOrEqual(2);

			// Every visible day header aligns 1:1 with its body cell and preserves its exact 72px width.
			for (const th of cols) {
				const date = th.dataset['matrixCol'];
				if (date === undefined) continue;
				const td = required(sampleRow.querySelector<HTMLElement>(`[data-cell-date="${date}"]`));
				const thRect = th.getBoundingClientRect();
				const tdRect = td.getBoundingClientRect();
				expect(Math.abs(thRect.top - portRect.top)).toBeLessThanOrEqual(2);
				expect(Math.abs(thRect.width - 72)).toBeLessThanOrEqual(1.5);
				expect(Math.abs(thRect.left - tdRect.left)).toBeLessThanOrEqual(1);
				expect(Math.abs(thRect.width - tdRect.width)).toBeLessThanOrEqual(1);
			}
		}

		// After the velocity settle window, directional overscan decays back to base overscan.
		port.scrollLeft = 600;
		port.dispatchEvent(new Event('scroll'));
		await expect.poll(() => port.querySelectorAll('[data-matrix-col]').length).toBeLessThanOrEqual(20);
	} finally {
		await unmount(view);
		target.remove();
	}
});

it('preserves EventCalendar scroll position and virtualizes 2,000 LogLines smoothly in Chromium', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const ctx = bare_ctx({ locale: 'en' });
	await page.viewport(1280, 900);

	// 1. EventCalendar week scroll stability + compact month agenda virtualization.
	const calTarget = document.createElement('div');
	calTarget.style.cssText = 'height: 500px; width: 900px;';
	document.body.replaceChildren(calTarget);
	const baseDate = new Date(2026, 2, 18, 9, 0, 0);
	const events: CalendarEvent[] = Array.from({ length: 60 }, (_, i) => ({
		id: `ev-${i}`,
		title: `Meeting ${i}`,
		start: new Date(2026, 2, 18, 8 + (i % 10), (i % 4) * 15),
		end: new Date(2026, 2, 18, 8 + (i % 10), (i % 4) * 15 + 30)
	}));
	const calView = mount(EventCalendar, {
		target: calTarget,
		props: { ctx, events, view: 'week', date: baseDate }
	});

	try {
		await twoFrames();
		const scroller = required(calTarget.querySelector<HTMLElement>('[data-calendar-scroll]'));
		expect(getComputedStyle(scroller).overflowAnchor).toBe('none');
		scroller.scrollTop = 640;
		await twoFrames();
		expect(scroller.scrollTop).toBe(640);
	} finally {
		await unmount(calView);
		calTarget.remove();
	}

	// 2. LogLines with 2,000 rows: O(1) fixed-size translateY virtualization.
	const logTarget = document.createElement('div');
	logTarget.style.cssText = 'height: 400px; width: 900px; display: flex; flex-direction: column;';
	document.body.replaceChildren(logTarget);
	const logs: LogLine[] = Array.from({ length: 2000 }, (_, i) => ({
		id: `log-${i}`,
		at: Date.UTC(2026, 2, 18, 10, 0, i),
		level: i % 10 === 0 ? 'warn' : 'info',
		source: 'worker',
		message: `Processed job #${i} cleanly`
	}));
	const logView = mount(LogLines, {
		target: logTarget,
		props: { ctx, rows: logs, follow: false }
	});

	try {
		await twoFrames();
		const logPort = required(logTarget.querySelector<HTMLElement>('[data-log-view]'));
		expect(getComputedStyle(logPort).overflowAnchor).toBe('none');
		expect(logPort.scrollHeight).toBeGreaterThan(40000);

		for (const y of [0, 8000, 22000, 38000, 14000, 0]) {
			logPort.scrollTop = y;
			logPort.dispatchEvent(new Event('scroll'));
			await tick();
			await nextFrame();

			const rendered = logPort.querySelectorAll('[data-log-level]');
			expect(rendered.length).toBeGreaterThan(0);
			expect(rendered.length).toBeLessThan(80);
			expect(visibleItemsIn(logPort, '[data-log-level]').length).toBeGreaterThan(0);
		}
	} finally {
		await unmount(logView);
		await dispose();
		logTarget.remove();
	}
});
