import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeBoltAgentMessages } from '../../src/client/ui/agent/i18n.js';

const catalogs = mergeBoltAgentMessages({ en: {}, zh: {} });
const scopedKeys = (catalog: Readonly<Record<string, string>>): string[] =>
	Object.keys(catalog)
		.filter(
			(key) =>
				key.startsWith('bolt.studio.') ||
				key.startsWith('bolt.automations.') ||
				key.startsWith('bolt.shell.')
		)
		.sort();

const SURFACE_ROOTS = [
	new URL('../../src/client/ui/studio', import.meta.url).pathname,
	new URL('../../src/client/ui/system', import.meta.url).pathname,
	new URL('../../src/client/ui/shell/workspace-navigation.ts', import.meta.url).pathname,
	new URL('../../src/client/ui/shell/workspace.svelte', import.meta.url).pathname
];

const MESSAGE_KEY = /['`](bolt\.(?:studio|automations|shell)\.[A-Za-z0-9.]+)['`]/g;

const collectFiles = async (root: string): Promise<string[]> => {
	const info = await stat(root);
	if (info.isFile()) return [root];
	const entries = await readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(root, entry.name);
			if (entry.isDirectory()) return collectFiles(path);
			return entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')
				? Promise.resolve([path])
				: Promise.resolve([]);
		})
	);
	return nested.flat();
};

const extractUsedKeys = (source: string): string[] => {
	const keys = new Set<string>();
	for (const match of source.matchAll(MESSAGE_KEY)) {
		keys.add(match[1] ?? '');
	}
	keys.delete('');
	if (source.includes('bolt.studio.count.${')) {
		const union = source.match(/kind: ((?:'[^']+' \| )*'[^']+')/);
		for (const kind of union?.[1]?.matchAll(/'([^']+)'/g) ?? []) {
			const captured = kind[1];
			if (captured !== undefined) keys.add(`bolt.studio.count.${captured}`);
		}
	}
	return [...keys];
};

describe('Workspace Studio and system-surface localization', () => {
	it('keeps every Studio, Automation, and shell key present in both catalogs', () => {
		expect(scopedKeys(catalogs.zh)).toEqual(scopedKeys(catalogs.en));
	});

	it('never resolves scoped copy to an untranslated raw key', () => {
		for (const key of scopedKeys(catalogs.en)) {
			expect(catalogs.en[key]).toBeDefined();
			expect(catalogs.zh[key]).toBeDefined();
			expect(catalogs.en[key]).not.toBe(key);
			expect(catalogs.zh[key]).not.toBe(key);
		}
	});

	it('fails when a Studio or system t() key is missing from English or Chinese', async () => {
		const files = (await Promise.all(SURFACE_ROOTS.map(collectFiles))).flat();
		const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')] as const));
		const used = new Set<string>();
		for (const [, source] of sources) {
			for (const key of extractUsedKeys(source)) used.add(key);
		}

		expect(files.length).toBeGreaterThanOrEqual(15);
		expect(used.size).toBeGreaterThanOrEqual(200);

		const missing = [...used].filter((key) => {
			const en = catalogs.en[key];
			const zh = catalogs.zh[key];
			return en === undefined || zh === undefined || en === key || zh === key;
		});
		expect(missing).toEqual([]);
	});
});
