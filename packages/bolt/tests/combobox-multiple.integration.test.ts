// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import Combobox from '../../ui/src/primitives/combobox/combobox.svelte';
import Multiple from './support/combobox-multiple.svelte';
const options = [
	{ value: 'a', label: 'Alice' },
	{ value: 'b', label: 'Bob' },
	{ value: 'c', label: 'Carol' }
];
it('multiple selection toggles by keyboard and pointer, remains open, filters, and removes selections', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: (readonly string[])[] = [];
	const view = mount(Multiple, {
		target,
		props: { onChange: (v: readonly string[]) => changes.push(v) }
	});
	flushSync();
	target.querySelector<HTMLButtonElement>('[role=combobox]')!.click();
	await tick();
	flushSync();
	const list = () => document.querySelector<HTMLElement>('[role=listbox]')!;
	expect(list().getAttribute('aria-multiselectable')).toBe('true');
	const input = document.querySelector<HTMLInputElement>('input')!;
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await tick();
	flushSync();
	expect(changes).toEqual([['a']]);
	expect(list()).not.toBeNull();
	document.querySelector<HTMLButtonElement>('[data-value=b] button')!.click();
	await tick();
	flushSync();
	expect(changes.at(-1)).toEqual(['a', 'b']);
	expect(target.querySelector('[role=combobox]')?.getAttribute('aria-label')).toContain(
		'Alice, Bob'
	);
	input.value = 'car';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	flushSync();
	expect(document.querySelector('[data-value=b]')).toBeNull();
	document.querySelector<HTMLButtonElement>('[data-value=c] button')!.click();
	await tick();
	flushSync();
	expect(changes.at(-1)).toEqual(['a', 'b', 'c']);
	expect(target.textContent).toContain('+1');
	input.value = '';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	flushSync();
	document.querySelector<HTMLButtonElement>('[data-value=a] button')!.click();
	await tick();
	flushSync();
	expect(changes.at(-1)).toEqual(['b', 'c']);
	document.querySelector<HTMLButtonElement>('[data-value=""] button')!.click();
	await tick();
	flushSync();
	expect(changes.at(-1)).toEqual([]);
	expect(list()).not.toBeNull();
	await unmount(view);
	target.remove();
});
it('single selection preserves its scalar callback and closes', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: (string | null)[] = [];
	const view = mount(Combobox, {
		target,
		props: { options, value: null, onChange: (v: string | null) => changes.push(v) }
	});
	flushSync();
	target.querySelector<HTMLButtonElement>('[role=combobox]')!.click();
	await tick();
	flushSync();
	document.querySelector<HTMLButtonElement>('[data-value=a] button')!.click();
	await tick();
	flushSync();
	expect(changes).toEqual(['a']);
	expect(target.querySelector('[role=combobox]')?.getAttribute('aria-expanded')).toBe('false');
	await unmount(view);
	target.remove();
});

it('multiple readonly displays selected labels and disabled has no usable trigger', async () => {
	for (const props of [{ readonly: true }, { disabled: true }]) {
		const target = document.body.appendChild(document.createElement('div'));
		const changes: (readonly string[])[] = [];
		const view = mount(Combobox, {
			target,
			props: {
				...props,
				multiple: true,
				options,
				value: ['a', 'b'],
				onChange: (v: readonly string[]) => changes.push(v)
			}
		});
		flushSync();
		if (props.readonly) {
			expect(target.textContent).toContain('Alice, Bob');
			expect(target.querySelector('[role=combobox]')).toBeNull();
		} else {
			const trigger = target.querySelector<HTMLButtonElement>('[role=combobox]')!;
			expect(trigger.disabled).toBe(true);
			trigger.click();
			await tick();
			expect(trigger.getAttribute('aria-expanded')).toBe('false');
		}
		expect(changes).toEqual([]);
		await unmount(view);
		target.remove();
	}
});

it('single readonly and disabled controls preserve the existing restrictions', async () => {
	for (const props of [{ readonly: true }, { disabled: true }]) {
		const target = document.body.appendChild(document.createElement('div'));
		const changes: (string | null)[] = [];
		const view = mount(Combobox, {
			target,
			props: { ...props, options, value: 'a', onChange: (v: string | null) => changes.push(v) }
		});
		flushSync();
		if (props.readonly) {
			expect(target.textContent).toContain('Alice');
			expect(target.querySelector('[role=combobox]')).toBeNull();
		} else {
			const trigger = target.querySelector<HTMLButtonElement>('[role=combobox]')!;
			expect(trigger.disabled).toBe(true);
			trigger.click();
			await tick();
			expect(trigger.getAttribute('aria-expanded')).toBe('false');
		}
		expect(changes).toEqual([]);
		await unmount(view);
		target.remove();
	}
});
