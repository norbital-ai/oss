import { expect, it } from '@effect/vitest';
import { mount, unmount } from 'svelte';
import { Effect, Schema } from 'effect';
import type { Json } from '../../ui/src/client/contract.ts';
import { filter_offers as fields, filter_catalog } from './support/filter-catalog.ts';
import { fromWhere } from '../../ui/src/filter/where.ts';
import { page } from 'vitest/browser';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import Editor from './support/filter-editor.svelte';
import './support/filter-editor.css';

it('reads and edits each rule once, shows nesting, and keeps prefilters locked across desktop and mobile', async () => {
	const previous = {
		width: window.innerWidth,
		height: window.innerHeight,
		dark: document.documentElement.classList.contains('dark')
	};
	const fixture = await scriptedBolt({ answer: () => ({}) });
	const bolt = {
		...fixture.bolt,
		decode: undefined,
		options: () => Effect.succeed({ fields })
	};
	const target = document.createElement('div');
	document.body.append(target);
	const editor = mount(Editor, { target, props: { bolt } });
	try {
		for (const width of [1200, 390]) {
			await page.viewport(width, 900);
			document.documentElement.classList.toggle('dark', width === 390);
			await page.getByRole('button', { name: 'Filter and sort', exact: true }).click();
			await expect
				.element(page.getByRole('group', { name: 'Related records', exact: true }))
				.toBeVisible();
			await Promise.all(
				(document.querySelector('[data-view-panel]')?.getAnimations() ?? [])
					.filter(
						(a) =>
							a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity
					)
					.map((a) => a.finished)
			);
			const prefilter = document.querySelector('[data-author-where]');
			expect(prefilter?.querySelector('button, input, select, textarea')).toBeNull();
			expect(prefilter?.textContent).toContain('Always');
			expect(document.querySelector('[data-rule-summary]')).toBeNull();
			const related = document.querySelector<HTMLElement>('[data-many=contracts]');
			expect(related?.querySelector('[aria-label=Quantifier]')?.textContent).toContain(
				'At least one record in'
			);
			expect(
				related?.querySelector('[aria-label=Quantifier]')?.getBoundingClientRect().height
			).toBe(24);
			// a ref is a linked record: the same fixture's Employer field shows the link icon, not a text icon
			const employer = document.querySelector<HTMLInputElement>('[data-cond=employer] input');
			expect(employer).not.toBeNull();
			expect(document.querySelector('[data-cond=employer] [data-field-type=link]')).not.toBeNull();
			expect(document.querySelector('[data-cond=employer] [data-field-type=fieldText]')).toBeNull();
			await page.getByRole('textbox').fill('Acme');
			await expect
				.poll(() => new URL(location.href).searchParams.get('filter-browser.where'))
				.toContain('Acme');
			await page.getByRole('textbox').fill('Nihon Pigment');
			const toggle = related?.querySelector<HTMLButtonElement>('[data-scope-toggle]');
			toggle?.click();
			await expect.poll(() => toggle?.getAttribute('aria-expanded')).toBe('false');
			expect(related?.querySelector<HTMLElement>('[data-nested]')?.hidden).toBe(true);
			toggle?.click();
			await expect.poll(() => toggle?.getAttribute('aria-expanded')).toBe('true');
			const remove = document.querySelector<HTMLButtonElement>(
				'[data-cond=employer] [data-remove]'
			);
			remove?.focus();
			expect(remove && getComputedStyle(remove).opacity).toBe('1');
			remove?.blur();
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
			await page
				.getByRole('group', { name: 'Related records', exact: true })
				.getByRole('button', { name: 'Add condition', exact: true })
				.first()
				.click();
			await page.getByRole('button', { name: /Add a set of conditions/ }).click();
			await expect.poll(() => related?.querySelectorAll('[data-group]').length).toBe(2);
			const groups = related?.querySelectorAll<HTMLElement>('[data-group]');
			groups?.[1]?.querySelector<HTMLButtonElement>('[data-remove]')?.click();
			await expect.poll(() => related?.querySelectorAll('[data-group]').length).toBe(1);
			await expect.poll(() => document.querySelectorAll('[data-add-nested-group]').length).toBe(0);
			await Promise.all(
				(document.querySelector('[data-view-panel]')?.getAnimations() ?? [])
					.filter(
						(a) =>
							a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity
					)
					.map((a) => a.finished)
			);
			await page.screenshot({ path: `../../../.vitest/filter-clarity-${width}.png` });
			await page.getByRole('button', { name: 'Filter and sort', exact: true }).click();
			await expect.poll(() => document.querySelector('[data-view-panel]')).toBeNull();
		}
	} finally {
		await unmount(editor);
		target.remove();
		await fixture.dispose();
		document.documentElement.classList.toggle('dark', previous.dark);
		await page.viewport(previous.width, previous.height);
	}
});

