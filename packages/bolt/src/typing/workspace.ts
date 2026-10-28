/// <reference types="node" />
// A workspace as TypeScript 7's API server (`tsc --api`, `@typescript/native`) reads it, for `bolt check` and for a
// host's language service: source arrives as data through the server's virtual filesystem (nothing is checked out or
// written). Each workspace is a virtual root holding its text files, `.svelte` components as svelte2tsx shadows, and
// `node_modules` mapped onto the host's package store at its canonical paths, so workspaces on the same packages share
// parsed dependency files. Bolt owns this mapping and the whole-program check; the host owns processes and answers.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	API,
	DiagnosticCategory,
	type Diagnostic,
	type Project
} from '@typescript/native/unstable/async';
import type { SourceFile } from '@typescript/native/unstable/ast';
import { Duration, Effect, Hash, Schema } from 'effect';
import { componentOf, redirectOf, redirectText, shadow, shims, type Shadow } from './svelte.ts';

/** An editor's position: workspace-relative path, 1-based line and column. A dependency's path is `node_modules/…`. */
export type LangPosition = {
	readonly path: string;
	readonly line: number;
	readonly column: number;
};
export type LangDiagnostic = LangPosition & {
	readonly code: number;
	readonly category: 'error' | 'warning' | 'suggestion' | 'message';
	readonly message: string;
};

const ROOTS = '/__norbital_lang';
const SHIMS = 'node_modules/.svelte2tsx-language-server-files';
const CONFIG = 'tsconfig.lang.json';
export const PROBE = '.norbital/lang-probe.ts';
const EMPTY = 'export {};\n';
const DIAGNOSTICS = 500;

// ── a workspace held in a process: its virtual root ──

export type Held = {
	readonly tenant: string;
	readonly key: string;
	readonly root: string;
	readonly config: string;
	files: ReadonlyMap<string, string>;
	modules: string | undefined;
	/** Component path → its shadow. */
	shadows: Map<string, Shadow>;
	/** Absolute path → text: shadows, redirects, shims, the config and the probe. */
	virtual: Map<string, string>;
	/** Directory → its entries, as the server lists them (components as their shadows). */
	entries: Map<string, { files: Set<string>; directories: Set<string> }>;
	/** Lowercased absolute path → as served: a case-insensitive host hands back canonical (lowercased) paths. */
	lower: Map<string, string>;
	open: boolean;
	usedAt: number;
};

export const rootOf = (key: string) =>
	`${ROOTS}/${
		key
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.slice(0, 40) || 'w'
	}-${(Hash.string(key) >>> 0).toString(36)}`;
const parentOf = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf('/')));

