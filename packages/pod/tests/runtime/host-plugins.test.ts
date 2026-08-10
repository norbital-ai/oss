import { describe, expect, it } from 'vitest';
import { assertHostPlugins } from '../../src/host/types.js';
import { visibleHostPlugins } from '../../src/server/host-plugins.js';
import {
	buildSystemNavigation,
	buildUtilityNavigation
} from '../../src/ui/shell/workspace-navigation.js';
import type { HostAppPlugin } from '@norbital-ai/platform-utils/runtime/binding';

function plugin(overrides: Partial<HostAppPlugin> = {}): HostAppPlugin {
	return {
		key: 'studio',
		label: 'Workspace Studio',
		icon: null,
		entry: '/studio',
		placement: 'sidebar',
		...overrides
	};
}

describe('assertHostPlugins', () => {
	it('accepts a site-relative path and an https URL', () => {
		expect(() =>
			assertHostPlugins([
				plugin(),
				plugin({ key: 'settings', entry: 'https://core.norbital.ai/org' })
			])
		).not.toThrow();
	});

	it('accepts host facilities nested under Pod settings', () => {
		expect(() => assertHostPlugins([plugin({ placement: 'settings' })])).not.toThrow();
	});

	it('accepts account-adjacent footer tools', () => {
		expect(() => assertHostPlugins([plugin({ placement: 'footer' })])).not.toThrow();
	});

	/**
	 * The shell renders `entry` straight into an href, so a `javascript:` entry would be script
	 * injection into every session of the workspace. Rejecting it at startup is what keeps a
	 * misconfigured host from becoming an XSS vector, and the scheme allowlist is the check that
	 * matters — enumerating bad schemes would miss the next one.
	 */
	it.each([
		['javascript:alert(1)', 'script injection'],
		['data:text/html,<script>alert(1)</script>', 'inline document'],
		['http://core.norbital.ai/org', 'cleartext'],
		['//evil.example.com/studio', 'protocol-relative host swap']
	])('rejects %s (%s)', (entry) => {
		expect(() => assertHostPlugins([plugin({ entry })])).toThrow(/unsupported entry/);
	});

	it('rejects a duplicate key, which would render two entries claiming the same identity', () => {
		expect(() => assertHostPlugins([plugin(), plugin({ label: 'Other' })])).toThrow(/Duplicate/);
	});

	it('rejects an empty key', () => {
		expect(() => assertHostPlugins([plugin({ key: '  ' })])).toThrow(/must not be empty/);
	});
});

describe('visibleHostPlugins', () => {
	it('preserves Settings placement while removing server-only authorization metadata', () => {
		expect(
			visibleHostPlugins(
				[
					plugin({
						key: 'core-organization',
						placement: 'settings',
						adminOnly: true
					})
				],
				true
			)
		).toEqual([
			{
				key: 'core-organization',
				label: 'Workspace Studio',
				icon: null,
				entry: '/studio',
				placement: 'settings'
			}
		]);
	});

	it('does not project an admin-only surface to a member', () => {
		expect(visibleHostPlugins([plugin({ adminOnly: true })], false)).toEqual([]);
	});
});

describe('buildSystemNavigation', () => {
	it('hides an admin-only surface from a non-admin', () => {
		const items = buildSystemNavigation({
			plugins: [
				{ key: 'studio', label: 'Studio', icon: null, entry: '/studio', adminOnly: true },
				{ key: 'help', label: 'Help', icon: null, entry: '/help' }
			],
			isAdmin: false,
			currentPath: '/'
		});
		expect(items.map((item) => item.key)).toEqual(['help']);
	});

	it('shows every surface to an admin, with the pod’s own first', () => {
		const items = buildSystemNavigation({
			plugins: [{ key: 'studio', label: 'Studio', icon: null, entry: '/studio', adminOnly: true }],
			isAdmin: true,
			currentPath: '/'
		});
		expect(items.map((item) => item.key)).toEqual(['settings', 'studio']);
		expect(items[0]?.children?.map((item) => item.key)).toEqual(['pod-settings']);
	});

	/**
	 * The case the whole surface exists for: a workspace on `pod start` has no host, so an entry that
	 * came from `hostPlugins` would not be there at all and nobody could administer the workspace.
	 */
	it('gives an admin its settings entry with no host plugins at all', () => {
		expect(
			buildSystemNavigation({ plugins: [], isAdmin: true, currentPath: '/' }).map((item) => ({
				key: item.key,
				href: item.href
			}))
		).toEqual([{ key: 'settings', href: '/settings' }]);
		// And it is admin-only, in the sidebar as well as in the endpoints behind it.
		expect(buildSystemNavigation({ plugins: [], isAdmin: false, currentPath: '/' })).toEqual([]);
	});

	it('groups host-owned settings beneath the Pod-owned settings folder', () => {
		const items = buildSystemNavigation({
			plugins: [
				{
					key: 'core-services',
					label: 'Core services',
					icon: null,
					entry: '/core-services',
					placement: 'settings',
					adminOnly: true
				},
				{ key: 'studio', label: 'Studio', icon: null, entry: '/studio' }
			],
			isAdmin: true,
			currentPath: '/__host/core-services'
		});
		expect(items.map((item) => item.key)).toEqual(['settings', 'studio']);
		expect(items[0]).toMatchObject({ key: 'settings', active: true });
		expect(items[0]?.children?.map((item) => item.key)).toEqual(['pod-settings', 'core-services']);
		expect(items[0]?.children?.find((item) => item.key === 'core-services')?.badge).toBe('Core');
	});

	/** A nested host route keeps its sidebar entry highlighted; a sibling prefix must not steal it. */
	it.each([
		['/__host/studio', true],
		['/__host/studio/collections', true],
		['/__host/studio-archive', false],
		['/', false]
	])('marks %s active=%s', (currentPath, active) => {
		const item = buildSystemNavigation({
			plugins: [{ key: 'studio', label: 'Studio', icon: null, entry: '/studio' }],
			isAdmin: true,
			currentPath
		}).find((entry) => entry.key === 'studio');
		expect(item?.active).toBe(active);
	});
});

describe('buildUtilityNavigation', () => {
	it('keeps an admin-only footer tool out of system navigation and exposes it to admins only', () => {
		const plugins = [
			{
				key: 'impersonation',
				label: 'Impersonate',
				icon: 'lucide:eye',
				entry: '/_host/app/impersonation',
				placement: 'footer' as const,
				adminOnly: true
			}
		];
		expect(buildSystemNavigation({ plugins, isAdmin: true, currentPath: '/' })).not.toContainEqual(
			expect.objectContaining({ key: 'impersonation' })
		);
		expect(buildUtilityNavigation({ plugins, isAdmin: false, currentPath: '/' })).toEqual([]);
		expect(
			buildUtilityNavigation({ plugins, isAdmin: true, currentPath: '/__host/impersonation' })
		).toEqual([
			expect.objectContaining({ key: 'impersonation', label: 'Impersonate', active: true })
		]);
	});
});
