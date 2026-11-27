/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { page } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import AccessScroll from './support/access-scroll.svelte';
import './support/access-scroll.css';

const withViewport = async (
	width: number,
	height: number,
	props: { count?: number; fillOnly?: boolean },
	check: (target: HTMLElement) => Promise<void>
) => {
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(width, height);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(AccessScroll, { target, props });
	try {
		await tick();
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await check(target);
	} finally {
		await unmount(view);
		target.remove();
		await page.viewport(previous.width, previous.height);
	}
};

it('fits template picker, Continue and hint without nested panel scroll across desktop, tablet and mobile viewports', async () => {
	for (const [width, height] of [
		[1280, 600],
		[1536, 700],
		[1440, 950],
		[768, 640],
		[375, 667]
	] as const) {
		await withViewport(width, height, { count: 12 }, async (target) => {
			const panelBody = target.querySelector<HTMLElement>('.access-panel-body');
			const list = target.querySelector<HTMLElement>('[data-testid="template-scroll"]');
			const continueBtn = target.querySelector<HTMLElement>('[data-testid="continue"]');
			const hint = target.querySelector<HTMLElement>('.access-card-hint');
			const searchBar = target.querySelector<HTMLElement>('[data-testid="search-bar"]');
			const firstRow = target.querySelector<HTMLElement>('[data-testid="template-row"]');
			if (!panelBody || !list || !continueBtn || !hint || !searchBar || !firstRow)
				throw new Error('Expected access onboarding elements to mount');

			expect(panelBody.scrollHeight).toBeLessThanOrEqual(panelBody.clientHeight + 1);
			expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
			expect(list.clientHeight).toBeGreaterThanOrEqual(126);

			const panelRect = panelBody.getBoundingClientRect();
			const continueRect = continueBtn.getBoundingClientRect();
			const hintRect = hint.getBoundingClientRect();
			expect(continueRect.bottom).toBeLessThanOrEqual(panelRect.bottom + 1);
			expect(hintRect.bottom).toBeLessThanOrEqual(panelRect.bottom + 1);
			expect(hintRect.bottom).toBeLessThanOrEqual(window.innerHeight + 1);

			// No forced classic gutter misaligning cards from controls above them.
			expect(
				Math.abs(firstRow.getBoundingClientRect().right - searchBar.getBoundingClientRect().right)
			).toBeLessThanOrEqual(2);
			expect(list.offsetWidth - list.clientWidth).toBe(0);

			if (height >= 900) {
				expect(list.clientHeight).toBeGreaterThanOrEqual(280);
				expect(list.clientHeight).toBeLessThanOrEqual(290);
			}
		});
	}
});

it('keeps single-result template list compact and lets short viewports chain scroll', async () => {
	await withViewport(1280, 700, { count: 1 }, async (target) => {
		const list = target.querySelector<HTMLElement>('[data-testid="template-scroll"]');
		if (!list) throw new Error('Expected template scroll');
		expect(list.clientHeight).toBeLessThan(120);
	});

	await withViewport(1280, 420, { count: 12 }, async (target) => {
		const panelBody = target.querySelector<HTMLElement>('.access-panel-body');
		const list = target.querySelector<HTMLElement>('[data-testid="template-scroll"]');
		const continueBtn = target.querySelector<HTMLElement>('[data-testid="continue"]');
		const hint = target.querySelector<HTMLElement>('.access-card-hint');
		if (!panelBody || !list || !continueBtn || !hint)
			throw new Error('Expected access scroll elements');
		expect(list.clientHeight).toBeGreaterThanOrEqual(126);
		expect(panelBody.scrollHeight).toBeGreaterThan(panelBody.clientHeight);
		// Siblings must never overlap when the outer panel falls back to scrolling.
		expect(continueBtn.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			list.getBoundingClientRect().bottom
		);
		expect(hint.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			continueBtn.getBoundingClientRect().bottom
		);
		// Content-sized scrollports must not trap vertical wheel chaining when an outer container scrolls.
		expect(getComputedStyle(list).overscrollBehaviorY).toBe('auto');
	});
});

it('enforces cross-OS scrollbar, icon, and backdrop parity in Chromium', async () => {
	await withViewport(1280, 600, { count: 12 }, async (target) => {
		const list = target.querySelector<HTMLElement>('[data-testid="template-scroll"]');
		const panel = target.querySelector<HTMLElement>('.access-panel');
		const themeBtn = target.querySelector<HTMLElement>('[data-testid="access-theme-trigger"]');
		const canvas = target.querySelector<HTMLCanvasElement>('.access-backdrop canvas');
		if (!list || !panel || !themeBtn || !canvas)
			throw new Error('Expected access scroll, theme button, and backdrop canvas');

		// Bounded fade-equipped `content` scrolls hide native classic scrollbar gutters everywhere.
		const listStyle = getComputedStyle(list);
		expect(listStyle.scrollbarWidth).toBe('none');
		expect(listStyle.scrollbarGutter).toBe('auto');
		expect(listStyle.overscrollBehaviorY).toBe('auto');

		// Theme toggle uses a vector SVG icon, never OS-font Unicode glyphs (☀ / ☾).
		expect(themeBtn.textContent?.trim()).toBe('');
		expect(themeBtn.querySelector('svg')).not.toBeNull();

		// Norbius dot backdrop extends visibly past the wide card even on a 600px-tall Windows viewport.
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Expected 2d context');
		const dpr = canvas.width / Math.max(1, window.innerWidth);
		const panelLeft = Math.floor(panel.getBoundingClientRect().left * dpr);
		const stripLeft = Math.max(0, panelLeft - Math.round(80 * dpr));
		const strip = ctx.getImageData(stripLeft, 0, Math.max(1, panelLeft - stripLeft), canvas.height).data;
		let painted = 0;
		for (let i = 3; i < strip.length; i += 4) {
			if ((strip[i] ?? 0) > 0) painted += 1;
		}
		expect(painted).toBeGreaterThan(20);
	});

	await withViewport(1280, 700, { count: 12, fillOnly: true }, async (target) => {
		const list = target.querySelector<HTMLElement>('[data-testid="fill-scroll"]');
		if (!list) throw new Error('Expected fill scroll');
		await expect.poll(() => list.getAttribute('data-overflow') ?? '').toContain('block-end');
		const style = getComputedStyle(list);
		// Chromium disables ::-webkit-scrollbar* whenever scrollbar-width or scrollbar-color is non-auto.
		expect(style.scrollbarWidth).toBe('auto');
		expect(style.scrollbarColor).toBe('auto');
		expect(style.scrollbarGutter).toBe('auto');
		expect(style.overscrollBehaviorY).toBe('contain');
	});
});