/** Rebuilds `held` for `files`, returning what the server must re-read. */
export function refresh(
	held: Held,
	files: ReadonlyMap<string, string>,
	modules: string | undefined,
	probe: string | undefined
): { changed: string[]; created: string[]; deleted: string[] } | { invalidateAll: true } {
	const abs = (rel: string) => `${held.root}/${rel}`;
	const before = held.virtual,
		old = held.files;
	const shadows = new Map<string, Shadow>();
	for (const [rel, text] of files)
		if (rel.endsWith('.svelte')) {
			const kept = held.shadows.get(rel);
			shadows.set(rel, kept !== undefined && old.get(rel) === text ? kept : shadow(abs(rel), text));
		}
	const virtual = new Map<string, string>();
	for (const [rel, s] of shadows) {
		virtual.set(s.path, s.code);
		virtual.set(redirectOf(abs(rel)), redirectText(abs(rel), s.ts));
	}
	const html = modules !== undefined && existsSync(join(modules, 'svelte', 'svelte-html.d.ts'));
	const shimFiles = shadows.size === 0 ? new Map<string, string>() : shims(html);
	for (const [name, text] of shimFiles) virtual.set(abs(`${SHIMS}/${name}`), text);
	virtual.set(abs(PROBE), probe ?? before.get(abs(PROBE)) ?? EMPTY);
	virtual.set(
		held.config,
		JSON.stringify({
			extends: './tsconfig.json',
			compilerOptions: { allowArbitraryExtensions: true, noEmit: true },
			files: [
				...(shadows.size > 0 && html ? [abs('node_modules/svelte/svelte-html.d.ts')] : []),
				...[...shimFiles.keys()].map((name) => abs(`${SHIMS}/${name}`)),
				abs(PROBE)
			]
		})
	);
	const entries = new Map<string, { files: Set<string>; directories: Set<string> }>();
	const entry = (dir: string) => {
		let at = entries.get(dir);
		if (at === undefined) {
			at = { files: new Set(), directories: new Set() };
			entries.set(dir, at);
			if (dir !== '') entry(parentOf(dir)).directories.add(dir.slice(dir.lastIndexOf('/') + 1));
		}
		return at;
	};
	entry('');
	if (modules !== undefined) entry('node_modules');
	const served = [
		...[...files.keys()].filter((rel) => !rel.endsWith('.svelte')),
		...[...virtual.keys()].map((path) => path.slice(held.root.length + 1))
	];
	for (const rel of served) entry(parentOf(rel)).files.add(rel.slice(rel.lastIndexOf('/') + 1));
	const lower = new Map(served.map((rel) => [abs(rel).toLowerCase(), abs(rel)]));

	const wasModules = held.modules;
	Object.assign(held, { files, modules, shadows, virtual, entries, lower });
	if (wasModules !== modules && held.open) return { invalidateAll: true };
	const changed: string[] = [],
		created: string[] = [],
		deleted: string[] = [];
	for (const [rel, text] of files)
		if (!rel.endsWith('.svelte'))
			if (!old.has(rel)) created.push(abs(rel));
			else if (old.get(rel) !== text) changed.push(abs(rel));
	for (const rel of old.keys())
		if (!files.has(rel) && !rel.endsWith('.svelte')) deleted.push(abs(rel));
	for (const [path, text] of virtual)
		if (!before.has(path)) created.push(path);
		else if (before.get(path) !== text) changed.push(path);
	for (const path of before.keys()) if (!virtual.has(path)) deleted.push(path);
	return { changed, created, deleted };
}

/** The server's filesystem callbacks: the held roots, their `node_modules` on the package store, disk elsewhere. */
export function filesystem(roots: ReadonlyMap<string, Held>) {
	const locate = (path: string) => {
		if (!path.startsWith(`${ROOTS}/`)) return undefined;
		const end = path.indexOf('/', ROOTS.length + 1);
		const held = roots.get(end === -1 ? path : path.slice(0, end));
		return { held, rel: end === -1 || held === undefined ? '' : path.slice(end + 1) };
	};
	/** A path under a root's `node_modules`, on the package store. */
	const store = (held: Held, rel: string) =>
		held.modules !== undefined &&
		(rel === 'node_modules' || rel.startsWith('node_modules/')) &&
		!held.virtual.has(`${held.root}/${rel}`) &&
		!held.entries.has(rel)
			? join(held.modules, rel.slice('node_modules'.length))
			: undefined;
	const stat = (path: string) => {
		try {
			return statSync(path);
		} catch {
			return undefined;
		}
	};
	return {
		readFile(path: string): string | null | undefined {
			// Svelte's ambient `declare module '*.svelte'` would shadow every component's shadow
			if (path.endsWith('/svelte/types/ambient.d.ts')) return '';
			const at = locate(path);
			if (at === undefined) return undefined;
			if (at.held === undefined) return null;
			const text = at.held.virtual.get(path) ?? at.held.files.get(at.rel);
			if (text !== undefined) return text;
			const real = store(at.held, at.rel);
			if (real === undefined) return null;
			try {
				return readFileSync(real, 'utf8');
			} catch {
				return null;
			}
		},
		fileExists(path: string): boolean | undefined {
			const at = locate(path);
			if (at === undefined) return undefined;
			if (at.held === undefined) return false;
			if (at.held.virtual.has(path) || at.held.files.has(at.rel)) return true;
			const real = store(at.held, at.rel);
			return real !== undefined && (stat(real)?.isFile() ?? false);
		},
		directoryExists(path: string): boolean | undefined {
			const at = locate(path);
			if (at === undefined) return undefined;
			if (at.held === undefined) return path === ROOTS;
			if (at.held.entries.has(at.rel)) return true;
			const real = store(at.held, at.rel);
			return real !== undefined && (stat(real)?.isDirectory() ?? false);
		},
		getAccessibleEntries(path: string): { files: string[]; directories: string[] } | undefined {
			const at = locate(path);
			if (at === undefined) return undefined;
			if (at.held === undefined) return { files: [], directories: [] };
			const own = at.held.entries.get(at.rel);
			const real =
				store(at.held, at.rel) ?? (at.rel === 'node_modules' ? at.held.modules : undefined);
			const files = new Set(own?.files),
				directories = new Set(own?.directories);
			if (real !== undefined)
				try {
					for (const e of readdirSync(real, { withFileTypes: true })) {
						const kind = e.isSymbolicLink() ? stat(join(real, e.name)) : e;
						if (kind?.isFile()) files.add(e.name);
						else if (kind?.isDirectory()) directories.add(e.name);
					}
				} catch {
					// a missing directory lists as empty
				}
			return { files: [...files], directories: [...directories] };
		},
		realpath(path: string): string | undefined {
			const at = locate(path);
			if (at?.held === undefined) return at === undefined ? undefined : path;
			const real = store(at.held, at.rel);
			if (real === undefined) return path;
			try {
				// the package store's canonical path: tenants on the same packages share parsed files
				return realpathSync(real);
			} catch {
				return path;
			}
		}
	};
}

