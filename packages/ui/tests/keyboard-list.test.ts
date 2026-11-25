import { expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { create_listbox } from '../src/behaviors/index.ts';
import { in_root } from './run-root.svelte.ts';

it('create_listbox virtual navigation wraps, skips disabled rows and stays clear on empty lists', () => {
	const stop = in_root(() => {
		const empty = create_listbox({ items: () => [], focus: 'virtual', filter: false });
		expect(empty.active).toBeUndefined();
		empty.input_attrs(true).onkeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		expect(empty.active).toBeUndefined();

		const lb = create_listbox({
			items: () => [
				{ value: 'a', label: 'A' },
				{ value: 'b', label: 'B', disabled: true },
				{ value: 'c', label: 'C' }
			],
			focus: 'virtual',
			filter: false
		});
		expect(lb.active).toBe('a');
		lb.input_attrs(true).onkeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		flushSync();
		expect(lb.active).toBe('c');
		lb.input_attrs(true).onkeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		flushSync();
		expect(lb.active).toBe('a');
		lb.input_attrs(true).onkeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
		flushSync();
		expect(lb.active).toBe('c');

		const allDisabled = create_listbox({
			items: () => [
				{ value: 'x', label: 'X', disabled: true },
				{ value: 'y', label: 'Y', disabled: true }
			],
			focus: 'virtual',
			filter: false
		});
		expect(allDisabled.active).toBeUndefined();
	});
	stop();
});