const element = <T extends Element = HTMLElement>(selector: string): T => {
	const found = document.querySelector<T>(selector);
	if (!found) throw Error(`Missing ${selector}`);
	return found;
};
async function openEditor(initialFilter: Json) {
	history.replaceState(null, '', '/');
	await page.viewport(1200, 900);
	const fixture = await scriptedBolt({ answer: () => ({}) });
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Editor, {
		target,
		props: {
			initialFilter,
			bolt: { ...fixture.bolt, decode: undefined, options: () => Effect.succeed({ fields }) }
		}
	});
	await page.getByRole('button', { name: 'Filter and sort', exact: true }).click();
	await expect.element(page.getByRole('dialog', { name: 'Filter and sort' })).toBeVisible();
	return async () => {
		await unmount(app);
		target.remove();
		await fixture.dispose();
	};
}
async function field(selector: string, path: string) {
	await page.elementLocator(element(`${selector} [data-field-picker]`)).click();
	await expect
		.poll(() => document.querySelector(`[data-field-list] [data-path="${path}"]`))
		.not.toBeNull();
	await page.elementLocator(element(`[data-field-list] [data-path="${path}"]`)).click();
	await expect.poll(() => document.querySelector('[data-field-list]')).toBeNull();
}
async function operator(path: string, op?: string) {
	const trigger = element(`[data-cond="${path}"] [aria-label=Operator]`);
	await page.elementLocator(trigger).click();
	await expect.poll(() => document.querySelector('[role=listbox] [data-value]')).not.toBeNull();
	const values = [...document.querySelectorAll<HTMLElement>('[role=listbox] [data-value]')].map(
		(e) => e.dataset['value']
	);
	if (op) await page.elementLocator(element(`[role=listbox] [data-value="${op}"] button`)).click();
	else await page.elementLocator(trigger).click();
	await expect.poll(() => document.querySelector('[role=listbox]')).toBeNull();
	return values;
}
const state = () => new URL(location.href).searchParams.get('filter-browser.where') ?? '';
async function operandMode(path: string, mode: string) {
	await page.elementLocator(element(`[data-cond="${path}"] [data-compare-with]`)).click();
	await page.getByRole('combobox', { name: 'Compare with', exact: true }).click();
	await expect
		.poll(() => document.querySelector(`[role=listbox] [data-value="${mode}"] button`))
		.not.toBeNull();
	await page.elementLocator(element(`[role=listbox] [data-value="${mode}"] button`)).click();
	await expect.poll(() => document.querySelector('[role=listbox] [data-value]')).toBeNull();
}
async function choose(label: string, value: string) {
	await page.getByRole('combobox', { name: label, exact: true }).click();
	await expect
		.poll(() =>
			[...document.querySelectorAll<HTMLElement>('[role=listbox] [data-value]')].map(
				(e) => e.dataset['value']
			)
		)
		.toContain(value);
	await page.elementLocator(element(`[role=listbox] [data-value="${value}"] button`)).click();
	await expect.poll(() => document.querySelector('[role=listbox]')).toBeNull();
}
function expectParsableWhere() {
	const raw = new URL(location.href).searchParams.get('filter-browser.where');
	const where =
		raw === null ? {} : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(raw);
	expect(fromWhere(filter_catalog, 'people', where), JSON.stringify(where)).not.toBeNull();
}

