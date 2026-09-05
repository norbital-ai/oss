// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import FinderCatalogueView from './support/finder-catalogue-view.svelte';
import { createDebouncedRecordSearch } from '../src/client/ui/agent/debounced-record-search.js';

// Keep the actual finder and its reactive catalogue/search lifecycle. Dialog placement and
// palette styling belong to the real-browser suite and do not affect this timing boundary.
vi.mock('@norbital-ai/ui/dialog', async () => {
	const { default: Fragment } = await import('./support/finder-test-fragment.svelte');
	return { Root: Fragment, Content: Fragment };
});
vi.mock('@norbital-ai/ui/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../src/client/ui/finder/finder-palette.svelte', async () => ({
	default: (await import('./support/finder-test-palette.svelte')).default
}));

it('keeps an unchanged query running when input repeats before the debounce completes', async () => {
	const onResults = vi.fn();
	const search = createDebouncedRecordSearch({
		delayMs: 10,
		search: () => Effect.succeed(['site-1']),
		onLoading: () => undefined,
		onResults
	});
	try {
		const parsed = { collection: 'sites', text: 'Sunnyview' };
		search.schedule('sites:Sunnyview', parsed, true);
		search.schedule('sites:Sunnyview', parsed, true);
		await vi.waitFor(() => expect(onResults).toHaveBeenCalledWith(['site-1']));
	} finally {
		search.cancel();
	}
});

it('starts a typed record search when its delayed catalogue arrives', async () => {
	const rows = [{ id: 'site-1', name: 'Sunnyview' }];
	const findRecords = vi.fn(() => {
		const ready = Promise.resolve(rows);
		return {
			current: rows,
			loading: false,
			error: undefined,
			nextCursor: null,
			extend: () => undefined,
			then: ready.then.bind(ready)
		};
	});
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(FinderCatalogueView, { target, props: { findRecords } });
	try {
		flushSync();
		const input = document.querySelector<HTMLInputElement>('input[data-command-input]');
		expect(input).not.toBeNull();
		input!.value = '#sites Sunnyview';
		input!.dispatchEvent(new InputEvent('input', { bubbles: true }));
		flushSync();
		expect(findRecords).not.toHaveBeenCalled();
		component.loadCollections(['sites']);
		flushSync();
		await vi.waitFor(() =>
			expect(findRecords).toHaveBeenCalledWith('sites', {
				search: { mode: 'lexical', term: 'Sunnyview' },
				limit: 8
			})
		);
		await vi.waitFor(() =>
			expect(document.querySelector('[data-value="record:sites:site-1"]')).not.toBeNull()
		);
	} finally {
		await unmount(component);
		target.remove();
	}
});
