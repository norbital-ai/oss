import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LatestQuery } from '../../src/client/ui/state/platform.js';

describe('shell query state', () => {
	it('drops stale finder results after a newer query starts', async () => {
		const latest = new LatestQuery<string>();
		let finishFirst: ((value: string) => void) | undefined;
		const first = latest.run(
			() =>
				new Promise((resolve) => {
					finishFirst = resolve;
				})
		);
		const second = latest.run(() => Promise.resolve('new'));
		finishFirst?.('old');
		expect(await second).toBe('new');
		expect(await first).toBeUndefined();
	});
});

describe('shell record navigation ownership', () => {
	it('provides URL navigation to workspace settings and host-plugin tables', () => {
		const source = readFileSync(
			new URL('../../src/client/ui/shell/shell.svelte', import.meta.url),
			'utf8'
		);
		const settingsBranch = source.slice(
			source.indexOf('{:else if currentPath === WORKSPACE_SETTINGS_PATH'),
			source.indexOf('{:else}', source.indexOf('{:else if currentPath === WORKSPACE_SETTINGS_PATH'))
		);

		expect(settingsBranch).toContain('<CollectionTableNavigationSurface');
		expect(settingsBranch).toContain('url={detailUrl}');
		expect(settingsBranch).toContain('navigate={(href) => onNavigate?.(href)}');
		expect(settingsBranch.indexOf('<CollectionTableNavigationSurface')).toBeLessThan(
			settingsBranch.indexOf('{@render children?.()}')
		);
		expect(settingsBranch.indexOf('{@render children?.()}')).toBeLessThan(
			settingsBranch.indexOf('</CollectionTableNavigationSurface>')
		);
	});
});

describe('Studio Preview', () => {
	it('opens an exact reviewed Preview and performs a full reload into its host route', () => {
		const source = readFileSync(
			new URL('../../src/client/ui/studio/studio-shell.svelte', import.meta.url),
			'utf8'
		);
		expect(source).toContain("{ action: 'preview', operation: 'review', requestId }");
		expect(source).toContain("{ action: 'preview', operation: 'build' }");
		expect(source).toContain('window.location.reload()');
		expect(source).not.toMatch(/action:\s*['"]preview['"],\s*releaseId/);
	});
});