it('preserves compatible text and operator edits while leaving the other rule untouched', async () => {
	const close = await openEditor({ name: { eq: 'Acme' }, alias: { eq: 'Keep me' } });
	try {
		await field('[data-cond=name]', 'name');
		expect(element<HTMLInputElement>('[data-cond=name] input').value).toBe('Acme');
		await field('[data-cond=name]', 'alias');
		expect(document.querySelectorAll('[data-cond=alias]')).toHaveLength(2);
		expect(
			[...document.querySelectorAll<HTMLInputElement>('[data-cond=alias] input')].map(
				(e) => e.value
			)
		).toEqual(['Acme', 'Keep me']);
		await operator('alias', 'ne');
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Acme');
		await field('[data-cond=alias]', 'hired');
		const choices = await operator('hired');
		expect(choices).toContain('during');
		expect(choices).not.toContain('like');
		expect(choices).not.toContain('search');
		expect(document.querySelector('[data-cond=hired] [data-field-type=fieldDate]')).not.toBeNull();
		expect(document.querySelector('[data-cond=hired] input[type=text]')).toBeNull();
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
		await expect.poll(state).not.toContain('Acme');
		expect(state()).toContain('Keep me');
		await field('[data-cond=hired]', 'window');
		expect(await operator('window')).toEqual([
			'contains',
			'overlaps',
			'contained_by',
			'starts_within',
			'ends_within'
		]);
		expect(
			document.querySelector('[data-cond=window] [data-field-type=fieldPeriod]')
		).not.toBeNull();
		await operator('window', 'overlaps');
		expect(document.querySelector('[data-cond=window] [data-date-input]')).toBeNull();
		expect(document.querySelector('[data-cond=window] [data-period-input]')).not.toBeNull();
		await field('[data-cond=window]', 'enabled');
		expect(await operator('enabled')).toEqual(['eq']);
		expect(
			document.querySelector('[data-cond=enabled] [data-field-type=fieldBool]')
		).not.toBeNull();
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
	} finally {
		await close();
	}
});

it('preserves date values across date fields and clears incompatible period input shapes', async () => {
	const close = await openEditor({ hired: { eq: '2026-10-01' }, alias: { eq: 'Keep me' } });
	try {
		await field('[data-cond=hired]', 'due');
		await expect.poll(state).toContain('2026-10-01');
		await operator('due', 'gte');
		await expect.poll(state).toContain('gte');
		expect(state()).toContain('2026-10-01');
		await field('[data-cond=due]', 'window');
		await expect.poll(state).toContain('contains');
		expect(state()).toContain('2026-10-01');
		await operator('window', 'overlaps');
		await expect.poll(state).not.toContain('2026-10-01');
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
		await field('[data-cond=window]', 'name');
		expect(element<HTMLInputElement>('[data-cond=name] input').value).toBe('');
		expect(document.querySelector('[data-cond=name] [data-date-input]')).toBeNull();
	} finally {
		await close();
	}
});

