import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createPodCollectionTableNavigation } from '../../src/ui/collection/collection-table-navigation.js';
import { DetailSurfaceService } from '../../src/ui/subservices/detail_surface.service.js';

const omniFinderUrl = new URL('../../src/ui/shell/omni-finder.svelte', import.meta.url);
const podShellUrl = new URL('../../src/ui/shell/pod-shell.svelte', import.meta.url);
const fallbackUrl = new URL(
	'../../src/ui/collection/collection-record-detail-fallback.svelte',
	import.meta.url
);

describe('omni finder record open', () => {
	it('opens a sidesheet without any collection-table registration', () => {
		const navigate = vi.fn();
		const navigation = new DetailSurfaceService({ navigateInternal: navigate });
		const tableNav = createPodCollectionTableNavigation({
			getCurrentUrl: () => new URL('https://example.test/app/overview'),
			getCurrentStack: () => [],
			navigation
		});

		tableNav.open({
			collectionName: 'employees',
			recordId: 'emp-1',
			routeKey: 'employees'
		});

		expect(navigate).toHaveBeenCalledOnce();
		const href = String(navigate.mock.calls[0]?.[0]);
		const url = new URL(href, 'https://example.test');
		const parsed = JSON.parse(url.searchParams.get('stack') ?? '{}') as {
			stack: Array<{
				collection_name: string;
				record_id: string;
				node_id: string;
				viewMode: string;
			}>;
		};
		expect(parsed.stack).toEqual([
			{
				collection_name: 'employees',
				record_id: 'emp-1',
				node_id: 'employees',
				viewMode: 'sidesheet'
			}
		]);
		expect(navigation.resolve('employees')).toBeUndefined();
	});

	it('wires the finder to the shell fallback instead of a mounted table', async () => {
		const [omniFinder, podShell, fallback] = await Promise.all([
			readFile(omniFinderUrl, 'utf8'),
			readFile(podShellUrl, 'utf8'),
			readFile(fallbackUrl, 'utf8')
		]);

		expect(omniFinder).toContain('onOpenRecord');
		expect(omniFinder).toContain("entity.kind");
		expect(omniFinder).toContain('onOpenRecord({ collectionName: entity.collection, recordId: entity.recordId })');
		expect(omniFinder).toContain('FinderPalette');
		expect(omniFinder).not.toContain('getCollectionTableNavigationContext');
		expect(podShell).toContain('onOpenRecord={(target) => {');
		expect(podShell).toContain('recordNavigation.open({');
		expect(podShell).toContain('routeKey: target.collectionName');
		expect(podShell).toContain('unresolvedFallback={platformDetailFallback}');
		expect(fallback).toContain('CollectionForm');
		expect(fallback).toContain('getCollectionClientContext()');
		expect(fallback).toContain('workspaceClient.db[collectionName]');
	});
});
