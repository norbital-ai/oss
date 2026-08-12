import { describe, expect, it } from 'vitest';
import { WorkspaceSidebarNavigationSection } from '@norbital-ai/ui/workspace-shell';
import {
	buildSystemNavigation,
	hostPluginSurfaceHref,
	isHostPluginEntry,
	resolveBillingSettingsHref,
	resolveHostPluginSurface,
	workspaceAuthorizesAgentSurface,
	workspaceProvidesAgentSurface
} from '$lib/ui/shell/workspace-navigation.js';
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
		label:
			node.querySelector<HTMLElement>('[data-navigation-label]')?.textContent?.trim() ??
			node.textContent?.trim() ??
			'',
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

	it('mounts a trusted host entry inside the tenant shell route', () => {
		expect(hostPluginSurfaceHref('studio')).toBe('/__host/studio');
		expect(resolveHostPluginSurface('/__host/studio', PLUGINS)).toMatchObject({
			key: 'studio',
			entry: '/studio'
		});
		expect(resolveHostPluginSurface('/studio', PLUGINS)).toBeNull();
	});

	it('provides the safe Pod agent surface without a host or authored profile', () => {
		expect(workspaceAuthorizesAgentSurface('/agent')).toBe(true);
		expect(workspaceAuthorizesAgentSurface('/app/hr')).toBe(false);
		expect(workspaceProvidesAgentSurface()).toBe(true);
	});

	it('never puts an admin-only surface in front of a non-admin', () => {
		const { container, destroy } = mountSidebar({
			plugins: PLUGINS,
			isAdmin: false,
			currentPath: '/'
		});

		// Not merely unhighlighted: the entry, and with it the host URL, is absent from the markup.
		// Settings is admin-only too, so it is not here either.
		expect(links(container)).toEqual([
			{ label: 'Help centre', href: '/__host/help', current: false }
		]);
		expect(container.innerHTML).not.toContain('/__host/studio');
		expect(container.innerHTML).not.toContain('/settings');
		destroy();
	});

	it('gives an admin the pod’s own settings entry and every surface the host declared', () => {
		const { container, destroy } = mountSidebar({
			plugins: PLUGINS,
			isAdmin: true,
			currentPath: '/'
		});

		expect(links(container).map((link) => link.label)).toEqual(['Workspace Studio', 'Help centre']);
		expect(container.textContent).toContain('Settings');
		destroy();
	});

	it('groups each host-owned setting as a distinct child beside the pod’s own', () => {
		// One host-owned settings child, not three. The three org-scoped forms Core used to list
		// separately are tabs of a single surface now, so this asserts the general shape — a
		// `placement: settings` plugin becomes a child of Settings, badged, alongside Pod's own — on
		// two children rather than four. A host declaring several still gets several.
		const { container, destroy } = mountSidebar({
			plugins: [
				{
					key: 'workspace-studio',
					label: 'Workspace Studio',
					icon: null,
					entry: '/_host/app/workspace-studio',
					placement: 'sidebar',
					adminOnly: true
				},
				{
					key: 'core-organization',
					label: 'Organization',
					icon: null,
					entry: '/_host/app/core-organization',
					placement: 'settings',
					adminOnly: true
				}
			],
			isAdmin: true,
			currentPath: '/__host/core-organization'
		});

		expect(links(container)).toEqual([
			{ label: 'People', href: '/settings', current: false },
			{ label: 'Organization', href: '/__host/core-organization', current: true },
			{ label: 'Workspace Studio', href: '/__host/workspace-studio', current: false }
		]);
		expect(container.querySelectorAll('[data-navigation-badge="Core"]')).toHaveLength(1);
		// The badge trails the label it annotates, so the label is the element that gives up room when
		// the row runs short. Asserting the order keeps that honest without pinning utility classes.
		for (const badge of container.querySelectorAll('[data-navigation-badge="Core"]')) {
			expect(badge.textContent?.trim()).toBe('Core');
			expect(badge.previousElementSibling?.hasAttribute('data-navigation-label')).toBe(true);
		}
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

		expect(links(container)).toEqual([{ label: 'People', href: '/settings', current: true }]);
		destroy();
	});

	it('points the trial banner at the billing tab, and nowhere when the host has none', () => {
		// The tab is the whole value of the deep link: the shell forwards this query string into the
		// host frame, so dropping it lands an admin who clicked "Add payment method" on the host
		// surface's default tab instead of the one holding the payment form.
		expect(resolveBillingSettingsHref([{ key: 'core-organization' }])).toBe(
			'/__host/core-organization?tab=billing'
		);
		expect(resolveBillingSettingsHref([{ key: 'workspace-studio' }])).toBeNull();
		expect(resolveBillingSettingsHref([])).toBeNull();
	});

	it('marks the entry the current path is inside, and only that one', () => {
		const nested = mountSidebar({
			plugins: siblings,
			isAdmin: false,
			currentPath: '/__host/studio'
		});
		// A nested host route keeps its entry current, and `aria-current` is the whole of what says so
		// to a screen reader.
		expect(links(nested.container)).toEqual([
			{ label: 'Workspace Studio', href: '/__host/studio', current: true },
			{ label: 'Studio Archive', href: '/__host/archive', current: false }
		]);
		nested.destroy();

		// The other direction is the one a plain prefix test gets wrong: `/studio-archive` starts with
		// `/studio` and is a different surface entirely, so the shorter entry must not claim it.
		const sibling = mountSidebar({
			plugins: siblings,
			isAdmin: false,
			currentPath: '/__host/archive'
		});
		expect(links(sibling.container)).toEqual([
			{ label: 'Workspace Studio', href: '/__host/studio', current: false },
			{ label: 'Studio Archive', href: '/__host/archive', current: true }
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

	it('can make an application section label a link to its directory', () => {
		const { container, destroy } = render(
			SidebarHarness as never,
			{
				component: WorkspaceSidebarNavigationSection,
				props: {
					label: 'Applications',
					href: '/',
					open: true,
					items: [
						{
							key: 'hr',
							label: 'HR',
							icon: 'lucide:briefcase-business',
							href: '/app/hr',
							active: false
						}
					]
				}
			} as never
		);

		const sectionLink = [...container.querySelectorAll('a')].find(
			(link) => link.textContent?.trim() === 'Applications'
		);
		expect(sectionLink?.getAttribute('href')).toBe('/');
		expect(container.textContent).not.toContain('All applications');
		destroy();
	});
});
