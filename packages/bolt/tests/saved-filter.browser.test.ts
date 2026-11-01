import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import { filterOffers as fields } from './support/filter-catalog.ts';
import Editor from './support/saved-filter.svelte';
import './support/filter-editor.css';

it('the toolbar controls edit a saved filter inside a form without changing the viewer URL or submitting the form', async () => {
	const url = location.href;
	const fixture = await scriptedBolt({ answer: () => ({}) });
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Editor, {
		target,
		props: {
			bolt: {
				...fixture.bolt,
				options: () => Effect.succeed({ fields }),
				describe: () =>
					Effect.succeed({ where: { name: { eq: 'After' } }, orderBy: { name: 'asc' } })
			}
		}
	});
	try {
		await page
			.getByRole('textbox', { name: 'Describe what to show…' })
			.fill('Names matching After, ascending');
		await page.getByRole('button', { name: 'Apply filter and sort' }).click();
		await expect
			.poll(() => document.querySelector('[data-saved-filter]')?.textContent)
			.toBe(JSON.stringify({ where: { name: { eq: 'After' } }, orderBy: [{ name: 'asc' }] }));
		expect(document.querySelectorAll('form').length).toBe(1);
		expect(document.querySelector('[data-submitted]')?.textContent).toBe('0');
		expect(location.href).toBe(url);
		await page.getByText('Sort (1)', { exact: true }).click();
		await expect
			.element(page.getByRole('combobox', { name: 'Sort by', exact: true }))
			.toBeVisible();
		await page.getByRole('button', { name: 'Clear all', exact: true }).click();
		await expect.poll(() => document.querySelector('[data-saved-filter]')?.textContent).toBe('{}');
	} finally {
		await unmount(app);
		target.remove();
		await fixture.dispose();
	}
});

it('an unsupported saved clause stays intact until the person explicitly replaces it', async () => {
	const fixture = await scriptedBolt({ answer: () => ({}) });
	const target = document.createElement('div');
	document.body.append(target);
	const original = { where: { missing_field: { eq: 'Preserve me' } } };
	const app = mount(Editor, { target, props: { bolt: fixture.bolt, initial: original } });
	try {
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				'This saved filter contains a condition this editor cannot represent. It has been preserved.'
			);
		expect(document.querySelector('[data-saved-filter]')?.textContent).toBe(
			JSON.stringify(original)
		);
		await page.getByRole('button', { name: 'Replace filter', exact: true }).click();
		await expect.poll(() => document.querySelector('[data-saved-filter]')?.textContent).toBe('{}');
	} finally {
		await unmount(app);
		target.remove();
		await fixture.dispose();
	}
});
