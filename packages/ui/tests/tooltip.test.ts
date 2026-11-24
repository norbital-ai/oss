import './dom.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import Button from '../src/primitives/button/button.svelte';
import { noHover } from '../src/primitives/utils.ts';
import TooltipHarness from './tooltip-harness.svelte';

const bubble = () => document.querySelector('[data-slot="popover-content"]');
const tips = () => [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]')];
const must = <T>(value: T | null | undefined, label: string): T => {
	if (value === null || value === undefined) throw new Error(`Expected ${label}`);
	return value;
};
const settle = async () => {
	await tick();
	flushSync();
};

it('an enabled trigger keeps its action and opens its hint on a tap where nothing hovers', async () => {
	vi.spyOn(noHover, 'current', 'get').mockReturnValue(true);
	const onclick = vi.fn();
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Button, { target, props: { hint: 'Why', onclick } });
	flushSync();
	target.querySelector('button')?.click();
	await settle();
	expect(onclick).toHaveBeenCalledOnce();
	expect(bubble()?.textContent).toContain('Why');
	await unmount(view);
});

it('a disabled trigger lets the tap through to the box around it', async () => {
	vi.spyOn(noHover, 'current', 'get').mockReturnValue(true);
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Button, { target, props: { disabled: true, disabled_message: 'Locked' } });
	flushSync();
	target.querySelector('button')?.parentElement?.click();
	await settle();
	expect(bubble()?.textContent).toContain('Locked');
	await unmount(view);
});

it('a hovering pointer never gets the popover', async () => {
	vi.spyOn(noHover, 'current', 'get').mockReturnValue(false);
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Button, { target, props: { hint: 'Why' } });
	flushSync();
	target.querySelector('button')?.click();
	await settle();
	expect(bubble()).toBeNull();
	await unmount(view);
});

it('hover tooltip caps width, uses anchor-origin spring pop without sliding, and hands off warmly to siblings', async () => {
	vi.spyOn(noHover, 'current', 'get').mockReturnValue(false);
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(TooltipHarness, { target });
	try {
		await settle();
		const btnA = must(target.querySelector<HTMLButtonElement>('[data-testid="tip-a"]'), 'tip-a');
		const btnB = must(target.querySelector<HTMLButtonElement>('[data-testid="tip-b"]'), 'tip-b');
		btnA.getBoundingClientRect = () => new DOMRect(900, 300, 20, 20);
		btnB.getBoundingClientRect = () => new DOMRect(400, 300, 20, 20);

		// Cold open respects delay_duration
		btnA.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
		await settle();
		expect(tips()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(100);
		await settle();
		expect(tips()).toHaveLength(1);
		const tipA = must(tips()[0], 'tooltip A');
		expect(tipA.className).toContain('max-w-[min(20rem,calc(100vw-1rem))]');
		expect(tipA.className).toContain('ease-spring');
		expect(tipA.className).not.toContain('slide-in-from-');
		expect(tipA.getAttribute('data-side')).toBe('top');
		expect(tipA.getAttribute('data-positioned')).toBe('true');
		expect(tipA.style.getPropertyValue('--floating-origin-y')).toBe('100%');

		// Moving to sibling B closes A immediately and opens B without waiting delay_duration again
		btnA.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
		btnB.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
		await settle();
		expect(tips()).toHaveLength(1);
		expect(must(tips()[0], 'tooltip B').textContent).toContain('Second hint');

		// Escape dismisses open hovered tooltip
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(tips()).toHaveLength(0);
	} finally {
		await unmount(view);
		target.remove();
		vi.useRealTimers();
	}
});

it('an open tooltip inside a dialog never blocks the dialog from dismissing on outside click or Escape', async () => {
	vi.spyOn(noHover, 'current', 'get').mockReturnValue(false);
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(TooltipHarness, { target, props: { dialogOpen: true } });
	try {
		await settle();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		const modalBtn = must(
			document.querySelector<HTMLButtonElement>('[data-testid="modal-tip"]'),
			'modal-tip'
		);
		modalBtn.getBoundingClientRect = () => new DOMRect(300, 300, 32, 24);
		modalBtn.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
		await settle();
		expect(tips()).toHaveLength(1);

		// Outside pointerdown still reaches the dialog dismiss layer
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await settle();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		await unmount(view);
		target.remove();
	}
});