it('shows model structure in the picker and never carries scalar or child state into another relation', async () => {
	const close = await openEditor({ name: { eq: 'Acme' }, alias: { eq: 'Keep me' } });
	try {
		await page.elementLocator(element('[data-cond=name] [data-field-picker]')).click();
		expect(element('[data-path=employer] [data-field-type=link]')).toBeTruthy();
		await page.elementLocator(element('[data-expand=employer]')).click();
		expect(element('[data-path="employer.name"] [data-field-type=fieldInside]')).toBeTruthy();
		expect(element('[data-path=profile] [data-field-type=fieldObject]')).toBeTruthy();
		const bounds = element('[data-field-list]').getBoundingClientRect();
		expect(bounds.top).toBeGreaterThanOrEqual(0);
		expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
		expect(element('[data-view-header]').getBoundingClientRect().top).toBeGreaterThanOrEqual(
			element('[data-view-panel]').getBoundingClientRect().top
		);
		await page.screenshot({ path: '../../../.vitest/filter-field-chooser.png' });
		await page.elementLocator(element('[data-path="employer.name"]')).click();
		await expect.poll(() => document.querySelector('[data-cond="employer.name"]')).not.toBeNull();
		expect(element<HTMLInputElement>('[data-cond="employer.name"] input').value).toBe('Acme');
		await field('[data-cond="employer.name"]', 'employer');
		expect(document.querySelector('[data-cond=employer] [data-field-type=link]')).not.toBeNull();
		expect(await operator('employer')).toEqual(['eq', 'ne', 'in', 'not_in']);
		expect(document.querySelector('[data-cond=employer] input[type=text]')).toBeNull();
		await field('[data-cond=employer]', 'contracts');
		expect(document.querySelector('[data-many=contracts] [data-field-type=links]')).not.toBeNull();
		expect(document.querySelector('[data-many=contracts] [data-cond]')).toBeNull();
		await page.elementLocator(element('[data-many=contracts] [data-scope-toggle]')).click();
		await expect
			.poll(() => element('[data-many=contracts] [data-nested]').hasAttribute('hidden'))
			.toBe(true);
		await page.elementLocator(element('[data-many=contracts] [data-add-filter]')).click();
		await page.getByRole('button', { name: 'Add condition', exact: true }).last().click();
		await expect.poll(() => document.querySelector('[data-cond=""]')).not.toBeNull();
		expect(element('[data-many=contracts] [data-nested]').hasAttribute('hidden')).toBe(false);
		await field('[data-cond=""]', 'alias');
		expect(
			document.querySelector('[data-many=contracts] [data-cond=alias] [data-field-type=fieldText]')
		).not.toBeNull();
		await page
			.elementLocator(element('[data-many=contracts] [data-cond=alias] input'))
			.fill('Inside');
		await field('[data-many=contracts]', 'contracts');
		expect(element<HTMLInputElement>('[data-many=contracts] [data-cond=alias] input').value).toBe(
			'Inside'
		);
		await field('[data-many=contracts]', 'notes');
		expect(document.querySelector('[data-many=contracts] [data-cond=alias]')).toBeNull();
		expect(document.querySelector('[data-many=notes] [data-cond]')).toBeNull();
		await field('[data-many=notes]', 'name');
		expect(document.querySelector('[data-many]')).toBeNull();
		expect(element<HTMLInputElement>('[data-cond=name] input').value).toBe('');
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
	} finally {
		await close();
	}
});

it('keeps aggregate field, comparison, and threshold states compatible through actual controls', async () => {
	const close = await openEditor({
		contracts: { sum: { of: 'amount', gte: 12 } },
		alias: { eq: 'Keep me' }
	});
	try {
		expect(element<HTMLInputElement>('[data-many=contracts] input[type=number]').value).toBe('12');
		await choose('Quantifier', 'max');
		expect(element<HTMLInputElement>('[data-many=contracts] input[type=number]').value).toBe('12');
		await choose('Of', 'ends');
		expect(document.querySelector('[data-many=contracts] input[type=number]')).toBeNull();
		expect(document.querySelector('[data-many=contracts] [data-date-input]')).not.toBeNull();
		await expect.poll(state).not.toContain('12');
		await choose('Of', 'amount');
		expect(element<HTMLInputElement>('[data-many=contracts] input[type=number]').value).toBe('');
		expect(document.querySelector('[data-many=contracts] [data-date-input]')).toBeNull();
		await page.elementLocator(element('[data-many=contracts] input[type=number]')).fill('3');
		await choose('Compare', 'lt');
		expect(element<HTMLInputElement>('[data-many=contracts] input[type=number]').value).toBe('3');
		await choose('Quantifier', 'count');
		expect(element<HTMLInputElement>('[data-many=contracts] input[type=number]').value).toBe('3');
		expect(document.querySelector('[data-many=contracts] [aria-label=Of]')).toBeNull();
		await choose('Quantifier', 'some');
		expect(document.querySelector('[data-many=contracts] input[type=number]')).toBeNull();
		expect(document.querySelector('[data-many=contracts] [aria-label=Compare]')).toBeNull();
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
	} finally {
		await close();
	}
});

