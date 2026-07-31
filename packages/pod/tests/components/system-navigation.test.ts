import { describe, expect, it } from 'vitest';
import { WorkspaceSidebarNavigationSection } from '@norbital-ai/ui/workspace-shell';
import {
	buildSystemNavigation,
	hostAuthorizesAgentSurface,
	isHostPluginEntry
} from '$lib/runtime/workspace-navigation.js';
import SidebarHarness from '../support/sidebar-harness.svelte';
import { render } from '../support/component.js';

const PLUGINS = [
	{ key: 'studio', label: 'Workspace Studio', icon: null, entry: '/studio', adminOnly: true },
	{ key: 'help', label: 'Help centre', icon: null, entry: '/help' }
];

/**
 * The sidebar as the shell builds it.
 *
 * `pod-shell.svelte` hands `buildSystemNavigation`'s output straight to the shell's navigation model
 * as `model.system`, and the shell renders each section through this component. Mounting the section
 * with the real output is what makes the filtering below a claim about what a person sees, rather
 * than about the shape of an array.
 */
function mountSidebar(input: Parameters<typeof buildSystemNavigation>[0]): {
	container: HTMLElement;
	destroy(): void;
} {
	return render(
		SidebarHarness as never,
		{
			component: WorkspaceSidebarNavigationSection,
			props: { label: 'System', items: buildSystemNavigation(input), open: true }
		} as never
	);
}

function links(container: HTMLElement): { label: string; href: string; current: boolean }[] {
	return [...container.querySelectorAll('a')].map((node) => ({
		label: node.textContent?.trim() ?? '',
		href: node.getAttribute('href') ?? '',
		current: node.getAttribute('aria-current') === 'page'
	}));
}

describe('the system section of the sidebar', () => {
	it('keeps host entries outside Pod SPA navigation', () => {
		expect(isHostPluginEntry('/studio', PLUGINS)).toBe(true);
		expect(isHostPluginEntry('/help', PLUGINS)).toBe(true);
		expect(isHostPluginEntry('/settings', PLUGINS)).toBe(false);
		expect(isHostPluginEntry('/app/crm', PLUGINS)).toBe(false);
	});

	it('renders the Pod agent route only for the exact host registration', () => {
		expect(
			hostAuthorizesAgentSurface('/agent', [
				{ key: 'agent', entry: '/agent' },
				{ key: 'studio', entry: '/_host/app/workspace-studio' }
			])
		).toBe(true);
		expect(hostAuthorizesAgentSurface('/agent', [])).toBe(false);
		expect(
			hostAuthorizesAgentSurface('/agent', [{ key: 'agent', entry: '/_host/app/agent' }])
		).toBe(false);
		expect(hostAuthorizesAgentSurface('/agent', [{ key: 'other', entry: '/agent' }])).toBe(false);
	});

	it('never puts an admin-only surface in front of a non-admin', () => {
		const { container, destroy } = mountSidebar({
			plugins: PLUGINS,
			isAdmin: false,
			currentPath: '/'
		});

		// Not merely unhighlighted: the entry, and with it the host URL, is absent from the markup.
		// Settings is admin-only too, so it is not here either.
		expect(links(container)).toEqual([{ label: 'Help centre', href: '/help', current: false }]);
		expect(container.innerHTML).not.toContain('/studio');
		expect(container.innerHTML).not.toContain('/settings');
		destroy();
	});

	it('gives an admin the pod’s own settings entry and every surface the host declared', () => {
		const { container, destroy } = mountSidebar({
			plugins: PLUGINS,
			isAdmin: true,
			currentPath: '/'
		});

		expect(links(container).map((link) => link.label)).toEqual([
			'Settings',
			'Workspace Studio',
			'Help centre'
		]);
		destroy();
	});

	const siblings = [
		{ key: 'studio', label: 'Workspace Studio', icon: null, entry: '/studio' },
		{ key: 'archive', label: 'Studio Archive', icon: null, entry: '/studio-archive' }
	];

	it('renders the settings entry a standalone pod is administered through', () => {
		// The case the entry exists for: no host, so no plugins, and this is the only thing in the
		// section. Sourcing it from `hostPlugins` would have left `pod start` with no way in.
		const { container, destroy } = mountSidebar({
			plugins: [],
			isAdmin: true,
			currentPath: '/settings'
		});

		expect(links(container)).toEqual([{ label: 'Settings', href: '/settings', current: true }]);
		destroy();
	});

	it('marks the entry the current path is inside, and only that one', () => {
		const nested = mountSidebar({
			plugins: siblings,
			isAdmin: false,
			currentPath: '/studio/collections'
		});
		// A nested host route keeps its entry current, and `aria-current` is the whole of what says so
		// to a screen reader.
		expect(links(nested.container)).toEqual([
			{ label: 'Workspace Studio', href: '/studio', current: true },
			{ label: 'Studio Archive', href: '/studio-archive', current: false }
		]);
		nested.destroy();

		// The other direction is the one a plain prefix test gets wrong: `/studio-archive` starts with
		// `/studio` and is a different surface entirely, so the shorter entry must not claim it.
		const sibling = mountSidebar({
			plugins: siblings,
			isAdmin: false,
			currentPath: '/studio-archive'
		});
		expect(links(sibling.container)).toEqual([
			{ label: 'Workspace Studio', href: '/studio', current: false },
			{ label: 'Studio Archive', href: '/studio-archive', current: true }
		]);
		sibling.destroy();
	});

	it('renders nothing at all for a member of a workspace with no host surfaces', () => {
		const { container, destroy } = mountSidebar({ plugins: [], isAdmin: false, currentPath: '/' });

		// Not an empty group with a heading over it: with nothing this person may open, the section
		// should show no sign that it exists.
		expect(container.textContent?.trim()).toBe('');
		expect(container.querySelector('a')).toBeNull();
		destroy();
	});
});