/** A fresh holder for `key`'s workspace, not yet open in any process. */
export const holder = (tenant: string, key: string): Held => {
	const root = rootOf(key);
	return {
		tenant,
		key,
		root,
		config: `${root}/${CONFIG}`,
		files: new Map(),
		modules: undefined,
		shadows: new Map(),
		virtual: new Map(),
		entries: new Map(),
		lower: new Map(),
		open: false,
		usedAt: Date.now()
	};
};

/** A position → its file as the server holds it (a component's shadow) and offset; `null` inside generated markup. */
export const offsetIn = (
	held: Held,
	at: LangPosition
): { file: string; offset: number } | null | undefined => {
	const text = held.files.get(at.path);
	if (text === undefined) return undefined;
	const lines = text.split('\n');
	const line = Math.min(Math.max(1, at.line), lines.length);
	const offset =
		lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) +
		Math.min(Math.max(0, at.column - 1), (lines[line - 1] ?? '').length);
	const sh = held.shadows.get(at.path);
	if (sh === undefined) return { file: `${held.root}/${at.path}`, offset };
	const generated = sh.toGenerated(offset);
	return generated === undefined ? null : { file: sh.path, offset: generated };
};
const lineColumn = (text: string, offset: number) => {
	const before = text.slice(0, offset).split('\n');
	return { line: before.length, column: (before.at(-1) ?? '').length + 1 };
};
const categoryOf = (c: DiagnosticCategory): LangDiagnostic['category'] =>
	c === DiagnosticCategory.Error
		? 'error'
		: c === DiagnosticCategory.Warning
			? 'warning'
			: c === DiagnosticCategory.Suggestion
				? 'suggestion'
				: 'message';
const messageOf = (d: Diagnostic, depth = 0): string =>
	[
		d.text,
		...(d.messageChain ?? []).map((m) => `\n${'  '.repeat(depth + 1)}${messageOf(m, depth + 1)}`)
	].join('');