it('keeps every control transition inside the catalogue grammar', async () => {
	const close = await openEditor({ name: { eq: 'Acme' } });
	try {
		expectParsableWhere();
		await field('[data-cond=name]', 'alias');
		expectParsableWhere();
		await operator('alias', 'in');
		expectParsableWhere();
		await operator('alias', 'eq');
		expectParsableWhere();
		await field('[data-cond=alias]', 'hired');
		expectParsableWhere();
		expect(await operator('hired')).not.toContain('like');
		await operator('hired', 'during');
		expectParsableWhere();
		await field('[data-cond=hired]', 'window');
		expectParsableWhere();
		await operator('window', 'overlaps');
		expectParsableWhere();
		await field('[data-cond=window]', 'employer');
		expectParsableWhere();
		expect(await operator('employer')).toEqual(['eq', 'ne', 'in', 'not_in']);
		await operator('employer', 'in');
		expectParsableWhere();
		await field('[data-cond=employer]', 'contracts');
		expectParsableWhere();
		await choose('Quantifier', 'count');
		expectParsableWhere();
		await page.elementLocator(element('[data-many=contracts] input[type=number]')).fill('2');
		expectParsableWhere();
		await choose('Quantifier', 'max');
		expectParsableWhere();
		await choose('Of', 'ends');
		expectParsableWhere();
		await choose('Of', 'amount');
		expectParsableWhere();
		await page.elementLocator(element('[data-many=contracts] input[type=number]')).fill('3');
		expectParsableWhere();
		await choose('Quantifier', 'every');
		expectParsableWhere();
		await choose('Quantifier', 'some');
		expectParsableWhere();
		await field('[data-many=contracts]', 'name');
		expectParsableWhere();
		const textOps = await operator('name');
		expect(textOps).toEqual(['eq', 'ne', 'like', 'in', 'not_in']);
		await field('[data-cond=name]', 'sequence');
		expectParsableWhere();
		const seqOps = await operator('sequence');
		expect(seqOps).toEqual(['eq', 'ne', 'in', 'not_in']);
	} finally {
		await close();
	}
});

it('drops an invalid seed instead of rendering or sending it', async () => {
	const close = await openEditor({ name: { gt: 'Acme' } });
	try {
		expect(document.querySelector('[data-cond=name]')).toBeNull();
		expectParsableWhere();
	} finally {
		await close();
	}
});

it('does not erase a value when its current comparison mode is selected again', async () => {
	const close = await openEditor({ hired: { eq: '2026-10-01' }, alias: { eq: 'Keep me' } });
	try {
		const before = element('[data-cond=hired] [data-date-input]').textContent;
		const url = state();
		await operandMode('hired', 'lit');
		expect(element('[data-cond=hired] [data-date-input]').textContent).toBe(before);
		expect(state()).toBe(url);
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
	} finally {
		await close();
	}
});

it('shows only the active operand editor and removes it when the field type changes', async () => {
	const close = await openEditor({ hired: { eq: '2026-10-01' }, alias: { eq: 'Keep me' } });
	try {
		await operandMode('hired', 'var');
		expect(document.querySelector('[data-cond=hired] [data-variable-input]')).not.toBeNull();
		expect(document.querySelector('[data-cond=hired] [data-date-input]')).toBeNull();
		await page.elementLocator(element('[data-variable-option=today] button')).click();
		await expect.poll(state).toContain('today');
		await operandMode('hired', 'var');
		expect(state()).toContain('today');
		expect(document.querySelector('[data-variable-input]')).toBeNull();
		await field('[data-cond=hired]', 'due');
		expect(state()).toContain('today');
		await field('[data-cond=due]', 'amount');
		expect(document.querySelector('[data-variable]')).toBeNull();
		expect(document.querySelector('[data-date-input]')).toBeNull();
		expect(element<HTMLInputElement>('[data-cond=amount] input').value).toBe('');
		expect(element<HTMLInputElement>('[data-cond=alias] input').value).toBe('Keep me');
	} finally {
		await close();
	}
});
