/**
 * Whole-repository rules: reachability, unused exports, and duplicate bodies.
 *
 * These are the rules the triage found living in `static-scan.mjs` rather than in the graph
 * analyzer, which the handover brief expected to hold them. `FILE1` alone accounts for 288 of the
 * legacy detector's findings, so deleting that file without this pass would have been the largest
 * single loss of enforcement in the port.
 *
 * A per-file rule cannot answer any of these. "Nothing imports this" and "these two bodies are the
 * same" are properties of the set, so this runs once over every parsed file rather than once per
 * file, and emits into the same catalogue as everything else.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Finding, Severity } from './index.js';
import { isRecord, readJsonObject, recordField } from './manifest.js';
import type { Principle } from './rules.js';

/** One parsed file, as the pass needs it. */
type Parsed = Readonly<{ file: string; source: string; sourceFile: ts.SourceFile }>;

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.svelte'];

/** Resolve a relative specifier to a repository-relative file, trying the usual extensions. */
function resolveRelative(
	from: string,
	specifier: string,
	known: ReadonlySet<string>
): string | undefined {
	if (!specifier.startsWith('.')) return undefined;
	// `./x.worker.ts?worker&url` is an edge to `./x.worker.ts`. Vite's query suffixes are build
	// instructions, not part of the path, and leaving them on made every worker look unimported.
	const bare = specifier.split('?')[0] ?? specifier;
	const base = join(dirname(from), bare).split('\\').join('/');
	const stripped = base.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
	const candidates = [
		base,
		...EXTENSIONS.map((extension) => `${stripped}${extension}`),
		...EXTENSIONS.map((extension) => `${stripped}/index${extension}`)
	];
	return candidates.find((candidate) => known.has(candidate));
}

/** Output directories a manifest points at, whose source sits beside them. */
const OUTPUT = /^(?:build|dist|lib|out)\//;

