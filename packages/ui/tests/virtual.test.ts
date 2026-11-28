import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { vi } from 'vitest';
import {
	directionalOverscan,
	fixedWindowOf,
	offsets,
	SizeTree,
	treeWindowOf,
	windowOf
} from '../src/primitives/virtual/virtual.ts';
import type { VirtualRange } from '../src/primitives/virtual/virtual.svelte.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Values } from '../src/model/types.ts';
import type { LocalLane } from '../src/board/LocalBoard.svelte';
import type { Value } from '@norbital-ai/store/kind';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '../src/effect/index.ts';
import { bare_ctx } from './bare-ctx.ts';
import { browser, required, viewFixture } from './view-fixture.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: VirtualHarness } = await import('./virtual-harness.svelte');
const { default: VirtualGridHarness } = await import('./virtual-grid-harness.svelte');
const { default: ViewHarness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const { default: Board } = await import('../src/board/Board.svelte');
const { default: LocalBoard } = await import('../src/board/LocalBoard.svelte');
const { createRawSnippet } = await import('svelte');

it('SizeTree matches prefix offsets across point updates and binary-lifted lookups', () => {
	const heights = [20, 60, 35, 40, 120, 25, 50, 30];
	const tree = new SizeTree();
	tree.rebuild(heights.length, (i) => heights[i] ?? 0);

	const checkAll = () => {
		const expected = offsets(heights);
		assert.equal(tree.total, expected.at(-1));
		for (let i = 0; i <= heights.length; i++) {
			assert.equal(tree.offset(i), expected[i]);
		}
		for (let y = -10; y <= (expected.at(-1) ?? 0) + 20; y += 7) {
			assert.deepEqual(treeWindowOf(tree, y, 80, 2, 4), windowOf(expected, y, 80, 2, 4));
		}
	};

	checkAll();
	assert.equal(tree.set(1, 95), 35);
	heights[1] = 95;
	assert.equal(tree.set(4, 15), -105);
	heights[4] = 15;
	assert.equal(tree.set(7, 88), 58);
	heights[7] = 88;
	checkAll();
});

it('windowOf and fixedWindowOf return empty slices when completely off-screen and expand directionally on fast scroll', () => {
	const offs = offsets(Array.from({ length: 25 }, () => 40)); // total 1000
	// Strictly below viewport + overscan -> 0 mounted items, before=0, after=total
	assert.deepEqual(windowOf(offs, -2000, 400, 4, 4), { start: 0, end: 0 });
	assert.deepEqual(fixedWindowOf(25, 40, -2000, 400, 4, 4), { start: 0, end: 0 });
	// Strictly above viewport + overscan -> 0 mounted items, start=end=n
	assert.deepEqual(windowOf(offs, 2000, 400, 4, 4), { start: 25, end: 25 });
	assert.deepEqual(fixedWindowOf(25, 40, 2000, 400, 4, 4), { start: 25, end: 25 });
	// Asymmetric overscan expands only the leading edge
	assert.deepEqual(fixedWindowOf(100, 40, 400, 200, 2, 12), { start: 8, end: 28 });

	// Directional overscan scales with velocity and caps at maxExtra
	assert.deepEqual(directionalOverscan(0.05, 600, 40, 6, 24), { before: 6, after: 6 });
	const fastDown = directionalOverscan(4, 600, 40, 6, 24);
	assert.equal(fastDown.before, 6);
	assert.ok(fastDown.after > 6 && fastDown.after <= 30);
	const fastUp = directionalOverscan(-4, 600, 40, 6, 24);
	assert.equal(fastUp.after, 6);
	assert.ok(fastUp.before > 6 && fastUp.before <= 30);
	const extreme = directionalOverscan(500, 600, 40, 6, 20);
	assert.deepEqual(extreme, { before: 6, after: 26 });
});

it.live('virtual_list compensates scrollTop when a measured row strictly above the viewport grows', () =>
	browser(async () => {
		const callbacks: ResizeObserverCallback[] = [];
		const frames: FrameRequestCallback[] = [];
		const OriginalRO = globalThis.ResizeObserver;
		const OriginalRAF = globalThis.requestAnimationFrame;

		class StubResizeObserver implements ResizeObserver {
			constructor(cb: ResizeObserverCallback) {
				callbacks.push(cb);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		const flushFrames = () => {
			while (frames.length > 0) {
				const cb = frames.shift();
				cb?.(0);
			}
			flushSync();
		};
		globalThis.ResizeObserver = StubResizeObserver;
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		};

		try {
			const target = document.body.appendChild(document.createElement('div'));
			const items = Array.from({ length: 100 }, (_, i) => `r-${i}`);
			const view = mount(VirtualHarness, { target, props: { items } });
			flushSync();

			const port = required(target.querySelector<HTMLElement>('[data-port]'));
			const anchor = required(target.querySelector<HTMLElement>('[data-anchor]'));
			assert.equal(port.style.overflowAnchor, 'none', 'disables competing browser scroll anchoring');
			Object.defineProperty(port, 'scrollHeight', { value: 4000, configurable: true });
			Object.defineProperty(port, 'clientHeight', { value: 200, configurable: true });
			vi.spyOn(port, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));

			// Scroll down to y=400 (rows 0..9 are strictly above the visible band; rows 6..9 are in overscan)
			port.scrollTop = 400;
			vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -400, 300, 0));
			flushFrames();
			port.dispatchEvent(new Event('scroll', { bubbles: true }));
			flushFrames();

			const aboveRow = required(target.querySelector<HTMLElement>('[data-row="r-7"]'));
			// Grow r-7 from estimate 40px to 72px (+32px) — scrollTop must shift by +32px so visible content stays anchored
			const measureCb = callbacks[0];
			assert.ok(measureCb !== undefined);
			measureCb(
				[
					{
						target: aboveRow,
						borderBoxSize: [{ blockSize: 72, inlineSize: 300 }],
						contentBoxSize: [{ blockSize: 72, inlineSize: 300 }],
						devicePixelContentBoxSize: [],
						contentRect: new DOMRectReadOnly(0, 0, 300, 72)
					}
				],
				new StubResizeObserver(() => {})
			);
			flushSync();
			assert.equal(port.scrollTop, 432);

			// Sub-pixel jitter (< 0.5px) must not shift scrollTop
			measureCb(
				[
					{
						target: aboveRow,
						borderBoxSize: [{ blockSize: 72.3, inlineSize: 300 }],
						contentBoxSize: [{ blockSize: 72.3, inlineSize: 300 }],
						devicePixelContentBoxSize: [],
						contentRect: new DOMRectReadOnly(0, 0, 300, 72.3)
					}
				],
				new StubResizeObserver(() => {})
			);
			flushSync();
			assert.equal(port.scrollTop, 432);

			await unmount(view);
			assert.equal(port.style.overflowAnchor, '', 'restores inline overflow-anchor on unmount');
			target.remove();
		} finally {
			globalThis.ResizeObserver = OriginalRO;
			globalThis.requestAnimationFrame = OriginalRAF;
			vi.restoreAllMocks();
		}
	})
);

