import { expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Finder from '../src/shell/finder/Finder.svelte';
import { recordMentions, type FinderRead } from '../src/shell/finder/model.ts';
import Mentions from './support/record-search.svelte';
import './support/shell.css';

const catalog = {
	customers: {
		record_label: 'record.name',
		label: ['name'],
		search: ['name', 'code'],
		output: 'directory',
		fields: {
			name: { kind: 'text' as const, label: 'Customer name' },
			code: { kind: 'text' as const }
		}
	},
	notes: { record_label: 'record.name', label: ['name'], fields: {} }
};

const nav = [
	{
		kind: 'app' as const,
		name: 'sales',
		title: 'Sales',
		description: '',
		icon: 'lucide:store',
		href: '/app/sales',
		pages: [
			{ name: 'home', title: 'Home', href: '/app/sales' },
			{ name: 'reports', title: 'Reports', href: '/app/sales/reports' }
		]
	}
];

it('Find requires an explicit model, explains search fields and explains unindexed searches', async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mountEdge(runtime);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const requests: Parameters<FinderRead>[0][] = [];
	const opened: string[] = [];
	const read: FinderRead = (request) =>
		Effect.sync(() => {
			requests.push(request);
			return {
				customers: {
					rows: [
						{ id: 'c1', name: 'Acme' },
						{ id: 'c2', name: 'Acme West' }
					]
				}
			};
		});
	const view = mount(Finder, {
		target,
		props: {
			open: true,
			catalog,
			read,
			t: (key: string) => key,
			onAsk: null,
			nav,
			onNavigate: () => {},
			onOpenRecord: (model: string, id: string) => opened.push(`${model}/${id}`)
		}
	});
	try {
		const search = page.getByRole('combobox', { name: 'Find', exact: true });
		await search.fill('/');
		const selected = () => document.querySelector('[data-finder] [aria-selected="true"]');
		await expect.poll(() => selected()?.textContent).toContain('Sales');
		await userEvent.keyboard('{ArrowDown}');
		await expect.poll(() => selected()?.textContent).toContain('customers');
		await userEvent.keyboard('{ArrowDown}');
		await expect.poll(() => selected()?.textContent).toContain('Sales');
		await userEvent.keyboard('{ArrowUp}');
		await expect.poll(() => selected()?.textContent).toContain('customers');
		for (const dark of [false, true]) {
			document.documentElement.classList.toggle('dark', dark);
			await expect
				.poll(() => {
					const button = selected()?.querySelector('button');
					const dialog = document.querySelector('[data-finder]');
					return (
						button &&
						dialog &&
						getComputedStyle(button).backgroundColor !== getComputedStyle(dialog).backgroundColor
					);
				})
				.toBe(true);
		}
		await userEvent.keyboard('{Tab}');
		await expect.element(search).toHaveValue('');
		await expect.element(page.getByRole('button', { name: 'Back to all results' })).toBeVisible();
		await expect.element(search).toHaveFocus();
		expect(document.querySelector('[data-finder-search] [data-search-scope]')).not.toBeNull();
		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(search).toHaveValue('/');
		expect(document.querySelector('[data-finder-branch]')).toBeNull();
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(search).toHaveValue('');
		await userEvent.keyboard('{Backspace}');
		await expect.element(search).toHaveValue('/');
		await search.fill('Acme');
		await expect.element(page.getByRole('status')).toHaveTextContent('Nothing found.');
		expect(requests).toEqual([]);
		await search.fill('cust');
		await userEvent.keyboard('{Enter}');
		await expect.element(search).toHaveValue('');
		expect(document.querySelector('[data-search-scope]')?.textContent).toContain('customers');
		expect(requests).toEqual([]);
		await search.fill('/customers Acme');
		await expect.element(page.getByRole('button', { name: 'Acme customers' })).toBeVisible();
		await userEvent.keyboard('{ArrowUp}');
		await expect.poll(() => selected()?.textContent).toContain('Acme West');
		await userEvent.keyboard('{ArrowDown}');
		await expect.poll(() => selected()?.textContent?.trim()).toBe('Acme customers');
		expect(document.getElementById('shell-finder-scope-description')?.textContent).toContain(
			'Search by Customer name, code.'
		);
		expect(requests).toEqual([
			{ customers: { search: 'Acme', limit: 8, output: 'directory', fields: ['name'] } }
		]);
		await search.fill('/notes Acme');
		await expect.element(search).toBeEnabled();
		await expect.element(page.getByText(/Search is not enabled for this model/)).toBeVisible();
		expect(requests).toHaveLength(1);
		await page.getByRole('button', { name: 'Back to all results' }).click();
		await search.fill('/unknown Acme');
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('Scope not found. Search by name or go back to all results.');
		expect(requests).toHaveLength(1);
		await search.fill('/customers Acme');
		await page.getByRole('button', { name: 'Acme customers' }).click();
		expect(opened).toEqual(['customers/c1']);
	} finally {
		document.documentElement.classList.remove('dark');
		await unmount(view);
		await dispose();
		target.remove();
	}
});

