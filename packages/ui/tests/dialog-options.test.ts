import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import Harness from './dialog-options-harness.svelte';
import { reactive } from './kit-state.svelte.js';
import { element } from './elements.ts';

const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
	}
};
const outsideClick = (outside: HTMLElement) => {
	outside.dispatchEvent(new PointerEvent('pointerdown', {
		bubbles: true,
		cancelable: true,
		button: 0,
		// beyond the dialog's bounds: the DOM lays nothing out, so the origin is inside its empty rect
		clientX: 1,
		clientY: 1,
		pointerType: 'touch'
	}));
	outside.click();
};

it('dialog options retain native focus, outside-interaction and Escape behavior when removed', async () => {
	const opened: Event[] = [],
		closed: Event[] = [],
		focused: Event[] = [],
		outsideEvents: Event[] = [],
		escaped: KeyboardEvent[] = [];
	const state = reactive<ComponentProps<typeof Harness>>({
		options: {
			trap_focus: false,
			prevent_scroll: false,
			restore_scroll_delay: null,
			interact_outside_behavior: 'ignore',
			on_open_auto_focus: (event) => {
				opened.push(event);
				event.preventDefault();
			},
			on_close_auto_focus: (event) => {
				closed.push(event);
				event.preventDefault();
			},
			on_focus_outside: (event) => focused.push(event),
			on_interact_outside: (event) => {
				outsideEvents.push(event);
				event.preventDefault();
			},
			on_escape_keydown: (event) => {
				escaped.push(event);
				event.preventDefault();
			}
		}
	});
	const overflow = document.body.style.overflow;
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Harness, { target, props: state });
	try {
		flushSync();
		const outside = element<HTMLInputElement>(target, '[data-outside]');
		outside.focus();
		element<HTMLButtonElement>(target, '[data-open]').click();
		await settle();
		assert.equal(opened.length, 1);
		assert.ok(document.activeElement === outside, 'opening focus may be prevented');
		assert.equal(document.body.style.overflow, overflow);
		element<HTMLButtonElement>(target, '[data-inside]').focus();
		outside.focus();
		await settle();
		assert.ok(document.activeElement === outside, 'trap_focus=false allows focus outside');
		assert.ok(focused.some((event) => event.target === outside));
		outsideClick(outside);
		await settle();
		assert.equal(outsideEvents.length, 0, 'ignore keeps the native outside callback idle');
		assert.equal(element(target, 'output').textContent, 'open');
		state.options.interact_outside_behavior = 'close';
		await settle();
		outsideClick(outside);
		await settle();
		assert.equal(outsideEvents.length, 1);
		assert.equal(element(target, 'output').textContent, 'open', 'the native event may prevent dismissal');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await settle();
		assert.equal(escaped.length, 1);
		assert.equal(element(target, 'output').textContent, 'open');
		state.options.on_escape_keydown = undefined;
		await settle();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await settle();
		assert.equal(element(target, 'output').textContent, 'closed');
		assert.equal(closed.length, 1);
		state.options = {};
		element<HTMLButtonElement>(target, '[data-open]').click();
		await settle();
		assert.ok(document.activeElement === element(target, '[data-inside]'), 'omitted focus options retain native autofocus');
		outsideClick(outside);
		await settle();
		assert.equal(element(target, 'output').textContent, 'closed', 'omitted options use native dismissal defaults');
		assert.equal(outsideEvents.length, 1);
	} finally {
		await unmount(view);
		target.remove();
	}
});
