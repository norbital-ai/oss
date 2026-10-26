/// <reference types="node" />
// `@norbital-ai/bolt/type-service` (compute model §5, "Check: one type service for every tenant" and "The language
// tool"): TypeScript 7's API server (`tsc --api`, `@typescript/native`) answering every tenant on a host. A few
// recycled processes each hold many tenants' projects; tenants on the same packages share parsed dependency files.
// Source arrives as data through the server's virtual filesystem (nothing is checked out or written): each workspace
// is a virtual root holding its text files, `.svelte` components as svelte2tsx shadows, and `node_modules` mapped onto
// the host's package store at its canonical paths. Every answer is a checker call; ours is the position mapping, the
// answer's shape, and the process budget: a process past its memory budget is replaced after the request in hand,
// one request runs at a time per process (tenants wait in turn), and a request's CPU is read from its process.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	API,
	CompletionItemKind,
	DiagnosticCategory,
	NodeBuilderFlags,
	SignatureKind,
	SymbolFlags,
	type Diagnostic,
	type NodeHandle,
	type Project,
	type Snapshot,
	type Symbol as TsSymbol,
	type Type
} from '@typescript/native/unstable/async';
import type { Node, SourceFile } from '@typescript/native/unstable/ast';
import {
	isExportAssignment,
	isIdentifier,
	isVariableStatement
} from '@typescript/native/unstable/ast/is';
import { formatSyntaxKind } from '@typescript/native/unstable/ast/utils';
import {
	Context,
	Duration,
	Effect,
	Exit,
	Hash,
	Layer,
	PartitionedSemaphore,
	Schema,
	Semaphore
} from 'effect';
import { componentOf, redirectOf, redirectText, shadow, shims, type Shadow } from './svelte.ts';

/** A tenant's workspace, as data: one project per `key` (live, or one author's change). */
export type LangWorkspace = {
	/** Whose CPU a request is, and whose turn it waits for. */
	readonly tenant: string;
	readonly key: string;
	/**
	 * Every text file the checker reads, by workspace-relative path, unsaved editor buffers already applied: `src/`,
	 * `seed/`, `tests/`, `tsconfig.json`, `package.json` and the generated `.norbital/` type setup.
	 */
	readonly files: ReadonlyMap<string, string>;
	/** The workspace's locked `node_modules` in the host's package store. */
	readonly modules?: string | undefined;
};
/** An editor's position: workspace-relative path, 1-based line and column. A dependency's path is `node_modules/…`. */
export type LangPosition = {
	readonly path: string;
	readonly line: number;
	readonly column: number;
};
export type LangHover = {
	readonly name?: string;
	readonly type?: string;
	readonly docs: string;
	/** Where the symbol (an import's target) is declared. */
	readonly at?: LangPosition;
};
export type LangOutline = {
	readonly kind: string;
	readonly name: string | null;
	readonly line: number;
};
export type LangCompletion = {
	readonly name: string;
	readonly kind?: string;
	readonly detail?: string;
};
export type LangDiagnostic = LangPosition & {
	readonly code: number;
	readonly category: 'error' | 'warning' | 'suggestion' | 'message';
	readonly message: string;
};
/** An answer and the CPU its process spent on it, for the kernel to bill to the request's tenant. */
export type Metered<A> = { readonly answer: A; readonly cpuMs: number };

export class TypeServiceError extends Schema.TaggedError<TypeServiceError>()('TypeServiceError', {
	reason: Schema.Literals(['unknownFile', 'noProject', 'timeout', 'failed']),
	message: Schema.String
}) {}

export type TypeServiceOptions = {
	/** Shared processes; tenants are routed to one by hash, so they stay warm. Default 3. */
	readonly lanes?: number;
	/** A shared process past this RSS is replaced after the request in hand. Default 900 MiB (P18). */
	readonly budgetMiB?: number;
	/** Every process together; the least recently used idle one stops to make room. Default 4 GiB. */
	readonly shareMiB?: number;
	/** A request past this ends and its process is replaced. Default 60 s. */
	readonly requestMs?: number;
	/** A whole-program check, in a one-shot process. Default 600 s (the job ceiling). */
	readonly fullMs?: number;
	/** A project whose cold open took longer, or cost over half a budget, gets a process of its own. Default 20 s. */
	readonly slowMs?: number;
	/** The `tsc --api` executable; default `@typescript/native`'s own (a sandbox launcher may wrap it). */
	readonly tsserverPath?: string;
};

