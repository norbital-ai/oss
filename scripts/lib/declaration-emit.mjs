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
import { globSync, readFileSync } from 'node:fs';
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
const declarationAnyAllowances = {
	ui: ['**/*.svelte.d.ts', 'utils/index.d.ts', 'form/path.d.ts']
};

/** Every `any` in type position under `declarationRoot`, minus the package's stated allowances. */
function findDegradedDeclarations(declarationRoot, allowances = []) {
	const findings = [];
	for (const relativePath of globSync('**/*.d.ts', { cwd: declarationRoot }).sort()) {
		const normalized = relativePath.split(path.sep).join('/');
		if (allowances.some((pattern) => path.matchesGlob(normalized, pattern))) continue;
		const source = readFileSync(path.join(declarationRoot, relativePath), 'utf8');
		const sourceFile = ts.createSourceFile(
			normalized,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const lines = source.split('\n');
		const visit = (node) => {
			if (node.kind === ts.SyntaxKind.AnyKeyword) {
				const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
				findings.push({ file: normalized, line, text: lines[line - 1]?.trim() ?? 'any' });
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return findings;
}

/**
 * Throw unless every declaration under `declarationRoot` is free of inferred `any`.
 *
 * `packageDirectory` selects the allowance list; `label` names the artifact under inspection so the
 * same failure reads correctly whether it came from a staging directory mid-build or from an
 * unpacked tarball at publication time.
 */
export function assertDeclarationEmit({ declarationRoot, packageDirectory, label }) {
	const allowances = declarationAnyAllowances[packageDirectory] ?? [];
	const findings = findDegradedDeclarations(declarationRoot, allowances);
	if (findings.length === 0) return;
	const shown = findings.slice(0, 20);
	const remainder = findings.length - shown.length;
	throw new Error(
		[
			`${label} emits \`any\` in ${findings.length} declaration position(s).`,
			'A type that should have been inferred resolved to `any`, which usually means a workspace',
			'dependency had no `build/` while this package compiled. Build dependencies first',
			'(`pnpm packages:build`, or any turbo task, which orders `^build`) and rebuild.',
			...shown.map(({ file, line, text }) => `  ${file}:${line}: ${text}`),
			...(remainder > 0 ? [`  …and ${remainder} more.`] : [])
		].join('\n')
	);
}
