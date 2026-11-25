import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { vi } from 'vitest';
import { browser, required } from './view-fixture.ts';

const { flushSync, mount, unmount } = await import('svelte');
const { default: VirtualHarness } = await import('./virtual-harness.svelte');

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
			target.remove();
		} finally {
			globalThis.ResizeObserver = OriginalRO;
			globalThis.requestAnimationFrame = OriginalRAF;
			vi.restoreAllMocks();
		}
	})
);