export class TypeService extends Context.Service<
	TypeService,
	{
		/** Evicts this tenant's projects and source, and refuses requests prepared before the eviction. */
		readonly forget: (tenant: string) => Effect.Effect<void, TypeServiceError>;
		readonly hover: (
			ws: LangWorkspace,
			at: LangPosition
		) => Effect.Effect<Metered<LangHover | null>, TypeServiceError>;
		readonly definition: (
			ws: LangWorkspace,
			at: LangPosition
		) => Effect.Effect<Metered<LangPosition | null>, TypeServiceError>;
		readonly references: (
			ws: LangWorkspace,
			at: LangPosition
		) => Effect.Effect<Metered<readonly LangPosition[]>, TypeServiceError>;
		readonly outline: (
			ws: LangWorkspace,
			path: string
		) => Effect.Effect<Metered<readonly LangOutline[]>, TypeServiceError>;
		readonly completions: (
			ws: LangWorkspace,
			at: LangPosition
		) => Effect.Effect<Metered<readonly LangCompletion[]>, TypeServiceError>;
		/** The call signatures of the callable at a position, one string each. */
		readonly signature: (
			ws: LangWorkspace,
			at: LangPosition
		) => Effect.Effect<Metered<readonly string[]>, TypeServiceError>;
		/** One file's errors in the shared process; without `path`, the whole program in a one-shot process. */
		readonly diagnose: (
			ws: LangWorkspace,
			path?: string
		) => Effect.Effect<Metered<readonly LangDiagnostic[]>, TypeServiceError>;
		/** A type expression over the workspace's program, top level expanded: `imports` then `type __t = <type>`. */
		readonly type: (
			ws: LangWorkspace,
			probe: { readonly imports: string; readonly type: string }
		) => Effect.Effect<Metered<LangHover | null>, TypeServiceError>;
	}
>()('@norbital-ai/bolt/TypeService') {}

const ROOTS = '/__norbital_lang';
const SHIMS = 'node_modules/.svelte2tsx-language-server-files';
const CONFIG = 'tsconfig.lang.json';
const PROBE = '.norbital/lang-probe.ts';
const EMPTY = 'export {};\n';
const LIMIT = { references: 500, completions: 200, diagnostics: 500 } as const;

const fail = (reason: TypeServiceError['reason'], message: string) =>
	new TypeServiceError({ reason, message });

// ── the process: its pid, its CPU and RSS ──

/** `[[dd-]hh:]mm:ss[.cc]`, as `ps` prints CPU time. */
const clockMs = (text: string) => {
	const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
	const seconds = (clock ?? '')
		.split(':')
		.reverse()
		.reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0);
	return Math.round((Number(days) * 86_400 + seconds) * 1000);
};
/** `/proc` on Linux (CPU in 10 ms ticks), `ps` elsewhere. */
const statsOf = (pid: number): { cpuMs: number; rssMiB: number } | undefined => {
	try {
		if (existsSync(`/proc/${pid}/stat`)) {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
			// ponytail: USER_HZ is 100 on every Linux we run on; read sysconf(_SC_CLK_TCK) if one differs
			return {
				cpuMs: (Number(fields[11]) + Number(fields[12])) * 10,
				rssMiB: Number(rss ?? 0) / 1024
			};
		}
		const [rss = '0', time = '0:0'] = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], {
			encoding: 'utf8'
		})
			.trim()
			.split(/\s+/);
		return { cpuMs: clockMs(time), rssMiB: Number(rss) / 1024 };
	} catch {
		return undefined;
	}
};
/** This process's `tsc --api` children. The client keeps its child private, so spawns are serialized to tell them apart. */
const apiChildren = (): number[] => {
	if (existsSync('/proc/self/stat'))
		return readdirSync('/proc')
			.filter((name) => /^\d+$/.test(name))
			.flatMap((name) => {
				try {
					const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
					const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
					return ppid === process.pid &&
						readFileSync(`/proc/${name}/cmdline`, 'utf8').includes('--api')
						? [Number(name)]
						: [];
				} catch {
					return [];
				}
			});
	return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
		.split('\n')
		.flatMap((line) => {
			const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			return m !== null && Number(m[2]) === process.pid && (m[3] ?? '').includes('--api')
				? [Number(m[1])]
				: [];
		});
};

