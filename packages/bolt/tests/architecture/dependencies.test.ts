import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
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

const lineCount = async (path: string): Promise<number> =>
	((await readFile(path, 'utf8')).match(/\n/g) ?? []).length;

describe('Bolt architecture boundaries', () => {
	it('does not import Core, Pod, Colony, bolt-server, or provider SDKs', async () => {
		const files = await sourceFiles(new URL('../../src', import.meta.url).pathname);
		const inspected = files.filter((file) => !file.endsWith('/quality/audit.ts'));
		const entries = await Promise.all(
			inspected.map(async (file) => [file, await readFile(file, 'utf8')] as const)
		);
		expect(auditImports(Object.fromEntries(entries))).toEqual([]);
	});

	it('keeps browser workspace entrypoints independent of the server runtime graph', async () => {
		const entrypoints = ['workspace-api.ts'];
		const violations = (
			await Promise.all(
				entrypoints.map(async (entrypoint) => {
					const source = await readFile(
						new URL(`../../src/client/${entrypoint}`, import.meta.url),
						'utf8'
					);
					return /from\s+['"](?:#lib\/runtime\/|\.\.\/runtime\/)/u.test(source) ? [entrypoint] : [];
				})
			)
		).flat();
		expect(violations).toEqual([]);
	});

	it('keeps collection implementation leaves behind the authored hook boundary', async () => {
		const root = new URL('../../src/runtime/collections', import.meta.url).pathname;
		const files = await sourceFiles(root);
		const boundaryOwners = new Set([
			join(root, 'authored.ts'),
			join(root, 'collections.ts'),
			join(root, 'hooks/boundary.ts')
		]);
		const violations = (
			await Promise.all(
				files
					.filter((file) => !boundaryOwners.has(file))
					.map(async (file) => {
						const source = await readFile(file, 'utf8');
						return /from\s+['"](?:#lib\/runtime\/collections\/authored\.js|\.\.?\/.*authored\.js)['"]/u.test(
							source
						)
							? [file.slice(root.length + 1)]
							: [];
					})
			)
		).flat();
		expect(violations).toEqual([]);
	});

	it('forbids runtime modules from resolving imports into compiler', async () => {
		const source = new URL('../../src', import.meta.url).pathname;
		const runtime = join(source, 'runtime');
		const files = (await sourceFiles(runtime)).filter((file) => file.endsWith('.ts'));
		const options: ts.CompilerOptions = {
			allowJs: true,
			baseUrl: source,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			paths: { '#lib/*': ['*'] }
		};
		const violations: Array<string> = [];
		for (const file of files) {
			const sourceText = await readFile(file, 'utf8');
			const syntax = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
			const inspect = (node: ts.Node): void => {
				const literal =
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier !== undefined &&
					ts.isStringLiteral(node.moduleSpecifier)
						? node.moduleSpecifier
						: ts.isCallExpression(node) &&
							  node.expression.kind === ts.SyntaxKind.ImportKeyword &&
							  node.arguments[0] !== undefined &&
							  ts.isStringLiteral(node.arguments[0])
							? node.arguments[0]
							: undefined;
				if (literal !== undefined) {
					const resolved = ts.resolveModuleName(literal.text, file, options, ts.sys).resolvedModule;
					if (resolved?.resolvedFileName.includes('/src/compiler/'))
						violations.push(`${file.slice(runtime.length + 1)} -> ${literal.text}`);
				}
				ts.forEachChild(node, inspect);
			};
			inspect(syntax);
		}
		expect(violations).toEqual([]);
	});

	it('keeps the Toolchain cutover smaller after parser deletion and schema relocation', async () => {
		const source = new URL('../../src', import.meta.url).pathname;
		const tracked = [
			...(await sourceFiles(join(source, 'compiler'))).filter((path) => path.endsWith('.ts')),
			...(await sourceFiles(join(source, 'runtime/schema'))).filter((path) => path.endsWith('.ts')),
			...[
				'model-introspection.ts',
				'models-schema.ts',
				'workspace-schema.ts',
				'internals.ts',
				'approval-validation.ts'
			].map((path) => join(source, 'authoring', path))
		];
		const total = (await Promise.all(tracked.map(lineCount))).reduce(
			(lines, count) => lines + count,
			0
		);
		expect(tracked.length).toBeLessThanOrEqual(19);
		// 8,762 is the measured basket, and this ceiling has now been raised three times in one
		// cutover: 8,688 → 8,691 (user-message supersession) → 8,707 (the agent-runtime contract
		// declaring itself in the authoring schema) → 8,762 here, as the sync-engine and mutation
		// fixes landed alongside them. The number is a ratchet on deliberate debt, so it is raised
		// with its reason rather than met by deleting comments — but three raises in one night is
		// itself the signal: the next change to this basket should be removing lines, not adding.
		expect(total).toBeLessThanOrEqual(8_762);
		expect(tracked.some((path) => path.endsWith('/compiler/model-fields.ts'))).toBe(false);
	});

	it('enforces the amended collection lifecycle source budget', async () => {
		const source = new URL('../../src', import.meta.url).pathname;
		const collections = join(source, 'runtime/collections');
		const access = join(source, 'runtime/access');
		const authoring = join(source, 'authoring');
		const lines = (relativePath: string): Promise<number> => lineCount(join(source, relativePath));
		const sum = async (paths: ReadonlyArray<string>): Promise<number> =>
			(await Promise.all(paths.map(lines))).reduce((total, count) => total + count, 0);

		const collectionFiles = (await sourceFiles(collections)).filter((path) => path.endsWith('.ts'));
		const collectionLines = (
			await Promise.all(collectionFiles.map((path) => lineCount(path)))
		).reduce((total, count) => total + count, 0);
		const accessSuccessors = [
			'runtime/access/access-control.ts',
			'runtime/access/invocation.ts',
			'runtime/access/policy-surface.ts',
			'runtime/access/predicate.ts'
		];
		const accessLines = await sum(accessSuccessors);
		const amendedAggregate =
			collectionLines +
			(await sum([
				'runtime/dispatch.ts',
				'runtime/schema/schema-plan.ts',
				'authoring/contracts-schema.ts',
				'authoring/internals.ts',
				'runtime/approvals/approvals.ts',
				'authoring/model-introspection.ts'
			])) +
			accessLines;

		expect(amendedAggregate).toBeLessThanOrEqual(17_900);
		expect(await lines('runtime/collections/collections.ts')).toBeLessThanOrEqual(4_700);
		// 816 -> 820: server-only unstored nested ids are creates (agent admission), while the
		// browser undeclared-create branch stays the payroll persist path. See RFC/toolchain.md §6.1.5.
		expect(await lines('runtime/collections/write/engine.ts')).toBeLessThanOrEqual(820);
		// 825 -> 837: the staged hook-write-ops work already in this tree — `HookWriteOps` made
		// generic in the error channel, and `buildApi`/`runMutateBefore` threading `stageHookWrites`
		// through `makeGraphPreparers`. Not from the engine.ts fix beside it, which does not touch
		// this file. See RFC/toolchain.md §6.1.5.
		expect(await lines('runtime/collections/write/declarative-prepare.ts')).toBeLessThanOrEqual(
			837
		);
		expect(await lines('runtime/collections/write/graph-read.ts')).toBeLessThanOrEqual(300);
		expect(await lines('runtime/collections/write/settle.ts')).toBeLessThanOrEqual(180);
		expect(await lines('runtime/collections/hooks/boundary.ts')).toBeLessThanOrEqual(275);
		expect(accessLines).toBeLessThanOrEqual(1_705);

		// Policy introspection is deliberately outside the historical aggregate basket. Give the
		// authoring/runtime bridge its own explicit ceiling rather than letting it grow ungoverned.
		expect(await lineCount(join(authoring, 'policy-introspection.ts'))).toBeLessThanOrEqual(425);
		expect((await sourceFiles(access)).filter((path) => path.endsWith('.ts')).length).toBe(6);
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
	/**
	 * The source files a build target could legitimately have come from.
	 *
	 * More than one, because `.svelte` is two things in the same namespace. `Thing.svelte` is a
	 * component and `svelte-package` copies it across as-is, emitting `Thing.svelte.d.ts` beside it.
	 * `thing.svelte.ts` is a *rune module* — ordinary TypeScript that may hold `$state` — which is
	 * transpiled to `thing.svelte.js` and declared as `thing.svelte.d.ts`. The two produce the
	 * identical declaration name from different sources, so a single mapping has to guess, and
	 * guessing "component" reported `./client/workspace` as unemittable while its real source,
	 * `src/client/ui/shell/mount.svelte.ts`, sat next to seven other rune modules that would each
	 * have tripped the same false positive on export.
	 *
	 * Answering with the set rather than one string keeps the assertion exactly as strong: a subpath
	 * still has to name a file that exists in `src`, and no target has more than one candidate
	 * actually present.
	 */
	const sourcesOf = (target: string): ReadonlyArray<string> => {
		const relative = target.replace(/^\.\/build\//, '');
		if (relative.endsWith('.svelte')) return [relative];
		if (relative.endsWith('.svelte.d.ts')) {
			const withoutDeclaration = relative.slice(0, -'.d.ts'.length);
			return [withoutDeclaration, `${withoutDeclaration}.ts`];
		}
		if (relative.endsWith('.d.ts')) return [`${relative.slice(0, -'.d.ts'.length)}.ts`];
		return [`${relative.replace(/\.js$/, '')}.ts`];
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
				const candidates = await Promise.all(
					sourcesOf(target).map((candidate) =>
						readFile(new URL(`../../src/${candidate}`, import.meta.url))
							.then(() => true)
							.catch(() => false)
					)
				);
				if (!candidates.includes(true)) missing.push(`${subpath} -> ${target}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