it.live('virtual_grid updates synchronously on scroll, skips orthogonal-axis reads, and reports prefetch range', () =>
	browser(async () => {
		const observedTargets: Element[] = [];
		const OriginalRO = globalThis.ResizeObserver;
		class TrackingRO implements ResizeObserver {
			observe(el: Element) {
				observedTargets.push(el);
			}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = TrackingRO;

		try {
			const ranges: VirtualRange[] = [];
			const target = document.body.appendChild(document.createElement('div'));
			const view = mount(VirtualGridHarness, {
				target,
				props: { rowCount: 100, colCount: 31, onRowRange: (r: VirtualRange) => ranges.push(r) }
			});
			flushSync();

			const port = required(target.querySelector<HTMLElement>('[data-grid-port]'));
			const rowAnchor = required(target.querySelector<HTMLElement>('[data-row-anchor]'));
			const colAnchor = required(target.querySelector<HTMLElement>('[data-col-anchor]'));

			// Fixed-size axes observe only clipping containers, never individual rows or columns.
			assert.equal(
				observedTargets.some((el) => el.hasAttribute('data-row') || el.hasAttribute('data-col')),
				false
			);

			let rowRect = new DOMRect(0, 0, 320, 0);
			let colRect = new DOMRect(0, 0, 0, 200);
			vi.spyOn(port, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 200));
			const rowRectSpy = vi.spyOn(rowAnchor, 'getBoundingClientRect').mockImplementation(() => rowRect);
			const colRectSpy = vi.spyOn(colAnchor, 'getBoundingClientRect').mockImplementation(() => colRect);

			// Scroll vertically to y=800 (row 20): updates synchronously inside the scroll event (no extra RAF lag).
			port.scrollTop = 800;
			rowRect = new DOMRect(0, -800, 320, 0);
			port.dispatchEvent(new Event('scroll'));
			flushSync();

			assert.equal(target.querySelector('[data-row="r-20"]') !== null, true, 'vertical slice updates synchronously');
			assert.equal(target.querySelector('[data-row="r-0"]') === null, true, 'off-screen top rows unmounted');
			const latestRange = required(ranges.at(-1));
			assert.equal(latestRange.scrolled, true);
			assert.ok(latestRange.start > 0 && latestRange.end > 20);

			// Pure horizontal scroll: row virtualizer skips getBoundingClientRect completely while col virtualizer shifts.
			rowRectSpy.mockClear();
			colRectSpy.mockClear();
			port.scrollLeft = 960;
			colRect = new DOMRect(-960, 0, 0, 200);
			port.dispatchEvent(new Event('scroll'));
			flushSync();

			assert.equal(rowRectSpy.mock.calls.length, 0, 'vertical axis ignores pure horizontal scroll');
			assert.ok(colRectSpy.mock.calls.length > 0, 'horizontal axis reads on horizontal scroll');
			assert.equal(target.querySelector('[data-col="c-12"]') !== null, true, 'horizontal slice tracks scrollLeft');
			assert.equal(target.querySelector('[data-col="c-0"]') === null, true, 'off-screen left columns unmounted');

			await unmount(view);
			target.remove();
		} finally {
			globalThis.ResizeObserver = OriginalRO;
			vi.restoreAllMocks();
		}
	})
);

