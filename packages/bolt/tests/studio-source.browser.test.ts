/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Studio from '../src/shell/studio/Studio.svelte';
import type { StudioView } from '../src/shell/studio/model.ts';
import { shellApi } from '../src/shell/runtime.ts';
import './support/shell.css';

const path = 'src/data/model/treasury/+model.ts';
const title =
	'Add treasury models, reconcile bank accounts and review the complete workspace cash position';
const fixture: StudioView = {
	commit: 'studio-source-head',
	files: { [path]: { bytes: 32 }, 'src/data/model/orders/+model.ts': { bytes: 24 } },
	changes: [
		{
			path,
			change: 'modified',
			text: 'export const value = 1;',
			baseline: 'export const value = 0;'
		}
	],
	sections: null,
	log: [],
	preview: null,
	releases: [],
	change: '1',
	changeSets: [
		{
			id: '1',
			title,
			state: 'open',
			openedBy: 'administrator',
			contributors: ['administrator'],
			branch: 'change/1',
			base: 'studio-source-base',
			head: 'studio-source-head',
			behind: 0,
			preview: null,
			log: [],
			createdAt: '2026-10-30T12:00:00Z',
			updatedAt: '2026-10-30T12:00:00Z'
		}
	]
};

const element = <T extends HTMLElement = HTMLElement>(target: HTMLElement, selector: string) => {
	const found = target.querySelector<T>(selector);
	if (found === null) throw new Error(`Missing Studio element: ${selector}`);
	return found;
};

const withStudio = async (
	width: number,
	height: number,
	check: (target: HTMLElement) => Promise<void>,
	selection: { initialFile?: string; onFile?: (path: string) => void } = {}
) => {
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(width, height);
	const target = document.createElement('div');
	target.style.height = '100dvh';
	document.body.replaceChildren(target);
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	const view = mount(Studio, {
		target,
		props: {
			...selection,
			t: (key: string) => key,
			api: {
				...shellApi(async () => Response.json({ value: null })),
				studio: () => Effect.succeed(fixture),
				studioFile: () => Effect.succeed({ text: 'export const value = 1;' })
			}
		}
	});
	try {
		await expect.element(page.getByRole('button', { name: /navigator$/ })).toBeVisible();
		await check(target);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
		await page.viewport(previous.width, previous.height);
	}
};

it('manifest links select their source file and source navigation reports the next selection', async () => {
	const requested: string[] = [];
	const orders = 'src/data/model/orders/+model.ts';
	await withStudio(
		1440,
		900,
		async () => {
			await expect.element(page.getByRole('textbox', { name: orders, exact: true })).toBeVisible();
			await page
				.getByRole('searchbox', { name: 'Filter source files', exact: true })
				.fill('treasury');
			await page
				.getByRole('navigation', { name: 'Source', exact: true })
				.getByRole('button', { name: /src\/data\/model\/treasury\/\+model\.ts/ })
				.click();
			expect(requested).toEqual([path]);
		},
		{ initialFile: orders, onFile: (file: string) => requested.push(file) }
	);
});