/** Rewrite a package-relative target onto the source that produces it. */
function sourceCandidates(target: string): ReadonlyArray<string> {
	const bare = target.replace(/^\.\//, '');
	const fromSource = bare.replace(OUTPUT, 'src/');
	const stripped = [bare, fromSource].map((candidate) =>
		candidate.replace(/\.(?:js|mjs|cjs|jsx)$/, '')
	);
	return [
		bare,
		fromSource,
		...stripped.flatMap((base) => EXTENSIONS.map((extension) => `${base}${extension}`)),
		...stripped.flatMap((base) => EXTENSIONS.map((extension) => `${base}/index${extension}`))
	];
}

/** A manifest's fields, without asserting a shape onto whatever the file happened to contain. */
function readManifest(absolute: string): Readonly<Record<string, unknown>> {
	if (!existsSync(absolute)) return {};
	return readJsonObject(readFileSync(absolute, 'utf8')) ?? {};
}

const packageRoots = new Map<string, string>();

/**
 * The nearest directory at or above a file that declares a package.
 *
 * `D1` prescribes "extract one owner and call it from both", and two files in different packages
 * cannot do that. In this realm each template directory is an independently published artifact —
 * `scripts/validate-template-projections.mjs` fails any projection reaching outside its own tree —
 * so a body shared between `crm` and `construction` has no owner it could move to.
 */
function packageRootOf(root: string, file: string): string {
	const cached = packageRoots.get(file);
	if (cached !== undefined) return cached;
	let directory = dirname(file);
	for (;;) {
		if (existsSync(join(root, directory, 'package.json'))) break;
		const parent = dirname(directory);
		if (parent === directory || directory === '.') {
			directory = '.';
			break;
		}
		directory = parent;
	}
	packageRoots.set(file, directory);
	return directory;
}

/** Manifest paths from a file's directory up to the repository root, nearest first. */
function manifestsAbove(from: string): ReadonlyArray<string> {
	const found: Array<string> = [];
	let directory = dirname(from);
	for (;;) {
		const atRoot = directory === '' || directory === '.';
		found.push(atRoot ? 'package.json' : `${directory}/package.json`);
		if (atRoot) return found;
		directory = dirname(directory);
	}
}

/** Substitute a specifier into one `imports` entry, honouring a single `*` wildcard. */
function substitute(key: string, target: string, specifier: string): string | undefined {
	const star = key.indexOf('*');
	if (star === -1) return key === specifier ? target : undefined;
	const head = key.slice(0, star);
	const tail = key.slice(star + 1);
	if (!specifier.startsWith(head) || !specifier.endsWith(tail)) return undefined;
	return target.replace('*', specifier.slice(head.length, specifier.length - tail.length));
}

/** The first candidate for a package-relative target that the scan actually holds. */
function firstKnown(base: string, target: string, known: ReadonlySet<string>): string | undefined {
	for (const candidate of sourceCandidates(target))
		if (known.has(`${base}${candidate}`)) return `${base}${candidate}`;
	return undefined;
}

/**
 * Resolve a `#`-prefixed subpath import through the nearest manifest's `imports` map.
 *
 * Without this the graph sees only relative specifiers. `bolt` imports itself almost exclusively as
 * `#lib/...`, so every one of its modules looked unreachable and `FILE1` reported the whole package
 * as dead code — a rule stating something false about 91 files while looking like it worked.
 */
function resolveSubpath(
	root: string,
	from: string,
	specifier: string,
	known: ReadonlySet<string>
): string | undefined {
	if (!specifier.startsWith('#')) return undefined;
	for (const manifest of manifestsAbove(from)) {
		const imports = readManifest(join(root, manifest))['imports'];
		if (imports === null || typeof imports !== 'object') continue;
		const directory = dirname(manifest);
		const base = directory === '' || directory === '.' ? '' : `${directory}/`;
		for (const [key, value] of Object.entries(imports)) {
			if (typeof value !== 'string') continue;
			const substituted = substitute(key, value, specifier);
			if (substituted === undefined) continue;
			const found = firstKnown(base, substituted, known);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** Every module specifier a file imports or re-exports. */
function specifiersOf(parsed: Parsed): ReadonlyArray<string> {
	const found: Array<string> = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		)
			found.push(node.moduleSpecifier.text);
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const [first] = node.arguments;
			if (first !== undefined && ts.isStringLiteral(first)) found.push(first.text);
		}
		// `new Worker(new URL('./w.js', import.meta.url))` is a real edge.
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'URL'
		) {
			const [first] = node.arguments ?? [];
			if (first !== undefined && ts.isStringLiteral(first)) found.push(first.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed.sourceFile);
	return found;
}

/** The names an `export const a = 1, b = 2` statement declares. */
function variableExports(
	statement: ts.VariableStatement
): ReadonlyArray<Readonly<{ name: string; node: ts.Node }>> {
	const found: Array<Readonly<{ name: string; node: ts.Node }>> = [];
	for (const declaration of statement.declarationList.declarations)
		if (ts.isIdentifier(declaration.name))
			found.push({ name: declaration.name.text, node: declaration });
	return found;
}

/** Named and default exports a file declares. */
function exportsOf(parsed: Parsed): ReadonlyArray<Readonly<{ name: string; node: ts.Node }>> {
	const found: Array<{ name: string; node: ts.Node }> = [];
	for (const statement of parsed.sourceFile.statements) {
		const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
		if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
			found.push({ name: 'default', node: statement });
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			found.push(...variableExports(statement));
			continue;
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name !== undefined
		)
			found.push({ name: statement.name.text, node: statement });
	}
	return found;
}

/** Every identifier a file mentions, which is the cheap over-approximation of "uses". */
function identifiersOf(parsed: Parsed): ReadonlySet<string> {
	const names = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) names.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(parsed.sourceFile);
	return names;
}

