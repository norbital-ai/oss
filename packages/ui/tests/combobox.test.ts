import './dom.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import Combobox from '../src/primitives/combobox/combobox.svelte';
import Multiple from './combobox-harness.svelte';

const options = [
	{ value: 'a', label: 'Alice' },
	{ value: 'b', label: 'Bob' },
	{ value: 'c', label: 'Carol' }
];
const settle = async () => {
	await tick();
	flushSync();
};
const option = (value: string) => {
	const button = document.querySelector<HTMLButtonElement>(`[data-value="${value}"] button`);
	if (button === null) throw new Error(`no option ${value}`);
	return button;
};

it('multiple selection toggles by keyboard and pointer, stays open, filters and clears', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: (readonly string[])[] = [];
	const view = mount(Multiple, {
		target,
		props: { onChange: (v: readonly string[]) => changes.push(v) }
	});
	flushSync();
	target.querySelector<HTMLButtonElement>('[role=combobox]')?.click();
	await settle();
	const list = () => document.querySelector<HTMLElement>('[role=listbox]');
	expect(list()?.getAttribute('aria-multiselectable')).toBe('true');
	const input = document.querySelector<HTMLInputElement>('input');
	if (input === null) throw new Error('no search input');
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await settle();
	expect(changes).toEqual([['a']]);
	option('b').click();
	await settle();
	expect(changes.at(-1)).toEqual(['a', 'b']);
	input.value = 'car';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	expect(document.querySelector('[data-value=b]')).toBeNull();
	option('c').click();
	await settle();
	expect(changes.at(-1)).toEqual(['a', 'b', 'c']);
	input.value = '';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	option('a').click();
	await settle();
	expect(changes.at(-1)).toEqual(['b', 'c']);
	option('').click();
	await settle();
	expect(changes.at(-1)).toEqual([]);
	expect(list()).not.toBeNull();
	await unmount(view);
});

it('single selection answers a scalar and closes', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: (string | null)[] = [];
	const view = mount(Combobox, {
		target,
		props: { options, value: null, onChange: (v: string | null) => changes.push(v) }
	});
	flushSync();
	target.querySelector<HTMLButtonElement>('[role=combobox]')?.click();
	await settle();
	option('a').click();
	await settle();
	expect(changes).toEqual(['a']);
	expect(target.querySelector('[role=combobox]')?.getAttribute('aria-expanded')).toBe('false');
	await unmount(view);
});

it('readonly has no trigger and disabled cannot open, single or multiple', async () => {
	for (const multiple of [false, true])
		for (const restriction of [{ readonly: true }, { disabled: true }]) {
			const target = document.body.appendChild(document.createElement('div'));
			let changed = 0;
			const view = multiple
				? mount(Combobox, {
						target,
						props: {
							...restriction,
							multiple: true,
							options,
							value: ['a', 'b'],
							onChange: () => changed++
						}
					})
				: mount(Combobox, {
						target,
						props: { ...restriction, options, value: 'a', onChange: () => changed++ }
					});
			flushSync();
			const trigger = target.querySelector<HTMLButtonElement>('[role=combobox]');
			if (restriction.readonly) expect(trigger).toBeNull();
			else {
				expect(trigger?.disabled).toBe(true);
				trigger?.click();
				await tick();
				expect(trigger?.getAttribute('aria-expanded')).toBe('false');
			}
			expect(changed).toBe(0);
			await unmount(view);
		}
});
