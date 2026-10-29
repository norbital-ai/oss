/// <reference types="node" />
/**
 * `bolt check`, the one diagnosis entry point: the compiler's checks, then the type check. A repository's CI runs it
 * on each template, and the sandbox's check job runs it once per tree. The type check is one `tsc --api`
 * whole-program diagnose (compute model §5, "Check: one type service for every tenant") over the workspace on disk:
 * every package, `svelte` and svelte2tsx's shims included, resolves from the workspace's own `node_modules`, so a
 * component and the shims type against one copy. The audit is the host's, never part of a check.
 */
import { Effect, FileSystem, Option, Path, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { check } from '../compiler/check/index.ts';
import { Diagnostic } from '@norbital-ai/bolt/tooling';
import { writeTypeSetup } from '../compiler/names.ts';
import { ToolFailure } from './build.ts';

const SKIPPED = new Set(['node_modules', '.norbital', '.git', '.svelte-kit', 'dist']);
/** The generated type setup the workspace's `tsconfig.json` extends and includes. */
const GENERATED = ['.norbital/tsconfig.json', '.norbital/names.ts', '.norbital/bolt.d.ts'];
const TEXT = /\.(ts|mts|cts|svelte|json|js|mjs)$/;
/** Every text file the checker reads, by workspace-relative path: the authored tree and the generated type setup. */
const workspaceFiles = Effect.fn('bolt.workspaceFiles')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	// the heavy and derived folders sit at the root; everything else is the workspace's own
	const rels = [...GENERATED];
	for (const name of yield* fs.readDirectory(root)) {
		if (SKIPPED.has(name)) continue;
		const at = path.join(root, name);
		if ((yield* fs.stat(at)).type === 'File') rels.push(name);
		else
			for (const inner of yield* fs.readDirectory(at, { recursive: true }))
				if ((yield* fs.stat(path.join(at, inner))).type === 'File')
					rels.push(path.join(name, inner));
	}
	const files = new Map<string, string>();
	for (const rel of rels.filter((rel) => TEXT.test(rel)).toSorted())
		if (yield* fs.exists(path.join(root, rel)))
			files.set(rel, yield* fs.readFileString(path.join(root, rel)));
	return files;
});
/** The whole program's errors and warnings over `root` (the compiler's `--fail-on-warnings` bar). */
const typeDiagnostics = Effect.fn('bolt.typeDiagnostics')(function* (
	root: string,
	files: ReadonlyMap<string, string>
) {
	// a build needs no checker: load its TypeScript 7 API only when a check asks for it
	const { checkWorkspace } = yield* Effect.tryPromise({
		try: () => import('@norbital-ai/bolt/node'),
		catch: (cause) => new ToolFailure({ message: `the type check: ${String(cause)}` })
	});
	const answer = yield* checkWorkspace(files, `${root}/node_modules`).pipe(
		Effect.mapError((e) => new ToolFailure({ message: `the type check: ${e.message}` }))
	);
	return answer
		.filter((d) => d.category === 'error' || d.category === 'warning')
		.map((d) => ({
			code: d.code === 0 ? 'types/svelte' : `types/TS${d.code}`,
			path: d.path,
			line: d.line,
			message: `${d.path}:${d.line}:${d.column}: ${d.message}`
		}));
});
/** The Svelte compiler's own shape, as far as the check reads it (the workspace's version, decoded once). */
const SvelteWarnings = Schema.Struct({
	warnings: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			start: Schema.optionalKey(Schema.Struct({ line: Schema.Number, column: Schema.Number }))
		})
	)
});
/**
 * The Svelte compiler's warnings (a11y, unused CSS, runes misuse) for every component, from the workspace's own
 * `svelte`: the type service sees types only, and a warning fails a check as it always has. A component that does not
 * compile is the type stage's `types/svelte` error, not repeated here.
 */
