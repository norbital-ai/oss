import './dom.ts';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import AppHeader from '../src/layout/app-header.svelte';
import Combobox from '../src/primitives/combobox/combobox.svelte';

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

it('a compact header keeps one line: title, description behind its info button, actions behind one button', () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(AppHeader, {
		target,
		props: {
			compact: true,
			title: 'Settings',
			description: 'Manage legal versions.',
			actions: text('Void version'),
			trailing: text('Bell')
		}
	});
	flushSync();
	expect(target.querySelector('p')).toBeNull();
	expect(target.querySelector('[aria-label="Manage legal versions."]')).not.toBeNull();
	const line = target.querySelector('h1')?.closest('[data-compact] > *');
	expect(line?.querySelector('[data-app-actions-trigger]')).not.toBeNull();
	expect(line?.querySelector('[data-app-actions]')).toBeNull();
	// shut, the actions stay mounted (a scope picker owns page state), out of sight
	const shelved = target.querySelector<HTMLElement>('[data-app-actions]');
	expect(shelved?.textContent).toBe('Void version');
	expect(shelved?.parentElement?.hidden).toBe(true);
	// whatever row an app lays its actions out in, they stack in the popover
	expect(shelved?.className).toContain('*:flex-col');
	unmount(view);
	target.remove();
});

it('a wide header keeps its description in the hero', () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(AppHeader, {
		target,
		props: { title: 'Settings', description: 'Manage legal versions.' }
	});
	flushSync();
	expect(target.querySelector('p')?.textContent).toContain('Manage legal versions.');
	unmount(view);
	target.remove();
});

it('a combobox carries its badge inside the trigger', () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Combobox, {
		target,
		props: {
			options: [{ value: 'a', label: 'Alice' }],
			value: 'a',
			onChange: () => undefined,
			badge: text('SEALED')
		}
	});
	flushSync();
	expect(target.querySelector('[role=combobox]')?.textContent).toContain('SEALED');
	unmount(view);
	target.remove();
});
