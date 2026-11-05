import './dom.ts';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import AppHeader from '../src/layout/app-header.svelte';
import Combobox from '../src/primitives/combobox/combobox.svelte';

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

it('a compact header keeps one line: title, description behind its info button, actions beside them', () => {
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
	const line = target.querySelector('h1')?.closest('[data-compact] > *:last-child');
	expect(line?.querySelector('[data-app-actions]')?.textContent).toBe('Void version');
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