it('Norbius slash and @ share scopes, skip unavailable models and insert scoped records or apps', async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mountEdge(runtime);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const requests: Parameters<FinderRead>[0][] = [];
	const read: FinderRead = (request) =>
		Effect.sync(() => {
			requests.push(request);
			return {
				customers: {
					rows: [
						{ id: 'c1', name: 'Acme' },
						{ id: 'c2', name: 'Acme West' }
					]
				}
			};
		});
	const view = mount(Mentions, {
		target,
		props: {
			mentions: (query: string) =>
				recordMentions(catalog, read, query, (key) => key, {
					nav
				}),
			commands: (query: string) =>
				recordMentions(catalog, read, query, (key) => key, { prefix: '/', nav })
		}
	});
	try {
		const input = page.getByRole('textbox', { name: 'Message', exact: true });
		const selected = () => document.querySelector('[data-command-menu] [aria-selected="true"]');
		for (const prefix of ['/', '@']) {
			await input.fill(prefix);
			await expect.poll(() => selected()?.textContent).toContain('Sales');
			await userEvent.keyboard('{ArrowDown}');
			await expect.poll(() => selected()?.textContent).toContain('customers');
			await userEvent.keyboard('{ArrowDown}');
			await expect.poll(() => selected()?.textContent).toContain('notes');
			await userEvent.keyboard('{ArrowUp}');
			await expect.poll(() => selected()?.textContent).toContain('customers');
			await userEvent.keyboard('{Tab}');
			await expect.element(input).toHaveValue('/customers ');
			await expect.element(input).toHaveFocus();
			await userEvent.keyboard('{ArrowLeft}');
			await expect.element(input).toHaveValue('/');
		}
		await input.fill('@');
		await expect.element(page.getByRole('button', { name: /notes/ })).toBeEnabled();
		await expect.element(page.getByText('Model · Search by Customer name, code.')).toBeVisible();
		expect(requests).toEqual([]);
		await input.fill('@cust');
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('[@customers](/?find=customers) ');
		expect(requests).toEqual([]);
		await input.fill('@notes');
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('[@notes](/?find=notes) ');
		expect(requests).toEqual([]);
		await input.fill('/customers Acme');
		await expect.element(page.getByRole('button', { name: 'Acme', exact: true })).toBeVisible();
		await userEvent.keyboard('{ArrowDown}');
		await expect.poll(() => selected()?.textContent?.trim()).toBe('Acme West');
		await userEvent.keyboard('{ArrowUp}');
		await expect.poll(() => selected()?.textContent?.trim()).toBe('Acme');
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('[@Acme](customers/c1) ');
		expect(requests).toEqual([
			{ customers: { search: 'Acme', limit: 8, output: 'directory', fields: ['name'] } }
		]);
		await input.fill('@sales');
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('[@Sales](/app/sales) ');
		expect(requests).toHaveLength(1);
		await input.fill('@sales');
		await userEvent.keyboard('{ArrowRight}');
		await expect.element(input).toHaveValue('/sales ');
		await expect.element(page.getByRole('button', { name: 'Reports', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Reports', exact: true }).click();
		await expect.element(input).toHaveValue('[@Reports](/app/sales/reports) ');
		await input.fill('/customers Acme');
		await expect.element(page.getByRole('button', { name: 'Acme', exact: true })).toBeVisible();
		await userEvent.keyboard('{Escape}');
		await expect.element(input).toHaveValue('/');
		await input.fill('/customers Acme & Sons');
		await expect.element(page.getByRole('button', { name: 'Acme', exact: true })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('[@Acme](customers/c1) ');
		expect(requests.at(-1)).toEqual({
			customers: { search: 'Acme & Sons', limit: 8, output: 'directory', fields: ['name'] }
		});
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});

it('Find searches manifest names directly and drills apps into named pages without slash syntax', async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mountEdge(runtime);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const navigated: string[] = [];
	const view = mount(Finder, {
		target,
		props: {
			open: true,
			nav,
			catalog,
			read: () => Effect.die('Unscoped search must never query records'),
			t: (key: string) => key,
			entries: [
				{
					kind: 'automation',
					name: 'manufacturing_pipeline',
					description: 'Prepare production',
					href: '/command-center/automations?automation=manufacturing_pipeline'
				}
			],
			onAsk: null,
			onNavigate: (href: string) => navigated.push(href),
			onOpenRecord: () => {}
		}
	});
	try {
		const input = page.getByRole('combobox', { name: 'Find', exact: true });
		await input.fill('manufacturing pipeline');
		await expect
			.element(page.getByRole('button', { name: /manufacturing pipeline/ }))
			.toBeVisible();
		await input.fill('Reports');
		await expect
			.element(page.getByRole('button', { name: 'Reports Sales', exact: true }))
			.toBeVisible();
		await input.fill('Sales');
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('');
		expect(document.querySelector('[data-search-scope]')?.textContent).toContain('Sales');
		await expect
			.element(page.getByRole('button', { name: 'Reports Sales', exact: true }))
			.toBeVisible();
		await userEvent.keyboard('{Escape}');
		await expect.element(input).toHaveValue('Sales');
		await expect.element(input).toHaveFocus();
		await userEvent.keyboard('{Enter}');
		await page.getByRole('button', { name: 'Reports Sales', exact: true }).click();
		expect(navigated).toEqual(['/app/sales/reports']);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});

it('Norbius keeps multiword name lookup global and consumes Enter while scoped records load', async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const dispose = mountEdge(runtime);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const pending: (() => void)[] = [];
	let sends = 0;
	const read: FinderRead = () =>
		Effect.callback((resume) => {
			pending.push(() =>
				resume(Effect.succeed({ customers: { rows: [{ id: 'c1', name: 'Acme' }] } }))
			);
		});
	const view = mount(Mentions, {
		target,
		props: {
			mentions: (query: string) => recordMentions(catalog, read, query, (key) => key, { nav }),
			commands: (query: string) =>
				recordMentions(catalog, read, query, (key) => key, { nav, prefix: '/' }),
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === 'Enter') sends++;
			}
		}
	});
	try {
		const input = page.getByRole('textbox', { name: 'Message', exact: true });
		await input.fill('@customers Acme');
		await expect.element(page.getByRole('status')).toHaveTextContent('No results');
		expect(pending).toHaveLength(0);
		await input.fill('Discuss @cust');
		await expect.element(page.getByRole('button', { name: /customers.*Model/ })).toBeVisible();
		await userEvent.keyboard('{Tab}');
		await expect.element(input).toHaveValue('Discuss /customers ');
		await input.fill('Discuss /customers Acme');
		await expect.element(page.getByRole('status')).toHaveTextContent('Searching…');
		await userEvent.keyboard('{Enter}');
		expect(sends).toBe(0);
		pending.shift()?.();
		await expect.element(page.getByRole('button', { name: 'Acme', exact: true })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		await expect.element(input).toHaveValue('Discuss [@Acme](customers/c1) ');
		expect(sends).toBe(0);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
});
