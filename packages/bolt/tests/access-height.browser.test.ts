/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { cdp, page } from 'vitest/browser';
import { flushSync, mount, tick, unmount } from 'svelte';
import AccessHeight from './support/access-height.svelte';
import './support/shell.css';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const motion = (reduced: boolean) =>
	cdp().send('Emulation.setEmulatedMedia', {
		features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]
	});

function element(target: HTMLElement, selector: string) {
	const found = target.querySelector<HTMLElement>(selector);
	if (found === null) throw new Error(`Missing access fixture element: ${selector}`);
	return found;
}

async function fixture(width = 1100, height = 900, reduced = false) {
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(width, height);
	await motion(reduced);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(AccessHeight, { target });
	const panel = () => element(target, '.access-panel');
	const body = () => element(target, '.access-panel-body');
	const naturalHeight = () => {
		const style = getComputedStyle(panel());
		return (
			body().getBoundingClientRect().height +
			Number.parseFloat(style.borderTopWidth) +
			Number.parseFloat(style.borderBottomWidth)
		);
	};
	const select = (mode: 'choose' | 'create' | 'long') =>
		flushSync(() => element(target, `[data-mode="${mode}"]`).click());
	const dispose = async () => {
		await unmount(view);
		target.remove();
		await cdp().send('Emulation.setEmulatedMedia', { features: [] });
		await page.viewport(previous.width, previous.height);
	};
	await tick();
	await document.fonts.ready;
	await frame();
	await frame();
	await expect.poll(() => panel().getAnimations().length).toBe(0);
	return { target, panel, body, naturalHeight, select, dispose };
}

async function heightAnimation(panel: HTMLElement, previous?: Animation) {
	await expect
		.poll(() => panel.getAnimations().some((animation) => animation !== previous), { interval: 5 })
		.toBe(true);
	const animation = panel.getAnimations().find((animation) => animation !== previous);
	if (animation === undefined || !(animation.effect instanceof KeyframeEffect))
		throw new Error('The access card did not start a native keyframe animation');
	const keyframes = animation.effect.getKeyframes();
	const first = keyframes[0]?.height,
		last = keyframes.at(-1)?.height;
	if (typeof first !== 'string' || typeof last !== 'string')
		throw new Error('The access animation does not interpolate height');
	expect(animation.effect.getTiming().duration).toBe(240);
	return { animation, from: Number.parseFloat(first), to: Number.parseFloat(last) };
}

async function settled(panel: HTMLElement) {
	await frame();
	await expect.poll(() => panel.getAnimations().length).toBe(0);
	expect(panel.style.height).toBe('');
}

it('the initial access card fits its content instead of reserving 26rem', async () => {
	const f = await fixture();
	try {
		const height = f.panel().getBoundingClientRect().height;
		expect(height).toBeGreaterThan(100);
		expect(height).toBeLessThan(
			26 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
		);
		expect(height).toBeCloseTo(f.naturalHeight(), 0);
		expect(f.panel().scrollHeight).toBeLessThanOrEqual(f.panel().clientHeight + 1);
	} finally {
		await f.dispose();
	}
});

it('content growth animates for 240ms and releases the card to its natural height', async () => {
	const f = await fixture();
	try {
		const panel = f.panel(),
			initial = panel.getBoundingClientRect().height;
		f.select('create');
		const { animation, from, to } = await heightAnimation(panel);
		expect(f.panel()).toBe(panel);
		expect(from).toBeCloseTo(initial, 0);
		expect(to).toBeGreaterThan(initial + 32);
		animation.pause();
		await animation.ready;
		animation.currentTime = 120;
		await frame();
		const halfway = panel.getBoundingClientRect().height;
		expect(halfway).toBeGreaterThan(from);
		expect(halfway).toBeLessThan(to);
		animation.finish();
		await settled(panel);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(f.naturalHeight(), 0);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(to, 0);
	} finally {
		await f.dispose();
	}
});

it('rapid changes retarget from the rendered height and cancel obsolete animations', async () => {
	const f = await fixture();
	try {
		const panel = f.panel(),
			initial = panel.getBoundingClientRect().height;
		f.select('create');
		const growing = await heightAnimation(panel);
		growing.animation.pause();
		await growing.animation.ready;
		growing.animation.currentTime = 80;
		await frame();
		const beforeShrink = panel.getBoundingClientRect().height;
		f.select('choose');
		const shrinking = await heightAnimation(panel, growing.animation);
		expect(shrinking.animation).not.toBe(growing.animation);
		expect(growing.animation.playState).toBe('idle');
		expect(shrinking.from).toBeCloseTo(beforeShrink, 0);
		expect(shrinking.to).toBeCloseTo(initial, 0);
		shrinking.animation.pause();
		await shrinking.animation.ready;
		shrinking.animation.currentTime = 80;
		await frame();
		const beforeRegrow = panel.getBoundingClientRect().height;
		f.select('create');
		const regrowing = await heightAnimation(panel, shrinking.animation);
		expect(shrinking.animation.playState).toBe('idle');
		expect(regrowing.from).toBeCloseTo(beforeRegrow, 0);
		regrowing.animation.finish();
		await settled(panel);
		expect(f.panel()).toBe(panel);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(f.naturalHeight(), 0);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(growing.to, 0);
	} finally {
		await f.dispose();
	}
});

it('reduced motion skips resizing animation and cancels a transition when enabled', async () => {
	const f = await fixture(1100, 900, true);
	try {
		const panel = f.panel(),
			initial = panel.getBoundingClientRect().height;
		expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
		f.select('create');
		await frame();
		await frame();
		expect(panel.getAnimations()).toHaveLength(0);
		expect(panel.getBoundingClientRect().height).toBeGreaterThan(initial + 32);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(f.naturalHeight(), 0);
		await motion(false);
		expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
		f.select('choose');
		const { animation } = await heightAnimation(panel);
		animation.pause();
		await animation.ready;
		animation.currentTime = 80;
		await motion(true);
		await expect.poll(() => panel.getAnimations().length).toBe(0);
		expect(animation.playState).toBe('idle');
		expect(panel.getBoundingClientRect().height).toBeCloseTo(initial, 0);
	} finally {
		await f.dispose();
	}
});

it.each([
	{ width: 1100, height: 500 },
	{ width: 390, height: 500 }
])(
	'a long form stays within a $width × $height viewport and scrolls to its submit action',
	async ({ width, height }) => {
		const f = await fixture(width, height, true);
		try {
			f.select('long');
			await frame();
			await frame();
			const panel = f.panel(),
				footer = element(f.target, '.access-switch');
			const style = getComputedStyle(panel),
				cap = Number.parseFloat(style.maxBlockSize);
			expect(Number.isFinite(cap)).toBe(true);
			expect(cap).toBeGreaterThan(100);
			expect(panel.getBoundingClientRect().height).toBeCloseTo(cap, 0);
			expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
			expect(style.overflowY).toBe('auto');
			expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
			expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
				panel.getBoundingClientRect().bottom - 1
			);
			const spaceAfter = Number.parseFloat(
				getComputedStyle(element(f.target, '.access-content')).paddingBottom
			);
			expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
				innerHeight - spaceAfter + 1
			);
			await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
			await expect.element(page.getByRole('status')).toHaveTextContent('Workspace created');
			expect(panel.scrollTop).toBeGreaterThan(0);
			const submit = element(panel, 'button[type="submit"]').getBoundingClientRect();
			expect(submit.top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
			expect(submit.bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom + 1);
		} finally {
			await f.dispose();
		}
	}
);
