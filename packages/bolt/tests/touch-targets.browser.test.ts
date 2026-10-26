/// <reference types="@vitest/browser-playwright" />
import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import Tabs from '../../ui/src/primitives/tabs/tabs.svelte';
import '../../ui/src/base.css';

test('tabs retain arrow and End key navigation', async () => {
	const body = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));
	const tabs = ['Overview', 'Measurements', 'History'].map((title) => ({
		name: title,
		title,
		body
	}));
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(Tabs, { target, props: { tabs } });
	try {
		await tick();
		const first = target.querySelector<HTMLButtonElement>('[role=tab]');
		if (!first) throw new Error('Missing first tab');
		first.focus();
		await userEvent.keyboard('{ArrowRight}');
		await expect
			.element(page.getByRole('tab', { name: 'Measurements', exact: true }))
			.toHaveAttribute('aria-selected', 'true');
		await userEvent.keyboard('{End}');
		await expect
			.element(page.getByRole('tab', { name: 'History', exact: true }))
			.toHaveAttribute('aria-selected', 'true');
	} finally {
		await unmount(view);
		target.remove();
	}
});
