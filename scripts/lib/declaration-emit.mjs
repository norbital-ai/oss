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

/**
 * Blank out comments and string bodies, preserving line numbering.
 *
 * Both `any` in prose ("before any delivery reaches the workspace") and `any` inside a string
 * literal are noise here; only `any` in type position is evidence. Template literals are treated as
 * strings — a degraded inference has never landed inside one, and reading them as code would flag
 * ordinary documentation text embedded in a template type.
 */
const skipToNewline = (source, index) => {
	while (index < source.length && source[index] !== '\n') index += 1;
	return index;
};

const skipBlockComment = (source, index) => {
	index += 2;
	let newlines = '';
	while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
		if (source[index] === '\n') newlines += '\n';
		index += 1;
	}
	return { index: index + 2, newlines };
};

const skipStringBody = (source, index, quote) => {
	index += 1;
	let newlines = '';
	while (index < source.length && source[index] !== quote) {
		if (source[index] === '\\') index += 1;
		else if (source[index] === '\n') newlines += '\n';
		index += 1;
	}
	return { index: index + 1, newlines };
};

function stripCommentsAndStrings(source) {
	let output = '';
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === '/' && source[index + 1] === '/') {
			index = skipToNewline(source, index);
			continue;
		}
		if (character === '/' && source[index + 1] === '*') {
			const skipped = skipBlockComment(source, index);
			index = skipped.index;
			output += skipped.newlines;
			continue;
		}
		if (character === '"' || character === "'" || character === '`') {
			const skipped = skipStringBody(source, index, character);
			index = skipped.index;
			output += skipped.newlines;
			continue;
		}
		output += character;
		index += 1;
	}
	return output;
}

/** Every `any` in type position under `declarationRoot`, minus the package's stated allowances. */
function findDegradedDeclarations(declarationRoot, allowances = []) {
	const findings = [];
	for (const relativePath of globSync('**/*.d.ts', { cwd: declarationRoot }).sort()) {
		const normalized = relativePath.split(path.sep).join('/');
		if (allowances.some((pattern) => path.matchesGlob(normalized, pattern))) continue;
		const source = readFileSync(path.join(declarationRoot, relativePath), 'utf8');
		stripCommentsAndStrings(source)
			.split('\n')
			.forEach((line, offset) => {
				if (/\bany\b/.test(line)) {
					findings.push({ file: normalized, line: offset + 1, text: line.trim() });
				}
			});
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
