import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Nav from '../src/shell/Nav.svelte';
import type { NavModel } from '../src/shell/model.ts';
import './support/shell.css';

it('a preview shows application modules without account, search or workspace controls', async () => {
	const model: NavModel = {
		workspace: {
			name: 'Preview',
			handle: 'preview',
			logo: null,
			others: [{ handle: 'other', name: 'Other workspace', href: 'https://other.test' }]
		},
		user: { name: 'Admin', email: 'admin@example.test', role: 'Administrator' },
		sections: [
			{
				key: 'operations',
				label: 'Operations',
				items: [{ key: 'norbius', label: 'Norbius', icon: null, href: '#norbius', active: false }]
			},
			{
				key: 'applications',
				label: 'Applications',
				items: [{ key: 'sales', label: 'Sales', icon: null, href: '/app/sales', active: false }]
			}
		],
		utilities: [
			{
				key: 'settings',
				label: 'Settings',
				icon: null,
				href: '/settings/organization',
				active: false
			}
		]
	};
	const target = document.body.appendChild(document.createElement('div'));
	target.style.height = '700px';
	const visited: string[] = [];
	const view = mount(Nav, {
		target,
		props: {
			model,
			app_only: true,
			t: (key: string) => key,
			on_navigate: (href: string) => visited.push(href),
			on_sign_out: () => Effect.void,
			on_search: () => {}
		}
	});
	try {
		await expect.element(page.getByText('Sales', { exact: true })).toBeVisible();
		await expect.element(page.getByText('Norbius', { exact: true })).not.toBeInTheDocument();
		await expect.element(page.getByText('Settings', { exact: true })).not.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Open account menu' }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'More', exact: true }))
			.not.toBeInTheDocument();
		expect(target.querySelector('[data-testid="workspace-omni-trigger"]')).toBeNull();
		expect(target.querySelector('[role="combobox"]')).toBeNull();
		await page.getByText('Sales', { exact: true }).click();
		expect(visited).toEqual(['/app/sales']);
	} finally {
		await unmount(view);
		target.remove();
	}
});