/** What one request sees: its project and how to turn the server's paths and offsets back into the editor's. */
export function view(project: Project, held: Held) {
	const sources = new Map<string, Promise<SourceFile | undefined>>();
	const source = (path: string) => {
		let sf = sources.get(path);
		if (sf === undefined) {
			sf = project.program.getSourceFile(path);
			sources.set(path, sf);
		}
		return sf;
	};
	/** A server path and offset as an editor position; `undefined` in generated code. */
	const position = async (path: string, offset: number): Promise<LangPosition | undefined> => {
		const served = held.lower.get(path.toLowerCase()) ?? path;
		if (served.startsWith(`${held.root}/`)) {
			const rel = served.slice(held.root.length + 1),
				component = componentOf(rel);
			if (component !== undefined) {
				const sh = held.shadows.get(component),
					original = served.endsWith('.d.svelte.ts') ? undefined : sh?.toOriginal(offset);
				const text = held.files.get(component);
				return original === undefined || text === undefined
					? undefined
					: { path: component, ...lineColumn(text, original) };
			}
			const text = held.files.get(rel) ?? held.virtual.get(served);
			return text === undefined ? undefined : { path: rel, ...lineColumn(text, offset) };
		}
		const sf = await source(path);
		const at = path.lastIndexOf('/node_modules/');
		return sf === undefined
			? undefined
			: {
					path: at === -1 ? path : `node_modules/${path.slice(at + '/node_modules/'.length)}`,
					...lineColumn(sf.text, offset)
				};
	};
	const diagnostics = async (files: readonly (string | undefined)[]): Promise<LangDiagnostic[]> => {
		const found: Diagnostic[] = [];
		for (const file of files)
			found.push(
				...(await project.program.getSyntacticDiagnostics(file)),
				...(await project.program.getSemanticDiagnostics(file))
			);
		if (files.includes(undefined))
			found.push(
				...(await project.program.getConfigFileParsingDiagnostics()),
				...(await project.program.getGlobalDiagnostics())
			);
		const out: LangDiagnostic[] = [];
		for (const d of found) {
			const at =
				d.fileName === undefined
					? { path: 'tsconfig.json', line: 1, column: 1 }
					: await position(d.fileName, d.pos);
			// outside the workspace (a dependency, with skipLibCheck off) or in generated markup
			if (at === undefined || at.path.startsWith('node_modules/')) continue;
			out.push({ ...at, code: d.code, category: categoryOf(d.category), message: messageOf(d) });
		}
		for (const [path, sh] of held.shadows)
			if (sh.error !== undefined && (files.includes(undefined) || files.includes(sh.path)))
				out.push({
					path,
					...lineColumn(held.files.get(path) ?? '', sh.error.offset),
					code: 0,
					category: 'error',
					message: sh.error.message
				});
		return out.slice(0, DIAGNOSTICS);
	};
	return { project, held, position, diagnostics, source };
}

export class TypeCheckError extends Schema.TaggedError<TypeCheckError>()('TypeCheckError', {
	message: Schema.String
}) {}

/** The whole program's diagnostics in a `tsc --api` process of its own, closed when it answers. */
export const checkWorkspace = Effect.fn('bolt.checkWorkspace')(function* (
	files: ReadonlyMap<string, string>,
	modules: string | undefined,
	options: { readonly timeoutMs?: number; readonly tsserverPath?: string } = {}
) {
	const timeoutMs = options.timeoutMs ?? 600_000;
	const held = holder('check', 'check');
	return yield* Effect.acquireUseRelease(
		Effect.sync(
			() =>
				new API({
					cwd: '/',
					fs: filesystem(new Map([[held.root, held]])),
					...(options.tsserverPath === undefined ? {} : { tsserverPath: options.tsserverPath })
				})
		),
		(api) =>
			Effect.tryPromise({
				try: async () => {
					refresh(held, files, modules, undefined);
					const snapshot = await api.updateSnapshot({ openProjects: [held.config] });
					held.open = true;
					const project = snapshot.getProject(held.config);
					if (project === undefined) throw new Error("the workspace's tsconfig.json did not open");
					return view(project, held).diagnostics([undefined]);
				},
				catch: (cause) => new TypeCheckError({ message: String(cause) })
			}).pipe(
				Effect.timeoutOrElse({
					duration: Duration.millis(timeoutMs),
					orElse: () =>
						Effect.fail(
							new TypeCheckError({ message: `the check took over ${timeoutMs / 1000} s` })
						)
				})
			),
		(api) =>
			Effect.promise(() => api.close().catch(() => undefined)).pipe(
				Effect.timeoutOption(Duration.seconds(5))
			)
	);
});
