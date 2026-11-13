/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime, Schema } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import type { Json } from '@norbital-ai/store/wire';
import type { KindsHost } from '../../ui/src/kinds/context.ts';
import Harness from '../../ui/tests/record-footer-harness.svelte';
import type { Outcome } from '../../ui/src/client/contract.ts';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import { required } from './support/required.ts';
import './support/shell.css';

const ROW = { id: 'j1', revision: 3, title: 'Paint v3', crew: 'B' };
const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true } },
		create: { columns: ['title', 'crew'] },
		update: { columns: ['title', 'crew'] }
	},
	notes: {
		label: ['title'], fields: { title: { kind: 'text' } }, create: { columns: ['title'] }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const extraFields = Array.from({ length: 40 }, (_, index) => `detail_${index + 1}`);
const readonlyCatalog = {
	jobs: {
		label: catalog.jobs.label,
		fields: {
			...catalog.jobs.fields,
			...Object.fromEntries(extraFields.map((name) => [name, { kind: 'text' as const }]))
		}
	}
} satisfies NonNullable<KindsHost['catalog']>;
const longRow = { ...ROW, ...Object.fromEntries(extraFields.map((name) => [name, `Value of ${name}`])) };
type Act = { callable: string; input: Json };
// the harness's props, but `bolt` (tsgo reads no `<script module>` exports)
type Options = {
	catalog?: NonNullable<KindsHost['catalog']>;
	layout?: 'sheet' | 'page';
	representation?: 'generated' | 'raw' | 'decorated';
	mode?: 'view' | 'edit' | 'create';
	id?: string;
	independent_form?: boolean;
	form_actions?: boolean;
	lock?: string;
	on_native_action?: () => void;
	on_form_action?: () => void;
	on_done?: (outcome: Outcome) => void;
	width?: number;
	height?: number;
};
const readObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

const withRecord = async (
	options: Options,
	check: (target: HTMLElement, acts: Act[], formActions: () => number) => Promise<void>
) => {
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(options.width ?? 1200, options.height ?? 850);
	localStorage.clear();
	sessionStorage.removeItem('ui.sheet.width');
	window.scrollTo(0, 0);
	const acts: Act[] = [];
	let formActions = 0;
	// the bolt build reads through the package edge; the source harness mounts its own
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const fixture = await scriptedBolt({
		catalog: options.catalog ?? catalog,
		answer: (read) => {
			if (read.m === 'history') return [];
			if (read.m !== 'query') throw new Error(`Unexpected footer fixture read ${read.m}`);
			return Object.fromEntries(Object.keys(readObject(read.a[0])).map((root) => [root, {
				rows: root === 'jobs' ? [options.catalog === readonlyCatalog ? longRow : ROW] : [], next: null, total: root === 'jobs' ? 1 : 0
			}]));
		},
		act: (body) => {
			const entries = 'callable' in body
				? [[body.callable, body.input] as const]
				: Object.entries(body.acts);
			if (entries.length !== 1) throw new Error('Footer controls must send one operation');
			const [callable, input] = required(entries[0]);
			if (!['jobs.create', 'jobs.update', 'notes.create'].includes(callable))
				throw new Error(`Unexpected footer fixture write ${callable}`);
			acts.push({ callable, input });
			return { kind: 'committed', output: null, records: [{ model: callable === 'notes.create' ? 'notes' : 'jobs', id: 'j1', revision: 4 }] };
		}
	});
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const { width: _width, height: _height, ...props } = options;
	const view = mount(Harness, {
		target,
		props: { bolt: fixture.bolt, catalog, on_done: () => {}, on_form_action: () => formActions++, ...props }
	});
	try {
		await expect.poll(() => target.querySelectorAll('[data-record-foot]').length).toBe(1);
		if (options.representation !== 'generated') {
			await expect.poll(() => target.querySelector('[data-long-detail]')).not.toBeNull();
			const recordTab = [...target.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((tab) => tab.textContent?.trim() === 'Record');
			if (recordTab !== undefined) await page.elementLocator(recordTab).click();
		}
		const panel = target.querySelector<HTMLElement>('[data-sheet-side]');
		if (panel !== null) await Promise.all(panel.getAnimations().map((animation) => animation.finished.catch(() => {})));
		await check(target, acts, () => formActions);
	} finally {
		await unmount(view);
		await fixture.dispose();
		await dispose();
		target.remove();
		localStorage.clear();
		await page.viewport(previous.width, previous.height);
	}
};

const chrome = (target: HTMLElement) => ({
	frame: required(target.querySelector<HTMLElement>('[data-view=record]')),
	header: required(target.querySelector<HTMLElement>('[data-sheet-side] > header, [data-record-chrome]')),
	main: required(target.querySelector<HTMLElement>('[data-record-main]')),
	footer: required(target.querySelector<HTMLElement>('[data-record-foot]'))
});
const scrollParent = (node: HTMLElement, main: HTMLElement): HTMLElement => {
	let current = node.parentElement;
	while (current !== null && main.contains(current)) {
		if (['auto', 'scroll'].includes(getComputedStyle(current).overflowY) && current.scrollHeight > current.clientHeight + 1)
			return current;
		current = current.parentElement;
	}
	throw new Error('Long record content has no bounded scrolling ancestor');
};
const checkScroll = async (target: HTMLElement, content: HTMLElement) => {
	const { frame, header, main, footer } = chrome(target);
	expect(target.querySelectorAll('[data-view=record]')).toHaveLength(1);
	expect(target.querySelectorAll('[data-record-foot]')).toHaveLength(1);
	expect(main.contains(footer)).toBe(false);
	await expect.element(page.elementLocator(footer)).toBeVisible();
	const before = { header: header.getBoundingClientRect(), footer: footer.getBoundingClientRect() };
	expect(before.footer.height).toBeGreaterThan(0);
	expect(before.footer.bottom).toBeLessThanOrEqual(innerHeight + 1);
	expect(main.getBoundingClientRect().height).toBeGreaterThan(0);
	expect(main.getBoundingClientRect().bottom).toBeLessThanOrEqual(before.footer.top + 1);
	const scroll = scrollParent(content, main);
	scroll.scrollTop = scroll.scrollHeight;
	await expect.poll(() => scroll.scrollTop).toBeGreaterThan(0);
	expect(Math.abs(header.getBoundingClientRect().top - before.header.top)).toBeLessThan(1);
	expect(Math.abs(footer.getBoundingClientRect().top - before.footer.top)).toBeLessThan(1);
	expect(frame.scrollHeight).toBeLessThanOrEqual(frame.clientHeight + 1);
	const sheetBody = target.querySelector<HTMLElement>('[data-sheet-body]');
	if (sheetBody !== null) {
		expect(sheetBody.scrollTop).toBe(0);
		expect(sheetBody.scrollHeight).toBeLessThanOrEqual(sheetBody.clientHeight + 1);
	}
	expect(window.scrollY).toBe(0);
	expect(required(document.scrollingElement).scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
};

it.each([
	{ layout: 'sheet', representation: 'generated', width: 1200, height: 850 },
	{ layout: 'sheet', representation: 'raw', width: 1200, height: 850 },
	{ layout: 'sheet', representation: 'decorated', width: 1200, height: 850 },
	{ layout: 'sheet', representation: 'raw', width: 393, height: 851 },
	{ layout: 'sheet', representation: 'decorated', width: 393, height: 851 },
	{ layout: 'page', representation: 'decorated', width: 1200, height: 850 },
	{ layout: 'page', representation: 'generated', width: 393, height: 851 },
	{ layout: 'page', representation: 'raw', width: 393, height: 851 }
] as const)('the $layout $representation record keeps chrome fixed at $width px', async (options) => {
	await withRecord({ ...options, catalog: readonlyCatalog }, async (target) => {
		await expect.poll(() => target.querySelector('[data-field=title]')).not.toBeNull();
		const content = required(target.querySelector<HTMLElement>(options.representation === 'generated' ? '[data-field=title]' : '[data-long-detail]'));
		await checkScroll(target, content);
		if (options.representation === 'decorated') {
			const footer = chrome(target).footer;
			await page.getByRole('tab', { name: 'Extra detail', exact: true }).click();
			await checkScroll(target, required(target.querySelector<HTMLElement>('[data-extra-detail]')));
			expect(chrome(target).footer).toBe(footer);
			await page.getByRole('tab', { name: 'Record', exact: true }).click();
		}
	});
});

it('a registered custom edit keeps Save visible and submits one current revision', async () => {
	await withRecord({}, async (target, acts) => {
		await page.getByRole('button', { name: 'Edit', exact: true }).click();
		await expect.poll(() => target.querySelector('[data-field=title] input')).not.toBeNull();
		await page.elementLocator(required(target.querySelector<HTMLInputElement>('[data-field=title] input'))).fill('Shared footer edit');
		await checkScroll(target, required(target.querySelector<HTMLElement>('[data-long-detail]')));
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => acts.length).toBe(1);
		expect(acts[0]).toEqual({ callable: 'jobs.update', input: [{ target: { id: 'j1', revision: 3 }, set: { title: 'Shared footer edit' } }] });
	});
});

it.each(['native', 'form'] as const)('custom create through %s retains one native label and actual form submission', async (submit) => {
	await withRecord({ mode: 'create', form_actions: true, independent_form: true }, async (target, acts, formActions) => {
		const named = page.getByRole('button', { name: 'Create named job', exact: true });
		await expect.element(named).toBeVisible();
		expect([...target.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Create named job')).toHaveLength(1);
		const matching = required(target.querySelector<HTMLFormElement>('[data-long-detail] form'));
		const local = required(target.querySelector<HTMLButtonElement>('[data-form-action]'));
		expect(local.form).toBe(matching);
		await page.elementLocator(required(matching.querySelector<HTMLInputElement>('[data-field=title] input'))).fill('Named create');
		await checkScroll(target, required(target.querySelector<HTMLElement>('[data-long-detail]')));
		if (submit === 'native') await named.click();
		else await page.elementLocator(local).click();
		await expect.poll(() => acts.filter((act) => act.callable === 'jobs.create').length).toBe(1);
		expect(acts.find((act) => act.callable === 'jobs.create')).toEqual({ callable: 'jobs.create', input: [{ title: 'Named create' }] });
		expect(formActions()).toBe(submit === 'form' ? 1 : 0);

		const note = required([...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Create independent note'));
		const independent = required(note.form);
		expect(independent).not.toBe(matching);
		expect(chrome(target).footer.contains(note)).toBe(false);
		await page.elementLocator(required(independent.querySelector<HTMLInputElement>('[data-field=title] input'))).fill('Independent note');
		await page.elementLocator(note).click();
		await expect.poll(() => acts.length).toBe(2);
		expect(acts[1]).toEqual({ callable: 'notes.create', input: [{ title: 'Independent note' }] });
		expect(target.querySelectorAll('[data-record-foot]')).toHaveLength(1);
	});
});
