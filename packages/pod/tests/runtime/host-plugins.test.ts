import { describe, expect, it } from 'vitest';
import { assertHostPlugins } from '../../src/lib/host/types.js';
import { buildSystemNavigation } from '../../src/lib/runtime/workspace-navigation.js';
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

	it('shows every surface to an admin', () => {
		const items = buildSystemNavigation({
			plugins: [{ key: 'studio', label: 'Studio', icon: null, entry: '/studio', adminOnly: true }],
			isAdmin: true,
			currentPath: '/'
		});
		expect(items.map((item) => item.key)).toEqual(['studio']);
	});

	/** A nested host route keeps its sidebar entry highlighted; a sibling prefix must not steal it. */
	it.each([
		['/studio', true],
		['/studio/collections', true],
		['/studio-archive', false],
		['/', false]
	])('marks %s active=%s', (currentPath, active) => {
		const [item] = buildSystemNavigation({
			plugins: [{ key: 'studio', label: 'Studio', icon: null, entry: '/studio' }],
			isAdmin: true,
			currentPath
		});
		expect(item.active).toBe(active);
	});
});
