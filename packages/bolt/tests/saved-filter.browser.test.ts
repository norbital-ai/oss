import { required } from './support/required.ts';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import { filter_offers as fields } from './support/filter-catalog.ts';
import Editor from './support/saved-filter.svelte';
import { filter_catalog } from './support/filter-catalog.ts';
import type { FilterVariables } from '../../ui/src/filter/operators.ts';
import type { ModelExposure } from '../../ui/src/kinds/context.ts';
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
					Effect.succeed({ where: { name: { eq: 'After' } }, order_by: { name: 'asc' } })
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
			.toBe(JSON.stringify({ where: { name: { eq: 'After' } }, order_by: [{ name: 'asc' }] }));
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

const captured: FilterVariables = {
	presets: ['ctx.event.row.id', 'ctx.event.row.employee_id'],
	validate: (text) =>
		['ctx.event.row.id', 'ctx.event.row.employee_id'].includes(text)
			? undefined
			: 'Choose a captured event field.'
};
const ruleCatalog: Record<string, ModelExposure> = {
	...filter_catalog,
	obligation: {
		label: [],
		fields: {
			state: { kind: 'enum', values: ['OPEN', 'FULFILLED'] },
			subject_id: { kind: 'text', optional: true, hidden: true }
		}
	},
	entry: {
		label: [],
		fields: {},
		relations: {
			payslip_id: { targets: ['people'], optional: true },
			employment_id: { targets: ['people'], optional: true }
		}
	}
};

it('saved event filters edit hidden bindings and empty relations with the table controls on desktop and mobile', async () => {
	const fixture = await scriptedBolt({ answer: () => ({}) });
	const cases = [
		{
			model: 'obligation',
			initial: {
				where: { state: { eq: 'OPEN' }, subject_id: { eq: { var: 'ctx.event.row.id' } } }
			},
			paths: ['state', 'subject_id']
		},
		{
			model: 'entry',
			initial: {
				where: { payslip_id: { is_null: true }, employment_id: { eq: { var: 'ctx.event.row.id' } } }
			},
			paths: ['payslip_id', 'employment_id']
		}
	] as const;
	try {
		for (const width of [1200, 390])
			for (const example of cases) {
				await page.viewport(width, 900);
				const target = document.createElement('div');
				document.body.append(target);
				const app = mount(Editor, {
					target,
					props: {
						bolt: { ...fixture.bolt, options: () => Effect.succeed({ fields: [] }) },
						model: example.model,
						catalog: ruleCatalog,
						initial: example.initial,
						variables: captured
					}
				});
				try {
					for (const path of example.paths)
						await expect.poll(() => document.querySelector(`[data-cond="${path}"]`)).not.toBeNull();
					expect(document.querySelector('[role=alert]')).toBeNull();
					expect(document.querySelector('pre[data-saved-filter]')).toBeNull();
					expect(document.querySelector('[data-variable="ctx.event.row.id"]')).not.toBeNull();
					if (example.model === 'entry') {
						const operator = document.querySelector('[data-cond=payslip_id] [aria-label=Operator]');
						if (!operator) throw Error('The empty relation is an editable condition.');
						await page.elementLocator(operator).click();
						await page
							.elementLocator(required(document.querySelector('[data-value=not_null] button')))
							.click();
						await expect
							.poll(() => document.querySelector('output[data-saved-filter]')?.textContent)
							.toContain('"is_null":false');
						expect(document.querySelector('output[data-saved-filter]')?.textContent).toContain(
							'ctx.event.row.id'
						);
					} else {
						const field = document.querySelector('[data-cond=subject_id] [data-field-picker]');
						if (!field) throw Error('The saved subject is an editable condition.');
						await page.elementLocator(field).click();
						await expect
							.poll(() => document.querySelector('[data-field-list] [data-path=subject_id]'))
							.not.toBeNull();
						await page.elementLocator(field).click();
					}
					expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
					await page.screenshot({
						path: `../../../.vitest/saved-rule-${example.model}-${width}.png`
					});
				} finally {
					await unmount(app);
					target.remove();
				}
			}
	} finally {
		await fixture.dispose();
		await page.viewport(1200, 900);
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
				'This filter references a field or condition unavailable in the current model. It is kept unchanged below.'
			);
		expect(document.querySelector('[data-saved-filter]')?.textContent).toBe(
			JSON.stringify(original.where, null, 2)
		);
		await page.getByRole('button', { name: 'Replace filter', exact: true }).click();
		await expect.poll(() => document.querySelector('[data-saved-filter]')?.textContent).toBe('{}');
	} finally {
		await unmount(app);
		target.remove();
		await fixture.dispose();
	}
});