const svelteWarnings = Effect.fn('bolt.svelteWarnings')(function* (
	root: string,
	files: ReadonlyMap<string, string>
) {
	const components = [...files].filter(([rel]) => rel.endsWith('.svelte'));
	if (components.length === 0) return [];
	const compiler = yield* Effect.tryPromise({
		try: async (): Promise<{ compile: (source: string, options: object) => unknown }> =>
			import(pathToFileURL(createRequire(`${root}/package.json`).resolve('svelte/compiler')).href),
		catch: (cause) =>
			new ToolFailure({ message: `the workspace's svelte compiler: ${String(cause)}` })
	});
	const decode = Schema.decodeUnknownOption(SvelteWarnings);
	const warned = yield* Effect.forEach(components, ([rel, source]) =>
		// a template page compiles in Svelte's async mode; a public page (beside its server loader) renders synchronously
		Effect.try(() =>
			compiler.compile(source, {
				filename: rel,
				generate: false,
				experimental: {
					async: !files.has(rel.replace(/\.page\.svelte$/, '.page.server.ts'))
				}
			})
		).pipe(
			Effect.option,
			Effect.map((compiled) =>
				Option.match(Option.flatMap(compiled, decode), {
					onNone: () => [],
					onSome: ({ warnings }) =>
						warnings.map((w) => ({
							code: `svelte/${w.code}`,
							path: rel,
							line: w.start?.line ?? 1,
							message: `${rel}:${w.start?.line ?? 1}:${(w.start?.column ?? 0) + 1}: ${w.message}`
						}))
				})
			)
		)
	);
	return warned.flat();
});
const TypeCache = Schema.Struct({ key: Schema.String, diagnostics: Schema.Array(Diagnostic) });
/**
 * What the type stage judges: every file the checker reads, and the identity of each judging package (a
 * same-version republish or a relink replaces its files, so its inode and time move with it).
 */
const typeKey = Effect.fn('bolt.typeKey')(function* (
	root: string,
	files: ReadonlyMap<string, string>
) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		hash = createHash('sha256');
	for (const [file, text] of files) hash.update(`\0${file}\0`).update(text);
	const modules = path.join(root, 'node_modules'),
		scope = path.join(modules, '@norbital-ai');
	const judges = [
		...((yield* fs.exists(scope))
			? (yield* fs.readDirectory(scope)).map((n) => `@norbital-ai/${n}`)
			: []),
		'svelte'
	].toSorted();
	for (const name of judges) {
		const manifest = path.join(modules, name, 'package.json');
		if (!(yield* fs.exists(manifest))) continue;
		const info = yield* fs.stat(yield* fs.realPath(manifest));
		hash.update(
			`\0${name}\0${Option.getOrElse(info.ino, () => 0)}\0${Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() })}\0`
		);
	}
	return hash.digest('hex');
});
/** The type stage: unchanged sources and judging packages answer from the cache. */
export const types = Effect.fn('bolt.types')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		dir = path.join(root, '.norbital', 'cache'),
		file = path.join(dir, 'types.json');
	if (!(yield* fs.exists(path.join(root, 'tsconfig.json')))) return [];
	yield* writeTypeSetup(root);
	const files = yield* workspaceFiles(root);
	const key = yield* typeKey(root, files);
	const hit = yield* fs
		.readFileString(file)
		.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TypeCache))),
			Effect.option,
			Effect.map(Option.filter((entry) => entry.key === key))
		);
	if (Option.isSome(hit)) return [...hit.value.diagnostics];
	const diagnostics = [
		...(yield* Effect.scoped(typeDiagnostics(root, files))),
		...(yield* svelteWarnings(root, files))
	];
	yield* fs.makeDirectory(dir, { recursive: true });
	yield* fs.writeFileString(file, JSON.stringify({ key, diagnostics }));
	return diagnostics;
});
/** Every diagnostic of `root`: the compiler's checks, then (once they pass far enough to read a manifest) the types. */
export const diagnose = Effect.fn('bolt.diagnose')(function* (root: string) {
	const result = yield* check(root);
	return {
		stages: result.stages,
		errors: [...result.errors, ...(result.manifest === undefined ? [] : yield* types(root))]
	};
});