it('the desktop source navigator preserves its tree, filter and selection across keyboard collapse', async () => {
	await withStudio(1440, 900, async (target) => {
		const toggle = page.getByRole('button', { name: /navigator$/ });
		const toggleElement = element<HTMLButtonElement>(target, 'button[aria-label$="navigator"]');
		const panel = document.getElementById(toggleElement.getAttribute('aria-controls') ?? '');
		if (panel === null) throw new Error('The source toggle must name its navigator');
		const tree = element(panel, '[data-file-tree]');
		const modes = element(target, '[role="group"][aria-label="Workspace navigator"]');
		expect(modes.getBoundingClientRect().top).toBeGreaterThan(
			toggleElement.getBoundingClientRect().top
		);
		const filter = page.getByRole('searchbox', { name: 'Filter source files', exact: true });
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(toggleElement.textContent?.trim()).toBe('');
		expect(panel.inert).toBe(false);
		await expect
			.element(page.getByRole('button', { name: 'New file in src', exact: true }))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Install package', exact: true }))
			.toBeVisible();
		await filter.fill('treasury');
		const modified = element(target, '[data-status="modified"]');
		expect(modified.textContent).toContain('+model.ts');
		expect(modified.querySelector('.text-warning-foreground')).not.toBeNull();
		const navigator = page.getByRole('navigation', { name: 'Source', exact: true });
		await navigator
			.getByRole('button', { name: /src\/data\/model\/treasury\/\+model\.ts/ })
			.click();
		await expect
			.poll(() => tree.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.title)
			.toBe(path);
		await expect.element(page.getByText('Before', { exact: true })).toBeVisible();
		const selected = element(tree, 'button[aria-current="true"]');
		const change = element(target, '[data-change="1"]');
		expect(change.title).toBe(`Change 1 · ${title}`);
		expect(change.scrollWidth).toBeGreaterThan(change.clientWidth);
		expect(change.getBoundingClientRect().left).toBeGreaterThan(
			toggleElement.getBoundingClientRect().right
		);

		await toggle.click();
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect.element(panel).not.toBeVisible();
		expect(panel.inert).toBe(true);
		expect(element(panel, '[data-file-tree]')).toBe(tree);
		expect(element(tree, 'button[aria-current="true"]')).toBe(selected);
		toggleElement.focus();
		await userEvent.keyboard('{Enter}');
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(panel.inert).toBe(false);
		await expect.element(filter).toHaveValue('treasury');
		await userEvent.keyboard(' ');
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
		await userEvent.keyboard(' ');
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		await filter.click();
		await userEvent.keyboard('{Escape}');
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect.element(toggle).toHaveFocus();
		await userEvent.keyboard('{Enter}');
		await expect.element(filter).toHaveValue('treasury');
		expect(element(tree, 'button[aria-current="true"]')).toBe(selected);
		expect(element(target, 'li[aria-current="page"]').title).toBe(path);
	});
});

it('the rail icon tabs switch the navigator and pane between source and changes', async () => {
	await withStudio(1440, 900, async (target) => {
		await page.getByRole('button', { name: 'Changes', exact: true }).click();
		await expect.poll(() => target.querySelector('[data-file-tree]')).toBeNull();
		expect(target.querySelector('button[data-state="open"]')).not.toBeNull();
		await expect
			.element(page.getByRole('button', { name: /Change 1 ·/, exact: false }))
			.toBeVisible();
		await page.getByRole('button', { name: 'Source', exact: true }).click();
		await expect
			.element(page.getByRole('searchbox', { name: 'Filter source files', exact: true }))
			.toBeVisible();
		expect(target.querySelector('[data-file-tree]')).not.toBeNull();
	});
});

it('the phone source toggle opens the navigator sheet and retains its filter and selected file', async () => {
	await withStudio(390, 844, async (target) => {
		const toggle = page.getByRole('button', { name: /navigator$/ });
		const sheet = page.getByRole('dialog', { name: 'Workspace navigator', exact: true });
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
		await toggle.click();
		await expect.element(sheet).toBeVisible();
		const filter = sheet.getByRole('searchbox', { name: 'Filter source files', exact: true });
		await expect.element(filter).toHaveFocus();
		await filter.fill('treasury');
		await userEvent.keyboard('{Escape}');
		await expect.element(sheet).not.toBeInTheDocument();
		await expect.element(toggle).toHaveFocus();
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
		await toggle.click();
		await expect.element(filter).toHaveValue('treasury');
		await sheet.getByRole('button', { name: /src\/data\/model\/treasury\/\+model\.ts/ }).click();
		await expect.element(sheet).not.toBeInTheDocument();
		await expect
			.poll(() => target.querySelector('li[aria-current="page"]')?.getAttribute('title'))
			.toBe(path);
		await toggle.click();
		await expect.element(filter).toHaveValue('treasury');
		await expect
			.element(sheet.getByRole('button', { name: /src\/data\/model\/treasury\/\+model\.ts/ }))
			.toHaveAttribute('aria-current', 'true');
		await expect.element(filter).toHaveFocus();
		await page.viewport(1440, 900);
		await expect.element(sheet).not.toBeInTheDocument();
		await expect.element(toggle).toHaveFocus();
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect
			.element(page.getByRole('searchbox', { name: 'Filter source files', exact: true }))
			.toHaveValue('treasury');
	});
});