/** Every entry a manifest field points at, following build output back to the source beside it. */
function declaredEntries(
	manifest: string,
	value: unknown,
	files: ReadonlySet<string>,
	roots: Set<string>
): void {
	if (typeof value === 'string' && value.startsWith('.')) {
		const resolved = resolveRelative(manifest, value, files);
		if (resolved !== undefined) roots.add(resolved);
		// A manifest points at build output; the source beside it is the real entry.
		const source = value.replace(/^\.\/build\//, './src/').replace(/\.js$/, '.ts');
		const fromSource = resolveRelative(manifest, source, files);
		if (fromSource !== undefined) roots.add(fromSource);
		return;
	}
	const nested = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
	for (const entry of nested) declaredEntries(manifest, entry, files, roots);
}

/**
 * Files a package script invokes.
 *
 * A file a script names is an entrypoint whatever tool invokes it: `esbuild server.ts`,
 * `tsx worker.ts`, `node scripts/seed.js`. Reading the scripts covers every build tool without
 * naming any of them.
 */
function scriptEntries(
	manifest: string,
	scripts: Readonly<Record<string, unknown>>,
	files: ReadonlySet<string>,
	roots: Set<string>
): void {
	for (const command of Object.values(scripts)) {
		if (typeof command !== 'string') continue;
		for (const token of command.split(/[\s'"=]+/)) {
			if (!/\.[cm]?[jt]sx?$/.test(token) || token.startsWith('-')) continue;
			const named = token.startsWith('.') ? token : `./${token}`;
			const resolved = resolveRelative(manifest, named, files);
			if (resolved !== undefined) roots.add(resolved);
		}
	}
}

/** Whether a runtime rather than an import reaches this file. */
function isFrameworkEntry(file: string): boolean {
	return (
		// A leading `+` marks a file the framework loads by convention rather than by import —
		// SvelteKit's `+page`/`+layout` and bolt's `+definition`/`+teams`/`+env`/`+pipelines`
		// alike. Naming only SvelteKit's four left 215 template files looking unreachable.
		/(?:^|\/)(?:index|main|app|hooks(?:\.server|\.client)?|\+[^/]*)\.[cm]?[jt]sx?$/.test(file) ||
		/(?:^|\/)[^/]*\.host\.[cm]?[jt]s$/.test(file) ||
		// SvelteKit's convention modules sit at the `src/` root and are loaded by the framework.
		/(?:^|\/)src\/(?:env|params|hooks|service-worker|app)\.[cm]?[jt]s$/.test(file) ||
		/(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(file) ||
		/(?:^|\/)(?:scripts?|bin|cli|tools)\//.test(file) ||
		file.endsWith('.svelte')
	);
}

/** Entrypoints a package declares, which is where reachability starts. */
function entrypoints(root: string, files: ReadonlySet<string>): ReadonlySet<string> {
	const roots = new Set<string>();
	// Every ancestor, not just the immediate parent: no scanned file sits directly in
	// `packages/doctor/`, so its manifest was never opened and its own CLI entry looked unreachable.
	const manifests = [...files].flatMap((file) => manifestsAbove(file)).concat('package.json');
	for (const manifest of new Set(manifests)) {
		const parsed = readManifest(join(root, manifest));
		for (const field of ['main', 'module', 'types', 'bin', 'exports'])
			declaredEntries(manifest, parsed[field], files, roots);
		scriptEntries(manifest, recordField(parsed, 'scripts'), files, roots);
	}
	// Framework and tool entries are reached by a runtime rather than by an import.
	for (const file of files) if (isFrameworkEntry(file)) roots.add(file);
	return roots;
}

type CrossFileOptions = Readonly<{
	readonly root: string;
	/** The files this pass reports against. */
	readonly files: ReadonlyArray<Parsed>;
	/**
	 * Files that consume the reported set without belonging to it — the repository's tests.
	 *
	 * They are graph nodes, execution roots and name mentions, and never carry a finding. Without
	 * them a production export used by five test files reads as dead: 57 of bolt's 88 `EXP1`
	 * findings were exactly that, and "delete it" was the wrong answer to every one.
	 */
	readonly consumers?: ReadonlyArray<Parsed> | undefined;
}>;

function finding(
	severity: Severity,
	rule: string,
	summary: string,
	principles: ReadonlyArray<Principle>,
	file: string,
	line: number,
	text: string,
	evidence: string
): Finding {
	return {
		severity,
		confidence: 'high',
		rule,
		summary,
		location: `${file}:${line}: ${text.trim()}${evidence === '' ? '' : ` [${evidence}]`}`,
		principles: [...principles]
	};
}

function lineOf(parsed: Parsed, node: ts.Node): Readonly<{ line: number; text: string }> {
	const position = parsed.sourceFile.getLineAndCharacterOfPosition(
		node.getStart(parsed.sourceFile)
	);
	return { line: position.line + 1, text: parsed.source.split('\n')[position.line] ?? '' };
}

/**
 * Normalised body text for duplicate detection.
 *
 * Identifiers are erased so a copy-paste with renamed variables still matches, but literals are
 * kept: two functions differing only in a threshold are two different behaviours, not a duplicate.
 */
function bodyHash(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
	const body =
		ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)
			? node.body
			: ts.isArrowFunction(node)
				? node.body
				: undefined;
	if (body === undefined) return undefined;
	const tokens: Array<string> = [];
	const visit = (current: ts.Node): void => {
		if (ts.isIdentifier(current)) tokens.push('#');
		else if (ts.isStringLiteralLike(current)) tokens.push(JSON.stringify(current.text));
		else if (ts.isNumericLiteral(current)) tokens.push(current.text);
		else tokens.push(String(current.kind));
		ts.forEachChild(current, visit);
	};
	visit(body);
	// Short bodies are shared by accident; a getter and a one-line delegate are not duplicates.
	if (tokens.length < 40) return undefined;
	return createHash('sha256').update(tokens.join(',')).digest('hex');
}

/** Run every whole-repository rule and return findings in catalogue order. */
export function runCrossFile(options: CrossFileOptions): ReadonlyArray<Finding> {
	const findings: Array<Finding> = [];
	// The graph spans everything that can reach a reported file; the report loops below stay on
	// `options.files`. Two corpora, one graph.
	const consumers = options.consumers ?? [];
	const corpus = [...options.files, ...consumers];
	const known = new Set(corpus.map((parsed) => parsed.file));
	const byFile = new Map(corpus.map((parsed) => [parsed.file, parsed]));

	// --- the import graph -------------------------------------------------------------------
	const edges = new Map<string, Set<string>>();
	for (const parsed of corpus) {
		const targets = new Set<string>();
		for (const specifier of specifiersOf(parsed)) {
			const resolved =
				resolveRelative(parsed.file, specifier, known) ??
				resolveSubpath(options.root, parsed.file, specifier, known);
			if (resolved !== undefined) targets.add(resolved);
		}
		edges.set(parsed.file, targets);
	}

	// --- FILE1: unreachable from any entrypoint ----------------------------------------------
	// A test file is an execution surface: its runner loads it directly, so it is a root like any
	// script. Otherwise nothing it imports would ever become reachable.
	const roots = new Set([
		...entrypoints(options.root, known),
		...consumers.map((parsed) => parsed.file)
	]);
	const reachable = new Set<string>();
	const queue = [...roots];
	while (queue.length > 0) {
		const current = queue.pop()!;
		if (reachable.has(current)) continue;
		reachable.add(current);
		for (const target of edges.get(current) ?? []) queue.push(target);
	}
	for (const parsed of options.files) {
		if (reachable.has(parsed.file)) continue;
		const [first] = parsed.sourceFile.statements;
		const at = first === undefined ? { line: 1, text: '' } : lineOf(parsed, first);
		findings.push(
			finding(
				'error',
				'FILE1',
				'production file is unreachable from a real entrypoint',
				['simplicity', 'modularity', 'colocation', 'no-bloat'],
				parsed.file,
				at.line,
				at.text,
				'no package/framework/compiler entrypoint reaches file'
			)
		);
	}

	// --- EXP1: an export nothing mentions ----------------------------------------------------
	const mentionedElsewhere = new Map<string, Set<string>>();
	for (const parsed of corpus) {
		const names = identifiersOf(parsed);
		for (const name of names) {
			const holders = mentionedElsewhere.get(name) ?? new Set<string>();
			holders.add(parsed.file);
			mentionedElsewhere.set(name, holders);
		}
	}
	for (const parsed of options.files) {
		// Only a file something else reaches can have a *dead* export; an unreachable file is FILE1.
		if (!reachable.has(parsed.file)) continue;
		// A declared entrypoint IS the package's public API. Its consumers are outside this
		// repository by construction, so "no static consumer" is not evidence of anything here.
		if (roots.has(parsed.file)) continue;
		for (const exported of exportsOf(parsed)) {
			if (exported.name === 'default') continue;
			const holders = mentionedElsewhere.get(exported.name) ?? new Set<string>();
			const mentions = [...holders].filter((holder) => holder !== parsed.file);
			if (mentions.length > 0) continue;
			const at = lineOf(parsed, exported.node);
			findings.push(
				finding(
					'error',
					'EXP1',
					'exported declaration has no static consumer',
					['simplicity', 'modularity', 'colocation', 'no-bloat'],
					parsed.file,
					at.line,
					at.text,
					`export=${exported.name}`
				)
			);
		}
	}

	// --- D1: the same non-trivial body in two places ------------------------------------------
	const bodies = new Map<
		string,
		Array<Readonly<{ parsed: Parsed; node: ts.Node; name: string }>>
	>();
	for (const parsed of options.files) {
		const visit = (node: ts.Node): void => {
			const hash = bodyHash(node, parsed.sourceFile);
			if (hash !== undefined) {
				const name =
					'name' in node && node.name !== undefined && ts.isIdentifier(node.name as never)
						? (node.name as ts.Identifier).text
						: '(anonymous)';
				const list = bodies.get(hash) ?? [];
				list.push({ parsed, node, name });
				bodies.set(hash, list);
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed.sourceFile);
	}
	for (const [, group] of bodies) {
		if (group.length < 2) continue;
		// Report every copy but the first, so one duplicate pair is one finding.
		for (const duplicate of group.slice(1)) {
			const at = lineOf(duplicate.parsed, duplicate.node);
			const original = group[0]!;
			// Only a duplicate that could share an owner is debt; see `packageRootOf`.
			if (
				packageRootOf(options.root, duplicate.parsed.file) !==
				packageRootOf(options.root, original.parsed.file)
			)
				continue;
			findings.push(
				finding(
					'error',
					'D1',
					'duplicate non-trivial function, method, or class body',
					['simplicity', 'modularity', 'colocation', 'no-bloat'],
					duplicate.parsed.file,
					at.line,
					at.text,
					`name=${duplicate.name} original=${original.parsed.file}:${lineOf(original.parsed, original.node).line}`
				)
			);
		}
	}

	void byFile;
	void relative;
	void resolve;
	const order: Readonly<Record<Severity, number>> = { error: 0, hint: 1 };
	return findings.sort(
		(left, right) =>
			order[left.severity] - order[right.severity] ||
			left.rule.localeCompare(right.rule) ||
			left.location.localeCompare(right.location)
	);
}
