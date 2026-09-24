import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { renderCustomTypeRenderer } from '../src/compiler/workspace-build.js';

/**
 * Every name the workspace generator imports from `@norbital-ai/bolt/<entry>` is exported there.
 *
 * Generated workspace types are `.d.ts` files and the generated tsconfig sets `skipLibCheck`, so a
 * generated `import type { X }` naming something the entry does not export is never reported: `X`
 * is silently `any`. That is how every tenant's `CreateInput`/`UpdateInput`, the automation client
 * and the client runtime were `any` while `svelte-check` stayed green. The imports are enumerated
 * from the generator's own source, so a renderer added later is covered without being listed here.
 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const generatorSource = readFileSync(join(packageRoot, 'src/compiler/workspace-build.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
	readonly exports: Readonly<Record<string, { readonly types?: string }>>;
};

/** `./build/authoring/index.d.ts` → `<root>/src/authoring/index.ts`. */
const sourceEntryOf = (entry: string): string => {
	const types = manifest.exports[`./${entry}`]?.types;
	if (types === undefined) throw new Error(`@norbital-ai/bolt/${entry} is not an exported entry`);
	return join(packageRoot, types.replace(/^\.\/build\//, 'src/').replace(/\.d\.ts$/, '.ts'));
};

const generatedImports = (): ReadonlyMap<string, ReadonlySet<string>> => {
	const byEntry = new Map<string, Set<string>>();
	for (const match of generatorSource.matchAll(
		/import(?:\s+type)?\s*\{([^}]*)\}\s*from\s*'@norbital-ai\/bolt\/([a-z/-]+)'/g
	)) {
		const entry = match[2] ?? '';
		const names = byEntry.get(entry) ?? new Set<string>();
		for (const specifier of (match[1] ?? '').replace(/\\[nt]/g, ' ').split(',')) {
			const name = specifier
				.replace(/^\s*type\s+/, '')
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) names.add(name);
		}
		byEntry.set(entry, names);
	}
	return byEntry;
};

describe('generated workspace imports', () => {
	it('name only what each @norbital-ai/bolt entry exports', { timeout: 60_000 }, () => {
		const imports = generatedImports();
		// Guards the enumeration itself: a regex that stopped matching would pass vacuously.
		expect([...imports.keys()].sort()).toEqual(
			expect.arrayContaining(['authoring', 'authoring/internals', 'client-runtime'])
		);
		const entries = [...imports.keys()].map((entry) => [entry, sourceEntryOf(entry)] as const);
		const config = ts.getParsedCommandLineOfConfigFile(
			join(packageRoot, 'tsconfig.json'),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
					throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
				}
			}
		);
		if (config === undefined) throw new Error('bolt tsconfig.json did not parse');
		const program = ts.createProgram({
			rootNames: entries.map(([, file]) => file),
			options: { ...config.options, noEmit: true }
		});
		const checker = program.getTypeChecker();
		const missing = entries.flatMap(([entry, file]) => {
			const source = program.getSourceFile(file);
			const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
			if (symbol === undefined) return [`${entry}: ${file} is not a module`];
			const exported = new Set(checker.getExportsOfModule(symbol).map(({ name }) => name));
			return [...(imports.get(entry) ?? [])]
				.filter((name) => !exported.has(name))
				.map((name) => `@norbital-ai/bolt/${entry} does not export ${name}`);
		});
		expect(missing).toEqual([]);
	});

	it('imports a datatype definition from where its $types file is written', () => {
		const root = '/workspace';
		const definition = join(root, 'src/datatypes/photo_source/+definition.ts');
		const directory = join(root, '.norbital/types/datatypes/photo_source');
		const rendered = renderCustomTypeRenderer(definition, directory);
		const specifier = /import type definition from "([^"]+)"/.exec(rendered)?.[1];
		expect(specifier).toBeDefined();
		expect(resolve(directory, (specifier ?? '').replace(/\.js$/, '.ts'))).toBe(definition);
		expect(relative(root, dirname(definition))).toBe('src/datatypes/photo_source');
	});
});
