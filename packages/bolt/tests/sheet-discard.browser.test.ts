/// <reference types="@vitest/browser-playwright" />
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from '../../ui/tests/kit-harness.svelte';
import '../../ui/src/base.css';

// The in-app discard question over an open sheet, in a real browser: Cancel keeps the sheet and the page stays live,
// then agreeing closes it. (A WebView suppresses `window.confirm`, so the sheet asks with its own dialog.)
test('closing a dirty sheet asks in-app; Cancel keeps it, Discard closes it', async () => {
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: { part: 'guarded', sheetOpen: true, dirty: () => true }
	});
	const asking = () =>
		document.querySelector<HTMLElement>('[data-confirm-dialog][data-state=open]');
	try {
		await tick();
		await userEvent.keyboard('{Escape}');
		await expect.poll(() => asking() !== null).toBe(true);
		await userEvent.click(asking()!.querySelector<HTMLElement>('[data-confirm-cancel]')!);
		await expect.poll(() => asking() === null).toBe(true);
		flushSync();
		expect(document.querySelector('[role=dialog]')).not.toBeNull();
		await userEvent.keyboard('{Escape}');
		await expect.poll(() => asking() !== null).toBe(true);
		await userEvent.click(asking()!.querySelector<HTMLElement>('[data-confirm-accept]')!);
		await expect.poll(() => document.querySelector('[role=dialog]') === null).toBe(true);
	} finally {
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
	}
});
