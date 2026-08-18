import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditImports } from '../../src/quality/audit.js';

const sourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory()
				? sourceFiles(join(root, entry.name))
				: Promise.resolve(
						entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')
							? [join(root, entry.name)]
							: []
					)
		)
	);
	return nested.flat();
};

describe('Bolt architecture boundaries', () => {
	it('does not import Core, Pod, Colony, bolt-server, or provider SDKs', async () => {
		const files = await sourceFiles(new URL('../../src', import.meta.url).pathname);
		const inspected = files.filter((file) => !file.endsWith('/quality/audit.ts'));
		const entries = await Promise.all(
			inspected.map(async (file) => [file, await readFile(file, 'utf8')] as const)
		);
		expect(auditImports(Object.fromEntries(entries))).toEqual([]);
	});
});

/**
 * Every `exports` subpath must name a file the build will actually emit.
 *
 * `./client/identity` was added to the client surface and consumed by Colony through a Vite alias
 * into this repository's `src`. The alias made it resolve, so nothing failed here — while the
 * package published no such subpath and `svelte-package` emitted no such file. Any consumer
 * without that alias, which is every real install, could not import it.
 *
 * Checked against `src` rather than `build` so the guard holds on a clean checkout: it asserts the
 * export is emittable, which is the half that a stale build cannot fake.
 */
describe('published surface', () => {
	const sourceOf = (target: string): string => {
		const relative = target.replace(/^\.\/build\//, '');
		if (relative.endsWith('.svelte')) return relative;
		if (relative.endsWith('.svelte.d.ts')) return relative.slice(0, -'.d.ts'.length);
		if (relative.endsWith('.d.ts')) return `${relative.slice(0, -'.d.ts'.length)}.ts`;
		return `${relative.replace(/\.js$/, '')}.ts`;
	};

	it('emits a source file for every exported subpath', async () => {
		const manifest: unknown = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8')
		);
		const exportsMap = (manifest as { exports: Record<string, Record<string, string>> }).exports;
		const subpaths = Object.entries(exportsMap);
		// A manifest read from the wrong place yields no entries and would pass every assertion below.
		expect(subpaths.length).toBeGreaterThanOrEqual(10);

		const missing: Array<string> = [];
		for (const [subpath, conditions] of subpaths) {
			for (const target of new Set(Object.values(conditions))) {
				if (!target.startsWith('./build/')) continue;
				const source = new URL(`../../src/${sourceOf(target)}`, import.meta.url);
				const exists = await readFile(source)
					.then(() => true)
					.catch(() => false);
				if (!exists) missing.push(`${subpath} -> ${target}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
