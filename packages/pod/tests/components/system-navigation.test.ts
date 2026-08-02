import { describe, expect, it } from 'vitest';
import { WorkspaceSidebarNavigationSection } from '@norbital-ai/ui/workspace-shell';
import {
	buildSystemNavigation,
	hostPluginSurfaceHref,
	isHostPluginEntry,
	resolveHostPluginSurface,
	workspaceAuthorizesAgentSurface,
	workspaceProvidesAgentSurface
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

	it('mounts a trusted host entry inside the tenant shell route', () => {
		expect(hostPluginSurfaceHref('studio')).toBe('/__host/studio');
		expect(resolveHostPluginSurface('/__host/studio', PLUGINS)).toMatchObject({
			key: 'studio',
			entry: '/studio'
		});
		expect(resolveHostPluginSurface('/studio', PLUGINS)).toBeNull();
	});

	it('renders the Pod agent route from the workspace manifest without a host registration', () => {
		const agent = { kind: 'agent' as const };
		expect(workspaceAuthorizesAgentSurface('/agent', agent)).toBe(true);
		expect(workspaceAuthorizesAgentSurface('/agent', undefined)).toBe(false);
		expect(workspaceAuthorizesAgentSurface('/app/hr', agent)).toBe(false);
		expect(workspaceProvidesAgentSurface(agent)).toBe(true);
		expect(workspaceProvidesAgentSurface(undefined)).toBe(false);
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
});
