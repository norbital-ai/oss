import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { CollectionNavigationTarget } from '@norbital-ai/ui/collection-navigation';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';

const collectionKanban = fileURLToPath(
	new URL('../../../ui/build/collection-kanban/collection-kanban.svelte', import.meta.url)
);
const navigationConsumer = 'virtual:ui-collection-navigation-consumer';

describe('UI package consumer', () => {
	it('exposes the canonical collection-navigation runtime and type surface', async () => {
		const target: CollectionNavigationTarget = {
			collectionName: 'payslip_lines',
			recordId: 'line-1',
			routeKey: 'repayment-consumption:line-1'
		};
		const output = await build({
			configFile: false,
			logLevel: 'silent',
			plugins: [
				{
					name: 'ui-collection-navigation-consumer',
					resolveId: (source) => (source === navigationConsumer ? `\0${navigationConsumer}` : null),
					load: (id) =>
						id === `\0${navigationConsumer}`
							? `export { getCollectionNavigationContext } from '@norbital-ai/ui/collection-navigation';`
							: null
				}
			],
			build: {
				write: false,
				rollupOptions: {
					input: navigationConsumer,
					external(source, importer) {
						const canonicalNavigation =
							source === '@norbital-ai/ui/collection-navigation' ||
							source === './collection-navigation.svelte.js' ||
							source.endsWith('/collection-navigation/index.js') ||
							source.endsWith('/collection-navigation/collection-navigation.svelte.js');
						return importer !== undefined && !canonicalNavigation;
					}
				}
			}
		});

		expect(output).toBeDefined();
		expect(target.collectionName).toBe('payslip_lines');
	});

	it('resolves private imports from the emitted CollectionKanban artifact', async () => {
		const output = await build({
			configFile: false,
			logLevel: 'silent',
			plugins: [svelte()],
			build: {
				write: false,
				rollupOptions: {
					input: collectionKanban,
					external(source, importer) {
						const collectionNavigation =
							source.startsWith('#lib/collection-navigation/') ||
							source.includes('/collection-navigation/collection-navigation.svelte.js');
						return importer !== undefined && !collectionNavigation;
					}
				}
			}
		});

		expect(output).toBeDefined();
	});
});