// ── a workspace held in a process: its virtual root ──

type Held = {
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
};

const rootOf = (key: string) =>
	`${ROOTS}/${
		key
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.slice(0, 40) || 'w'
	}-${(Hash.string(key) >>> 0).toString(36)}`;
const parentOf = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf('/')));

/** Rebuilds `held` for `files`, returning what the server must re-read. */
function refresh(
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
function filesystem(roots: ReadonlyMap<string, Held>) {
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

// ── one `tsc --api` process ──

type Proc = {
	readonly api: API;
	readonly pid: number | undefined;
	readonly roots: Map<string, Held>;
	readonly line: PartitionedSemaphore.PartitionedSemaphore<string>;
	snapshot: Snapshot | undefined;
	rssMiB: number;
	usedAt: number;
	waiting: number;
	dead: boolean;
	/** A cancelled caller may leave the native RPC settling; eviction waits before changing its snapshot. */
	pending?: Promise<void>;
};

/** A position → its file as the server holds it (a component's shadow) and offset; `null` inside generated markup. */
const offsetIn = (
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
/** A declaration's name, or the node: the first identifier among its children. */
const nameOf = (node: Node): Node =>
	node.forEachChild((c) => (isIdentifier(c) ? c : undefined)) ?? node;
const outlineName = (s: Node): string | null => {
	if (isVariableStatement(s))
		return (
			s.declarationList.declarations
				.flatMap((d) => (isIdentifier(d.name) ? [d.name.text] : []))
				.join(', ') || null
		);
	if (isExportAssignment(s)) return 'default';
	const name = nameOf(s);
	return isIdentifier(name) ? name.text : null;
};

/** What one request sees: its project and how to turn the server's paths and offsets back into the editor's. */
function view(project: Project, held: Held) {
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
	const declared = async (handle: NodeHandle) => {
		const node = await handle.resolve(project);
		return node === undefined ? undefined : position(handle.path, nameOf(node).getStart());
	};
	const target = async (symbol: TsSymbol) =>
		symbol.flags & SymbolFlags.Alias ? project.checker.getAliasedSymbol(symbol) : symbol;
	const hover = async (file: string, offset: number, flags?: number): Promise<LangHover | null> => {
		const c = project.checker;
		const [symbol, type] = await Promise.all([
			c.getSymbolAtPosition(file, offset),
			c.getTypeAtPosition(file, offset)
		]);
		if (symbol === undefined && type === undefined) return null;
		const of = symbol === undefined ? undefined : await target(symbol);
		const decl = of?.declarations[0];
		const at = decl === undefined ? undefined : await declared(decl);
		return {
			...(symbol === undefined ? {} : { name: symbol.name }),
			...(type === undefined ? {} : { type: await c.typeToString(type, undefined, flags) }),
			docs: of === undefined ? '' : await c.getDocumentationCommentOfSymbol(of),
			...(at === undefined ? {} : { at })
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
		return out.slice(0, LIMIT.diagnostics);
	};
	return { project, held, position, declared, target, hover, diagnostics, source };
}
type View = ReturnType<typeof view>;

const ops = {
	hover: (s: View, file: string, offset: number) => s.hover(file, offset),
	definition: async (s: View, file: string, offset: number) =>
		(await s.hover(file, offset))?.at ?? null,
	references: async (s: View, file: string, offset: number): Promise<readonly LangPosition[]> => {
		const symbol = await s.project.checker.getSymbolAtPosition(file, offset);
		const decl = symbol === undefined ? undefined : (await s.target(symbol)).declarations[0];
		const node = decl === undefined ? undefined : await decl.resolve(s.project);
		if (node === undefined) return [];
		const name = nameOf(node);
		const entries = await s.project.checker.getReferencedSymbolsForNode(name, name.getStart());
		const out = new Map<string, LangPosition>();
		for (const ref of entries.flatMap((e) => e.references).slice(0, LIMIT.references)) {
			const resolved = await ref.resolve(s.project);
			const at =
				resolved === undefined ? undefined : await s.position(ref.path, resolved.getStart());
			if (at !== undefined) out.set(`${at.path}:${at.line}:${at.column}`, at);
		}
		return [...out.values()];
	},
	completions: async (s: View, file: string, offset: number): Promise<readonly LangCompletion[]> =>
		((await s.project.checker.getCompletionsAtPosition(file, offset))?.entries ?? [])
			.slice(0, LIMIT.completions)
			.map((e) => ({
				name: e.name,
				...(e.kind === undefined ? {} : { kind: CompletionItemKind[e.kind] }),
				...(e.detail === undefined ? {} : { detail: e.detail })
			})),
	signature: async (s: View, file: string, offset: number): Promise<readonly string[]> => {
		const c = s.project.checker,
			type = await c.getTypeAtPosition(file, offset);
		if (type === undefined) return [];
		const text = async (t: Type | undefined) => (t === undefined ? 'unknown' : c.typeToString(t));
		const out: string[] = [];
		for (const sig of await c.getSignaturesOfType(type, SignatureKind.Call)) {
			const generics = await Promise.all((await sig.getTypeParameters()).map((t) => text(t)));
			const params = await Promise.all(
				(await sig.getParameters()).map(
					async (p) => `${p.name}: ${await text(await c.getTypeOfSymbol(p))}`
				)
			);
			out.push(
				`${generics.length > 0 ? `<${generics.join(', ')}>` : ''}(${params.join(', ')}) => ${await text(await c.getReturnTypeOfSignature(sig))}`
			);
		}
		return out;
	}
} as const;

// ── the service ──

export const make = Effect.fn('bolt.typeService')(function* (options: TypeServiceOptions = {}) {
	const lanes = Math.max(1, options.lanes ?? 3),
		budget = options.budgetMiB ?? 900,
		share = options.shareMiB ?? 4096,
		requestMs = options.requestMs ?? 60_000,
		fullMs = options.fullMs ?? 600_000,
		slowMs = options.slowMs ?? 20_000;
	const shared: (Proc | undefined)[] = Array.from({ length: lanes }, () => undefined);
	const alone = new Map<string, Proc>(),
		slow = new Set<string>();
	const oneShots = new Map<Proc, string>();
	const epochs = new Map<string, number>();
	const forgetting = new Map<string, number>();
	const epoch = (tenant: string) => epochs.get(tenant) ?? 0;
	const current = (tenant: string, expected: number) =>
		Effect.suspend(() =>
			forgetting.has(tenant) || epoch(tenant) !== expected
				? Effect.fail(fail('failed', 'This workspace was reset; request its current source again.'))
				: Effect.void
		);
	const workspaceKey = (ws: LangWorkspace) => `${ws.tenant}\u0000${ws.key}`;
	const nativeRequest = <A>(proc: Proc, work: () => Promise<A>) =>
		Effect.tryPromise({
			try: () => {
				const answering = work();
				const settled = answering.then(
					() => undefined,
					() => undefined
				);
				proc.pending = settled;
				return answering.finally(() => {
					if (proc.pending === settled) delete proc.pending;
				});
			},
			catch: (cause) => (cause instanceof TypeServiceError ? cause : fail('failed', String(cause)))
		});
	/** Spawns run one at a time (a new child is told apart by being the only new one); so does the pool's bookkeeping. */
	const pool = yield* Semaphore.make(1);

	const spawn = Effect.fn('bolt.typeService.spawn')(function* () {
		const roots = new Map<string, Held>();
		const known = new Set(apiChildren());
		const api = new API({
			cwd: '/',
			fs: filesystem(roots),
			...(options.tsserverPath === undefined ? {} : { tsserverPath: options.tsserverPath })
		});
		const snapshot = yield* Effect.tryPromise({
			try: () => api.updateSnapshot(),
			catch: (cause) => fail('failed', `tsc --api did not start: ${String(cause)}`)
		});
		const pid = apiChildren().find((p) => !known.has(p));
		const line = yield* PartitionedSemaphore.make<string>({ permits: 1 });
		const proc: Proc = {
			api,
			pid,
			roots,
			line,
			snapshot,
			rssMiB: (pid === undefined ? undefined : statsOf(pid))?.rssMiB ?? 0,
			usedAt: Date.now(),
			waiting: 0,
			dead: false
		};
		return proc;
	});
	const stop = (proc: Proc) =>
		Effect.gen(function* () {
			proc.dead = true;
			for (const [i, p] of shared.entries()) if (p === proc) shared[i] = undefined;
			for (const [key, p] of alone) if (p === proc) alone.delete(key);
			oneShots.delete(proc);
			proc.roots.clear();
			yield* Effect.promise(() => proc.api.close().catch(() => undefined)).pipe(
				Effect.timeoutOption(Duration.seconds(5))
			);
			if (proc.pid !== undefined)
				try {
					process.kill(proc.pid, 'SIGKILL');
				} catch {
					// already gone
				}
		});
	/** Makes room for one more budget inside the share: the least recently used idle process stops. */
	const room = Effect.gen(function* () {
		const all = () => [...shared.filter((p) => p !== undefined), ...alone.values()];
		while (all().reduce((sum, p) => sum + p.rssMiB, 0) + budget > share) {
			const idle = all()
				.filter((p) => p.waiting === 0)
				.sort((a, b) => a.usedAt - b.usedAt)[0];
			if (idle === undefined) return;
			yield* stop(idle);
		}
	});
	const procFor = (ws: LangWorkspace) =>
		pool.withPermit(
			Effect.gen(function* () {
				const lane = (Hash.string(ws.tenant) >>> 0) % lanes;
				const key = workspaceKey(ws);
				const held = slow.has(key) ? alone.get(key) : shared[lane];
				if (held !== undefined) {
					held.waiting++;
					return held;
				}
				yield* room;
				const proc = yield* spawn();
				proc.waiting++;
				if (slow.has(key)) alone.set(key, proc);
				else shared[lane] = proc;
				return proc;
			})
		);

	/** Brings `ws` up to date in `proc` and answers `work` over its project. */
	const answer = async <A>(
		proc: Proc,
		ws: LangWorkspace,
		work: (s: View) => Promise<A>,
		probe: string | undefined
	) => {
		const root = rootOf(workspaceKey(ws));
		let held = proc.roots.get(root);
		if (held === undefined) {
			held = {
				tenant: ws.tenant,
				key: workspaceKey(ws),
				root,
				config: `${root}/${CONFIG}`,
				files: new Map(),
				modules: undefined,
				shadows: new Map(),
				virtual: new Map(),
				entries: new Map(),
				lower: new Map(),
				open: false
			};
			proc.roots.set(root, held);
		}
		const changes = refresh(held, ws.files, ws.modules, probe);
		const cold = !held.open;
		const moved =
			'invalidateAll' in changes ||
			changes.changed.length + changes.created.length + changes.deleted.length > 0;
		if (cold || moved || proc.snapshot === undefined) {
			const previous = proc.snapshot;
			proc.snapshot = await proc.api.updateSnapshot({
				...(cold ? { openProjects: [held.config] } : {}),
				...(moved && !cold ? { fileChanges: changes } : {})
			});
			held.open = true;
			await previous?.dispose();
		}
		const project = proc.snapshot.getProject(held.config);
		if (project === undefined)
			throw fail('noProject', "the workspace's tsconfig.json did not open");
		return { cold, value: await work(view(project, held)) };
	};

	const run = <A>(
		ws: LangWorkspace,
		work: (s: View) => Promise<A>,
		probe?: string
	): Effect.Effect<Metered<A>, TypeServiceError> => {
		const expected = epoch(ws.tenant);
		return Effect.gen(function* () {
			yield* current(ws.tenant, expected);
			const proc = yield* procFor(ws);
			const result = yield* proc.line
				.withPermit(ws.tenant)(
					Effect.gen(function* () {
						yield* current(ws.tenant, expected);
						// a process replaced while this request waited for its turn
						if (proc.dead) return undefined;
						const settling = proc.pending;
						if (settling !== undefined) yield* Effect.promise(() => settling);
						if (proc.dead) return undefined;
						yield* current(ws.tenant, expected);
						const before = proc.pid === undefined ? undefined : statsOf(proc.pid);
						const started = Date.now();
						const done = yield* nativeRequest(proc, () => answer(proc, ws, work, probe)).pipe(
							Effect.timeoutOrElse({
								duration: Duration.millis(requestMs),
								orElse: () =>
									stop(proc).pipe(
										Effect.andThen(
											Effect.fail(
												fail('timeout', `the type service took over ${requestMs / 1000} s`)
											)
										)
									)
							}),
							Effect.tapError((e) => (e.reason === 'failed' ? stop(proc) : Effect.void))
						);
						const after = proc.pid === undefined ? undefined : statsOf(proc.pid);
						proc.usedAt = Date.now();
						proc.rssMiB = after?.rssMiB ?? proc.rssMiB;
						const opened = (after?.rssMiB ?? 0) - (before?.rssMiB ?? 0);
						if (done.cold && (Date.now() - started > slowMs || opened > budget / 2))
							slow.add(workspaceKey(ws));
						// RAM is bounded by recycling: closing a project gives nothing back (P18)
						if (!alone.has(workspaceKey(ws)) && proc.rssMiB > budget) yield* stop(proc);
						return {
							answer: done.value,
							cpuMs: before === undefined || after === undefined ? 0 : after.cpuMs - before.cpuMs
						};
					})
				)
				.pipe(Effect.ensuring(Effect.sync(() => proc.waiting--)));
			yield* current(ws.tenant, expected);
			return result ?? (yield* run(ws, work, probe));
		});
	};

	/** Runs `work` in a process of its own, closed when it answers: a whole-program check never stays in the share. */
	const once = <A>(ws: LangWorkspace, work: (s: View) => Promise<A>) => {
		const expected = epoch(ws.tenant);
		return Effect.acquireUseRelease(
			pool.withPermit(
				current(ws.tenant, expected).pipe(
					Effect.andThen(spawn()),
					Effect.tap((proc) =>
						Effect.sync(() => {
							oneShots.set(proc, ws.tenant);
						})
					)
				)
			),
			(proc) =>
				Effect.gen(function* () {
					yield* current(ws.tenant, expected);
					const before = proc.pid === undefined ? undefined : statsOf(proc.pid);
					const done = yield* Effect.tryPromise({
						try: () => answer(proc, ws, work, undefined),
						catch: (cause) =>
							cause instanceof TypeServiceError ? cause : fail('failed', String(cause))
					}).pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(fullMs),
							orElse: () => Effect.fail(fail('timeout', `the check took over ${fullMs / 1000} s`))
						})
					);
					const after = proc.pid === undefined ? undefined : statsOf(proc.pid);
					return {
						answer: done.value,
						cpuMs: before === undefined || after === undefined ? 0 : after.cpuMs - before.cpuMs
					};
				}),
			stop
		);
	};

	const forget = Effect.fn('bolt.typeService.forget')(function* (tenant: string) {
		forgetting.set(tenant, (forgetting.get(tenant) ?? 0) + 1);
		epochs.set(tenant, epoch(tenant) + 1);
		yield* Effect.gen(function* () {
			const processes = yield* pool.withPermit(
				Effect.sync(
					() =>
						new Set([
							...shared.filter((proc) => proc !== undefined),
							...alone.values(),
							...oneShots.keys()
						])
				)
			);
			for (const proc of processes) {
				if (oneShots.get(proc) === tenant) {
					yield* stop(proc);
					continue;
				}
				yield* Effect.acquireUseRelease(
					Effect.sync(() => {
						proc.waiting++;
					}),
					() =>
						proc.line.withPermit(tenant)(
							Effect.gen(function* () {
								const settling = proc.pending;
								if (settling !== undefined) yield* Effect.promise(() => settling);
								if (proc.dead) return;
								const removed = [...proc.roots.values()].filter((held) => held.tenant === tenant);
								if (removed.length === 0) return;
								for (const held of removed) proc.roots.delete(held.root);
								const previous = proc.snapshot;
								proc.snapshot = yield* nativeRequest(proc, () =>
									proc.api.updateSnapshot({
										closeProjects: removed.filter((held) => held.open).map((held) => held.config),
										fileChanges: {
											deleted: removed.flatMap((held) => [
												...[...held.files.keys()].map((path) => `${held.root}/${path}`),
												...held.virtual.keys()
											])
										}
									})
								).pipe(
									Effect.onExit((exit) =>
										Effect.sync(() => {
											if (Exit.isFailure(exit))
												for (const held of removed) proc.roots.set(held.root, held);
										})
									)
								);
								for (const held of removed) {
									slow.delete(held.key);
									alone.delete(held.key);
								}
								if (previous !== undefined) yield* Effect.promise(() => previous.dispose());
								if (proc.roots.size === 0) yield* stop(proc);
							})
						),
					() =>
						Effect.sync(() => {
							proc.waiting--;
						})
				);
			}
			for (const key of slow) if (key.startsWith(`${tenant}\u0000`)) slow.delete(key);
		}).pipe(
			Effect.timeoutOrElse({
				duration: Duration.millis(requestMs),
				orElse: () =>
					Effect.fail(fail('timeout', `forgetting the workspace took over ${requestMs / 1000} s`))
			}),
			Effect.ensuring(
				Effect.sync(() => {
					const left = (forgetting.get(tenant) ?? 1) - 1;
					if (left === 0) forgetting.delete(tenant);
					else forgetting.set(tenant, left);
				})
			)
		);
	});

	/** `work` at an editor position; `empty` where the position has no checked counterpart (generated markup). */
	const at =
		<A>(empty: A, work: (s: View, file: string, offset: number) => Promise<A>) =>
		(ws: LangWorkspace, position: LangPosition) =>
			run(ws, (s) => {
				const place = offsetIn(s.held, position);
				if (place === undefined)
					return Promise.reject(
						fail('unknownFile', `${position.path} is not a file of this workspace`)
					);
				return place === null ? Promise.resolve(empty) : work(s, place.file, place.offset);
			});

	yield* Effect.addFinalizer(() =>
		Effect.forEach([...shared.filter((p) => p !== undefined), ...alone.values()], stop, {
			discard: true
		})
	);
	return TypeService.of({
		forget,
		hover: at<LangHover | null>(null, ops.hover),
		definition: at<LangPosition | null>(null, ops.definition),
		references: at<readonly LangPosition[]>([], ops.references),
		completions: at<readonly LangCompletion[]>([], ops.completions),
		signature: at<readonly string[]>([], ops.signature),
		outline: (ws, path) =>
			run(ws, async (s) => {
				const sh = s.held.shadows.get(path);
				if (!s.held.files.has(path))
					throw fail('unknownFile', `${path} is not a file of this workspace`);
				const file = sh?.path ?? `${s.held.root}/${path}`;
				const sf = await s.source(file);
				const out: LangOutline[] = [];
				for (const statement of sf?.statements ?? []) {
					const at = await s.position(file, statement.getStart(sf));
					if (at !== undefined)
						out.push({
							kind: formatSyntaxKind(statement.kind),
							name: outlineName(statement),
							line: at.line
						});
				}
				return out;
			}),
		diagnose: (ws, path) =>
			path === undefined
				? once(ws, (s) => s.diagnostics([undefined]))
				: run(ws, (s) => {
						if (!s.held.files.has(path))
							return Promise.reject(fail('unknownFile', `${path} is not a file of this workspace`));
						return s.diagnostics([s.held.shadows.get(path)?.path ?? `${s.held.root}/${path}`]);
					}),
		type: (ws, probe) => {
			const text = `${probe.imports}\nexport type __t = ${probe.type};\n`;
			return run(
				ws,
				async (s) => {
					const hover = await s.hover(
						`${s.held.root}/${PROBE}`,
						text.lastIndexOf('__t'),
						NodeBuilderFlags.NoTruncation | NodeBuilderFlags.InTypeAlias
					);
					// the probe's own alias is no declaration of the workspace's
					return hover?.type === undefined ? null : { type: hover.type, docs: '' };
				},
				text
			);
		}
	});
});

/** One type service per host, its processes stopped with the layer's scope. */
export const layer = (options?: TypeServiceOptions) => Layer.effect(TypeService, make(options));
