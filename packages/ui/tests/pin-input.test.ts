import { expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Harness from './pin-input-harness.svelte';

it('does not complete the same code again when a failed request enables the input', async () => {
	const complete = vi.fn();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(Harness, { target, props: { complete } });
	try {
		await tick();
		const input = target.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');
		const retry = target.querySelector('button');
		if (input === null || retry === null) throw new Error('Expected the code input and retry.');
		const enter = (value: string) => {
			input.value = value;
			input.dispatchEvent(
				new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
			);
		};
		enter('010101');
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		retry.click();
		await tick();
		await tick();
		expect(input.disabled).toBe(false);
		expect(complete).toHaveBeenCalledTimes(1);
		enter('01010');
		await tick();
		enter('010101');
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
		expect(complete).toHaveBeenLastCalledWith('010101');
	} finally {
		await unmount(view);
		target.remove();
	}
});
