/// <reference types="@vitest/browser-playwright" />
import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import { required } from './support/required.ts';
import OverlayMotionHarness from './support/overlay-motion-harness.svelte';
import '../../ui/src/base.css';

async function sampleCoords(el: HTMLElement, frames = 10): Promise<Array<{ left: string; top: string; side: string | null }>> {
	const samples: Array<{ left: string; top: string; side: string | null }> = [];
	for (let i = 0; i < frames; i++) {
		samples.push({ left: el.style.left, top: el.style.top, side: el.getAttribute('data-side') });
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	}
	return samples;
}

test('long tooltip is width-capped, anchor-originated, and never jitters coordinates during spring enter', async () => {
	await page.viewport(1200, 800);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(OverlayMotionHarness, { target });
	try {
		await tick();
		await document.fonts.ready;
		const trigger = required(target.querySelector<HTMLButtonElement>('[data-testid="edge-tooltip-trigger"]'));
		trigger.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true }));
		await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();
		const tip = required(document.querySelector<HTMLElement>('[data-slot="tooltip-content"]'));
		await expect.poll(() => tip.getAttribute('data-positioned')).toBe('true');

		// Width is capped at 20rem (320px), never stretching across the viewport
		expect(tip.offsetWidth).toBeLessThanOrEqual(320);
		expect(tip.offsetWidth).toBeGreaterThan(150);

		// Transform origin points directly at the right-edge trigger on the bottom edge (side="top")
		expect(tip.getAttribute('data-side')).toBe('top');
		expect(tip.style.getPropertyValue('--floating-origin-y')).toBe('100%');
		const originX = Number.parseInt(tip.style.getPropertyValue('--floating-origin-x'), 10);
		expect(originX).toBeGreaterThan(tip.offsetWidth * 0.7);
		// Uses the spring easing curve (no slide-in)
		expect(getComputedStyle(tip).animationTimingFunction).toContain('linear(');

		// Spring animation stays coordinate-stable across every frame (0px jitter)
		const samples = await sampleCoords(tip, 12);
		for (const sample of samples) {
			expect(sample).toEqual(samples[0]);
		}

		// Trigger near the top edge flips cleanly to bottom with top-edge origin
		const flipTrigger = required(target.querySelector<HTMLButtonElement>('[data-testid="flip-tooltip-trigger"]'));
		flipTrigger.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true }));
		await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')?.getAttribute('data-side')).toBe('bottom');
		const flippedTip = required(document.querySelector<HTMLElement>('[data-slot="tooltip-content"]'));
		expect(flippedTip.style.getPropertyValue('--floating-origin-y')).toBe('0%');
	} finally {
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
		await page.viewport(1280, 720);
	}
});

test('popover springs from its trigger edge with zero mid-animation coordinate drift', async () => {
	await page.viewport(1200, 800);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(OverlayMotionHarness, { target });
	try {
		await tick();
		await userEvent.click(page.getByTestId('popover-trigger'));
		await expect.poll(() => document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
		const pop = required(document.querySelector<HTMLElement>('[data-slot="popover-content"]'));
		await expect.poll(() => pop.getAttribute('data-positioned')).toBe('true');

		expect(pop.getAttribute('data-side')).toBe('bottom');
		expect(pop.style.getPropertyValue('--floating-origin-y')).toBe('0%');
		// Trigger is 48px wide at align="start" of a 256px popover -> originX is near trigger center (~24px)
		const originX = Number.parseInt(pop.style.getPropertyValue('--floating-origin-x'), 10);
		expect(originX).toBeGreaterThanOrEqual(16);
		expect(originX).toBeLessThanOrEqual(36);

		const samples = await sampleCoords(pop, 12);
		for (const sample of samples) {
			expect(sample).toEqual(samples[0]);
		}
	} finally {
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
		await page.viewport(1280, 720);
	}
});

test('dialog scroll-lock prevents horizontal shift and nested tooltip never blocks dialog Escape', async () => {
	await page.viewport(1200, 800);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(OverlayMotionHarness, { target });
	try {
		await tick();
		const bodyEl = required(target.querySelector<HTMLElement>('[data-testid="page-body"]'));
		const beforeRect = bodyEl.getBoundingClientRect();

		await userEvent.click(page.getByTestId('open-dialog'));
		await expect.element(page.getByRole('dialog')).toBeVisible();

		// Opening modal scroll lock causes zero horizontal layout shift
		const afterRect = bodyEl.getBoundingClientRect();
		expect(Math.abs(afterRect.width - beforeRect.width)).toBeLessThanOrEqual(1);

		// Hovering tooltip inside dialog leaves dialog Escape intact
		const tipTrigger = required(document.querySelector<HTMLButtonElement>('[data-testid="dialog-tip-trigger"]'));
		tipTrigger.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true }));
		await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();

		await userEvent.keyboard('{Escape}');
		await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
		await page.viewport(1280, 720);
	}
});
