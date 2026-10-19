/**
 * Detect a declaration emit that has silently degraded to `any`.
 *
 * A compiler asked to infer the type of an exported constant follows that inference across package
 * boundaries. When the dependency it lands in has no `build/` yet, the import resolves to nothing,
 * the inferred type becomes `any`, and the emit is written anyway — `tsc` and `svelte-package` both
 * exit 0. Nothing downstream can tell that output apart from a correct one until a consumer
 * compiles against it, and by then the tarball is on a registry where the version can never be
 * reused.
 *
 * `any` in a published declaration is therefore treated as a build failure rather than a style
 * complaint. The packages here are written without it, so the rule is simply "none", and the few
 * places that legitimately carry one are named per package below rather than tolerated globally.
 */
import { Effect, FileSystem } from 'effect';
import { PublicationFailed } from './error.ts';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

/**
 * Declaration files allowed to contain `any`, relative to a package's declaration root.
 *
 * A package with no entry gets the strict rule. That is deliberate: a new publishable package
 * should have to state its exceptions rather than inherit someone else's.
 *
 * `ui` is the only package with real ones. `svelte2tsx` writes `__sveltets_Render<any>` into every
 * component's `$$bindings` type, which no amount of source discipline removes, and two hand-written
 * modules use `any[]` as the top of the array lattice while walking arbitrary form paths.
 */
const declarationAnyAllowances: Readonly<Record<string, ReadonlyArray<string>>> = {
	ui: ['**/*.svelte.d.ts', 'utils/index.d.ts', 'form/path.d.ts']
};

/** Every `any` in type position under `declarationRoot`, minus the package's stated allowances. */
const findDegradedDeclarations = Effect.fn('Publication.degradedDeclarations')(function* (
	declarationRoot: string,
	allowances: ReadonlyArray<string> = []
) {
	const fs = yield* FileSystem.FileSystem;
	const findings: Array<{ file: string; line: number; text: string }> = [];
	for (const relativePath of (yield* fs.readDirectory(declarationRoot, { recursive: true }))
		.filter((file) => file.endsWith('.d.ts'))
		.sort()) {
		const normalized = relativePath.split(path.sep).join('/');
		if (allowances.some((pattern) => path.matchesGlob(normalized, pattern))) continue;
		const source = yield* fs.readFileString(path.join(declarationRoot, relativePath));
		const sourceFile = ts.createSourceFile(
			normalized,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const lines = source.split('\n');
		const visit = (node: ts.Node) => {
			if (node.kind === ts.SyntaxKind.AnyKeyword) {
				const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
				findings.push({ file: normalized, line, text: lines[line - 1]?.trim() ?? 'any' });
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return findings;
});

/**
 * Throw unless every declaration under `declarationRoot` is free of inferred `any`.
 *
 * `packageDirectory` selects the allowance list; `label` names the artifact under inspection so the
 * same failure reads correctly whether it came from a staging directory mid-build or from an
 * unpacked tarball at publication time.
 */
/**
 * Every non-relative module a declaration names that a consumer could not resolve.
 *
 * An unresolved import in a `.d.ts` is `any` to every consumer and invisible to them under
 * `skipLibCheck` — `import("effect/StandardSchema")` in a release built against one Effect and
 * installed beside another typed every custom column `any`. `#lib/*` is the package's own imports
 * map, checked against the emitted tree; everything else resolves the way a consumer resolves it,
 * from inside the package, through `exports`.
 */
const unresolvedDeclarationImports = Effect.fn('Publication.unresolvedDeclarationImports')(
	function* (declarationRoot: string) {
		const fs = yield* FileSystem.FileSystem;
		const options: ts.CompilerOptions = {
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			customConditions: ['svelte'],
			allowArbitraryExtensions: true
		};
		/** Module names from import/export declarations and `import("…")` types — never from comments. */
		const specifiers = (file: string, text: string): string[] => {
			const names: string[] = [];
			const visit = (node: ts.Node) => {
				// A bare `import 'x.css'` binds nothing, so nothing of it can degrade to `any`.
				const binds = !ts.isImportDeclaration(node) || node.importClause !== undefined;
				const literal =
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier &&
					binds
						? node.moduleSpecifier
						: ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
							? node.argument.literal
							: undefined;
				if (literal !== undefined && ts.isStringLiteral(literal)) names.push(literal.text);
				ts.forEachChild(node, visit);
			};
			visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
			// Node's own modules are ambient declarations (`@types/node`), not packages to resolve.
			return names.filter(
				(name) => !name.startsWith('.') && !name.startsWith('/') && !isBuiltin(name)
			);
		};
		const findings: Array<{ file: string; specifier: string }> = [];
		const seen = new Set<string>();
		for (const relativePath of (yield* fs.readDirectory(declarationRoot, { recursive: true }))
			.filter((file) => file.endsWith('.d.ts'))
			.sort()) {
			const file = path.join(declarationRoot, relativePath);
			for (const name of specifiers(file, yield* fs.readFileString(file))) {
				if (seen.has(name)) continue;
				seen.add(name);
				const resolved = name.startsWith('#lib/')
					? ['.d.ts', '.svelte.d.ts', '/index.d.ts'].some((suffix) =>
							ts.sys.fileExists(
								path.join(declarationRoot, name.slice('#lib/'.length).replace(/\.js$/, '') + suffix)
							)
						)
					: ts.resolveModuleName(name, file, options, { ...ts.sys, realpath: ts.sys.realpath })
							.resolvedModule !== undefined;
				if (!resolved)
					findings.push({ file: relativePath.split(path.sep).join('/'), specifier: name });
			}
		}
		return findings;
	}
);

export const assertDeclarationEmit = Effect.fn('Publication.assertDeclarationEmit')(function* ({
	declarationRoot,
	packageDirectory,
	label,
	resolveImports = false
}: {
	readonly declarationRoot: string;
	readonly packageDirectory: string;
	readonly label: string;
	readonly resolveImports?: boolean | undefined;
}) {
	const allowances = declarationAnyAllowances[packageDirectory] ?? [];
	const unresolved = resolveImports ? yield* unresolvedDeclarationImports(declarationRoot) : [];
	if (unresolved.length > 0)
		return yield* new PublicationFailed({
			message: [
				`${label} names ${unresolved.length} module(s) a consumer cannot resolve; each is \`any\` to them.`,
				...unresolved.slice(0, 20).map(({ file, specifier }) => `  ${file}: ${specifier}`)
			].join('\n')
		});
	const findings = yield* findDegradedDeclarations(declarationRoot, allowances);
	if (findings.length === 0) return;
	const shown = findings.slice(0, 20);
	const remainder = findings.length - shown.length;
	return yield* new PublicationFailed({
		message: [
			`${label} emits \`any\` in ${findings.length} declaration position(s).`,
			'A type that should have been inferred resolved to `any`, which usually means a workspace',
			'dependency had no `build/` while this package compiled. Build dependencies first',
			'(`pnpm packages:build`, or any turbo task, which orders `^build`) and rebuild.',
			...shown.map(({ file, line, text }) => `  ${file}:${line}: ${text}`),
			...(remainder > 0 ? [`  …and ${remainder} more.`] : [])
		].join('\n')
	});
}, Effect.mapError(PublicationFailed.from));