it.live('Table retains previous page rows without flashing to a skeleton while the next page loads', () =>
	Effect.gen(function* () {
		const catalog = {
			items: {
				record_label: 'record.name',
				label: ['name'],
				fields: { name: { kind: 'text' } }
			}
		} satisfies NonNullable<KindsHost['catalog']>;
		const page2 = Promise.withResolvers<Value>();
		const fixture = yield* browser(() =>
			viewFixture({
				catalog,
				read: (_model, options) => {
					if ((options.limit ?? 25) > 25 || options.after !== undefined) return page2.promise;
					return {
						rows: [{ id: 'p1-1', revision: 1, name: 'First Row' }],
						next: 'c1',
						total: 26
					};
				}
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(ViewHarness, {
			target,
			props: {
				bolt: fixture.bolt,
				catalog,
				part: 'table',
				view: Table,
				props: { of: 'items', columns: ['name'], page_size: 25, toolbar: false }
			}
		});
		const settle = async () => {
			for (let i = 0; i < 3; i++) {
				flushSync();
				await tick();
				await new Promise((r) => setTimeout(r, 0));
			}
			flushSync();
		};
		try {
			yield* browser(() =>
				vi.waitFor(async () => {
					await settle();
					assert.equal(target.textContent?.includes('First Row'), true);
				})
			);
			assert.equal(target.querySelector('[data-read="loading"]') === null, true);
			const nextBtn = required(
				target.querySelector<HTMLButtonElement>('[data-pager] button[aria-label*="Next" i]')
			);
			nextBtn.click();
			yield* browser(settle);
			// While page 2 is still pending, page 1 stays mounted (no skeleton flash) and marks aria-busy.
			assert.equal(target.querySelector('[data-read="loading"]') === null, true);
			assert.equal(target.textContent?.includes('First Row'), true);
			assert.equal(
				target.querySelector('[data-table-wide]')?.getAttribute('aria-busy'),
				'true'
			);
			page2.resolve({
				rows: [
					...Array.from({ length: 25 }, (_, i) => ({
						id: `p1-${i + 1}`,
						revision: 1,
						name: `Row ${i + 1}`
					})),
					{ id: 'p2-1', revision: 1, name: 'Second Page Row' }
				],
				next: null,
				total: 26
			});
			yield* browser(() =>
				vi.waitFor(async () => {
					await settle();
					assert.equal(target.textContent?.includes('Second Page Row'), true);
				})
			);
			assert.equal(
				target.querySelector('[data-table-wide]')?.getAttribute('aria-busy'),
				null
			);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
			history.replaceState(null, '', '/');
		}
	})
);

it.live('Board keeps existing lane cards mounted while growing its single live page query and LocalBoard virtualizes long lanes', () =>
	Effect.gen(function* () {
		const catalog = {
			jobs: {
				record_label: 'record.title',
				label: ['title'],
				fields: {
					title: { kind: 'text' },
					status: { kind: 'enum', values: ['todo'] }
				}
			}
		} satisfies NonNullable<KindsHost['catalog']>;
		const page2 = Promise.withResolvers<Value>();
		const limits: number[] = [];
		const fixture = yield* browser(() =>
			viewFixture({
				catalog,
				aggregate: () => ({ rows: [{ key: { status: 'todo' }, count: 2 }], next: null }),
				read: (_model, options) => {
					const lim = options.limit ?? 25;
					limits.push(lim);
					if (lim >= 2) return page2.promise;
					return { rows: [{ id: 'j1', revision: 1, title: 'Card One', status: 'todo' }], next: 'c1' };
				}
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(ViewHarness, {
			target,
			props: {
				bolt: fixture.bolt,
				catalog,
				part: 'board',
				view: Board,
				props: { of: 'jobs', by: 'status', card: ['title'], page_size: 1, toolbar: false }
			}
		});
		const settle = async () => {
			for (let i = 0; i < 3; i++) {
				flushSync();
				await tick();
				await new Promise((r) => setTimeout(r, 0));
			}
			flushSync();
		};
		try {
			yield* browser(() =>
				vi.waitFor(async () => {
					await settle();
					assert.equal(target.querySelector('[data-board-card="j1"]') !== null, true);
				})
			);
			const moreBtn = required(target.querySelector<HTMLButtonElement>('[data-lane-more]'));
			moreBtn.click();
			yield* browser(settle);
			// Existing card stays visible while page 2 loads; single growing live query requests limit=2.
			assert.equal(target.querySelector('[data-board-card="j1"]') !== null, true);
			assert.equal(target.querySelector('[data-read="loading"]') === null, true);
			assert.deepEqual(limits, [1, 2]);
			page2.resolve({
				rows: [
					{ id: 'j1', revision: 1, title: 'Card One', status: 'todo' },
					{ id: 'j2', revision: 1, title: 'Card Two', status: 'todo' }
				],
				next: null
			});
			yield* browser(() =>
				vi.waitFor(async () => {
					await settle();
					assert.equal(target.querySelector('[data-board-card="j2"]') !== null, true);
				})
			);
			assert.equal(target.querySelector('[data-lane-more]') === null, true);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
			history.replaceState(null, '', '/');
		}

		// LocalBoard virtualizes lanes past threshold (25 cards) instead of mounting every card in the DOM.
		const disposeEdge = mount_edge(ManagedRuntime.make(Layer.empty));
		const localTarget = document.body.appendChild(document.createElement('div'));
		const localRows = Array.from({ length: 120 }, (_, i) => ({
			id: `lb-${i}`,
			title: `Item ${i}`,
			stage: 'open'
		}));
		const cardSnippet = createRawSnippet<[{ row: Values; lane: LocalLane }]>(
			(arg) => ({ render: () => `<span>${String(arg().row['title'] ?? '')}</span>` })
		);
		const localApp = mount(LocalBoard, {
			target: localTarget,
			props: {
				ctx: bare_ctx(),
				of: localRows,
				by: 'stage',
				lanes: [{ value: 'open', label: 'Open' }],
				card: cardSnippet,
				fields: ['title'],
				key: 'local-virtual',
				toolbar: false
			}
		});
		try {
			yield* browser(settle);
			const mounted = localTarget.querySelectorAll('[data-board-card]').length;
			assert.ok(mounted > 0 && mounted < 60, `expected virtualized local lane, got ${mounted}`);
		} finally {
			yield* browser(() => unmount(localApp));
			yield* browser(disposeEdge);
			localTarget.remove();
		}
	})
);
