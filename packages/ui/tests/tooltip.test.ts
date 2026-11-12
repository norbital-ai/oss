import './dom.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import Button from '../src/primitives/button/button.svelte';
import { noHover } from '../src/primitives/utils.ts';

const bubble = () => document.querySelector('[data-slot="popover-content"]');
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
