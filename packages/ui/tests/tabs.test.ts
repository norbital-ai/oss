import './dom.ts';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import Tabs from '../src/primitives/tabs/tabs.svelte';

it('arrow and End keys move the selected tab', async () => {
	const body = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));
	const tabs = ['Overview', 'Measurements', 'History'].map((title) => ({
		name: title,
		title,
		body
	}));
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Tabs, { target, props: { tabs } });
	await tick();
	const selected = () =>
		target.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim();
	const press = async (key: string) => {
		document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
		await tick();
		flushSync();
	};
	target.querySelector<HTMLButtonElement>('[role=tab]')?.focus();
	await press('ArrowRight');
	expect(selected()).toBe('Measurements');
	await press('End');
	expect(selected()).toBe('History');
	await unmount(view);
});
