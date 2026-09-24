/**
 * The live half of a workspace's types: hover and check over any file, answered by a warm
 * TypeScript language service.
 *
 * `bolt sync` ships the surfaces an agent writes against (the type index); this answers what the
 * index cannot — the type at a position in a file an author just read, and the diagnostics of a
 * draft edit before it is saved. It is Bolt's, not a host's: a host says where a workspace lives and
 * which drafts overlay it, and mounts the two tools `typeServiceTools` describes. Nothing else.
 *
 * Fast because it stays warm: a service per workspace, rebuilt incrementally when a draft changes,
 * with one document registry shared by every workspace so a pinned dependency's declarations
 * (bolt, ui, svelte, effect, drizzle) are parsed once however many tenants pin them. Bounded
 * because a warm checker is ~300 MB: services live in an LRU under a byte budget, measured by heap
 * growth at build, and an idle one is dropped on the next call. Safe because the compiler executes
 * nothing, and no tsconfig `plugins` are loaded.
 *
 * A `.svelte` file is read through `svelte2tsx`, as svelte-check reads it: hover and check take and
 * answer positions in the `.svelte` source, and a relative `./x.svelte` import resolves to the
 * component itself rather than the blanket `*.svelte` module declaration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TraceMap, eachMapping } from '@jridgewell/trace-mapping';
import { svelte2tsx } from 'svelte2tsx';
import ts from 'typescript';
import { authoredFileOf, collectionDocs, declarationLine, docAtLine } from './authored-docs.js';

/** One workspace as the host sees it. */
export interface TypeServiceWorkspace {
	/** Stable identity: the same key reuses the warm service. */
	readonly key: string;
	/** A directory holding the workspace's `tsconfig.json`, `node_modules` and synced `.norbital`. */
	readonly root: string;
	/** Draft contents by workspace-relative path; each overrides the file on disk. */
	readonly overlay?: Readonly<Record<string, string>>;
}

export interface TypeServiceOptions {
	/** Heap the warm services may hold together before the least recently used is dropped. */
	readonly budgetBytes?: number;
	/** A service unused for this long is dropped on the next call. */
	readonly idleMillis?: number;
	readonly now?: () => number;
}

export interface TypeHover {
	/** The checker's quick info: `const x: T`, a signature, a property. */
	readonly text: string;
	readonly documentation: string;
	/** Where the symbol is declared, workspace-relative when it is inside the workspace. */
	readonly definition?: Readonly<{ path: string; line: number }>;
}

export interface TypeDiagnostic {
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly code: number;
	readonly message: string;
}

export interface TypeServiceStats {
	readonly workspaces: number;
	readonly heapBytes: number;
	readonly evictions: number;
}

export interface WorkspaceTypeService {
	/** Line and column are 1-based, as an editor and `workspace_read` number them. */
	hover(
		workspace: TypeServiceWorkspace,
		position: Readonly<{ path: string; line: number; column: number }>
	): TypeHover | undefined;
	/**
	 * A workspace name: `automations.<name>`, `functions.<name>`, `apps.<name>`, `channels.<name>`, or
	 * `<path>#<export>` (`<path>` alone is its default export). Collections are the index's to answer.
	 */
	named(workspace: TypeServiceWorkspace, name: string): TypeHover;
	check(
		workspace: TypeServiceWorkspace,
		paths: ReadonlyArray<string>
	): ReadonlyArray<TypeDiagnostic>;
	stats(): TypeServiceStats;
	dispose(): void;
}

const DEFAULT_BUDGET = 1024 * 1024 * 1024;
/** Where `bolt sync` writes a collection's types; nobody authors a field there. */
const GENERATED_COLLECTION = /^\.norbital\/types\/collections\/([^/]+)\//;

const sourceLocation = (source: string): Readonly<{ path: string; line: number }> => {
	const colon = source.lastIndexOf(':');
	return { path: source.slice(0, colon), line: Number(source.slice(colon + 1)) };
};
const DEFAULT_IDLE = 10 * 60 * 1000;
const PROGRAM_BYTES_PER_SOURCE_BYTE = 35;
/** Diagnostics answered per check; past this the list stops helping a reader. */
const MAX_DIAGNOSTICS = 200;

type Entry = {
	readonly root: string;
	readonly service: ts.LanguageService;
	readonly versions: Map<string, number>;
	/** Components asked about directly; imported ones join the program through resolution. */
	readonly components: Set<string>;
	readonly converted: Map<string, Component>;
	overlay: Readonly<Record<string, string>>;
	cost: number;
	used: number;
};

/** One point per mapping segment, sorted by column within each line; lines and columns 0-based. */
type LineIndex = Map<number, Array<readonly [column: number, line: number, toColumn: number]>>;

type Component = {
	readonly source: string;
	readonly code: string;
	readonly toGenerated: LineIndex;
	readonly toOriginal: LineIndex;
};

const flatten = (message: string | ts.DiagnosticMessageChain): string =>
	ts.flattenDiagnosticMessageText(message, '\n');

const isComponent = (file: string): boolean => file.endsWith('.svelte');

// svelte2tsx output calls its shims; svelte-check adds the same two files to every program.
const require = createRequire(import.meta.url);
const shims = ['svelte2tsx/svelte-shims-v4.d.ts', 'svelte2tsx/svelte-jsx-v4.d.ts'].map((path) =>
	require.resolve(path)
);

const push = (index: LineIndex, line: number, point: readonly [number, number, number]): void => {
	const points = index.get(line);
	if (points === undefined) index.set(line, [point]);
	else points.push(point);
};

const convert = (file: string, source: string): Component => {
	const { code, map } = svelte2tsx(source, {
		filename: file,
		isTsFile: /<script[^>]*\blang=["']ts["']/.test(source),
		mode: 'ts',
		emitOnTemplateError: true
	});
	const toGenerated: LineIndex = new Map();
	const toOriginal: LineIndex = new Map();
	const trace = new TraceMap({
		version: 3,
		file,
		names: map.names,
		sources: map.sources,
		mappings: map.mappings
	});
	eachMapping(trace, (mapping) => {
		if (mapping.originalLine === null) return;
		const [line, column] = [mapping.originalLine - 1, mapping.originalColumn];
		const [generatedLine, generatedColumn] = [mapping.generatedLine - 1, mapping.generatedColumn];
		push(toGenerated, line, [column, generatedLine, generatedColumn]);
		push(toOriginal, generatedLine, [generatedColumn, line, column]);
	});
	for (const points of [...toGenerated.values(), ...toOriginal.values()])
		points.sort((a, b) => a[0] - b[0]);
	return { source, code, toGenerated, toOriginal };
};

/** The nearest mapped point at or before `column` on `line`, carried forward by the remaining distance. */
const translate = (
	index: LineIndex,
	line: number,
	column: number
): { line: number; character: number } | undefined => {
	const points = index.get(line);
	if (points === undefined) return undefined;
	let found: readonly [number, number, number] | undefined;
	for (const point of points) {
		if (point[0] > column) break;
		found = point;
	}
	const [from, toLine, toColumn] = found ?? points[0]!;
	return { line: toLine, character: toColumn + Math.max(0, column - from) };
};

export const createWorkspaceTypeService = (
	options: TypeServiceOptions = {}
): WorkspaceTypeService => {
	const budget = options.budgetBytes ?? DEFAULT_BUDGET;
	const idle = options.idleMillis ?? DEFAULT_IDLE;
	const now = options.now ?? Date.now;
	const registry = ts.createDocumentRegistry();
	const entries = new Map<string, Entry>();
	let evictions = 0;

	const drop = (key: string): void => {
		entries.get(key)?.service.dispose();
		entries.delete(key);
		evictions += 1;
	};

	const reclaim = (keep: string): void => {
		const at = now();
		for (const [key, entry] of entries) if (key !== keep && at - entry.used > idle) drop(key);
		let held = [...entries.values()].reduce((sum, entry) => sum + entry.cost, 0);
		const byAge = [...entries.entries()]
			.filter(([key]) => key !== keep)
			.sort(([, a], [, b]) => a.used - b.used);
		for (const [key, entry] of byAge) {
			if (held <= budget) break;
			held -= entry.cost;
			drop(key);
		}
	};

	const open = (workspace: TypeServiceWorkspace): Entry => {
		const overlay = workspace.overlay ?? {};
		const held = entries.get(workspace.key);
		if (held !== undefined && held.root === resolve(workspace.root)) {
			// A changed draft bumps only its own version: the next query re-checks that file alone.
			const bump = (path: string): void => {
				const file = join(held.root, path);
				held.versions.set(file, (held.versions.get(file) ?? 0) + 1);
			};
			for (const [path, text] of Object.entries(overlay))
				if (held.overlay[path] !== text) bump(path);
			for (const path of Object.keys(held.overlay)) if (!(path in overlay)) bump(path);
			held.overlay = overlay;
			held.used = now();
			return held;
		}
		if (held !== undefined) drop(workspace.key);
		const root = resolve(workspace.root);
		const configPath = join(root, 'tsconfig.json');
		if (!existsSync(configPath))
			throw new Error(`No tsconfig.json at ${root}: the workspace cannot be type-checked.`);
		const config = ts.getParsedCommandLineOfConfigFile(
			configPath,
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
					throw new Error(flatten(diagnostic.messageText));
				}
			}
		);
		if (config === undefined) throw new Error(`${configPath} could not be parsed.`);
		// `allowNonTsExtensions` admits a `.svelte` root file, as the Svelte language server does.
		const compilerOptions: ts.CompilerOptions = {
			...config.options,
			noEmit: true,
			allowNonTsExtensions: true
		};
		delete compilerOptions['plugins'];
		const versions = new Map<string, number>();
		const components = new Set<string>();
		const converted = new Map<string, Component>();
		const entryRef: { current?: Entry } = {};
		const draft = (file: string): string | undefined => {
			const path = relative(root, file);
			return path.startsWith('..') || isAbsolute(path)
				? undefined
				: entryRef.current?.overlay[path];
		};
		const text = (file: string): string | undefined =>
			draft(file) ?? (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
		const moduleHost: ts.ModuleResolutionHost = {
			fileExists: (file) => draft(file) !== undefined || ts.sys.fileExists(file),
			readFile: (file) => draft(file) ?? ts.sys.readFile(file),
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath })
		};
		const cache = ts.createModuleResolutionCache(
			root,
			(file) => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
			compilerOptions
		);
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [
				...new Set([
					...config.fileNames,
					...shims,
					...components,
					...Object.keys(entryRef.current?.overlay ?? overlay)
						.filter((path) => /\.[cm]?tsx?$/.test(path))
						.map((path) => join(root, path))
				])
			],
			getScriptVersion: (file) => String(versions.get(file) ?? 0),
			getScriptKind: (file) => (isComponent(file) ? ts.ScriptKind.TS : ts.ScriptKind.Unknown),
			getScriptSnapshot: (file) => {
				const source = text(file);
				if (source === undefined) return undefined;
				if (!isComponent(file)) return ts.ScriptSnapshot.fromString(source);
				let component = converted.get(file);
				if (component?.source !== source) {
					component = convert(file, source);
					converted.set(file, component);
				}
				return ts.ScriptSnapshot.fromString(component.code);
			},
			resolveModuleNameLiterals: (literals, containingFile, redirected, options) =>
				literals.map((literal) => {
					const name = literal.text;
					if (isComponent(name) && name.startsWith('.')) {
						const file = resolve(dirname(containingFile), name);
						if (moduleHost.fileExists(file))
							return {
								resolvedModule: { resolvedFileName: file, extension: ts.Extension.Ts }
							};
					}
					return ts.resolveModuleName(name, containingFile, options, moduleHost, cache, redirected);
				}),
			getCurrentDirectory: () => root,
			getCompilationSettings: () => compilerOptions,
			getDefaultLibFileName: ts.getDefaultLibFilePath,
			fileExists: (file) => draft(file) !== undefined || ts.sys.fileExists(file),
			readFile: (file) => draft(file) ?? ts.sys.readFile(file),
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			// Without it a pnpm-isolated dependency does not resolve from its package's own directory.
			...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath })
		};
		const before = process.memoryUsage().heapUsed;
		const service = ts.createLanguageService(host, registry);
		const program = service.getProgram();
		// A collection landing mid-build reads as no growth at all, and a 0-cost program is never
		// evicted. The program's source size is the floor: a parsed and bound program holds about 35×
		// its text (17 MB of declarations → 620 MB, field-operations, 2026-09-25).
		const floor =
			(program?.getSourceFiles().reduce((bytes, source) => bytes + source.text.length, 0) ?? 0) *
			PROGRAM_BYTES_PER_SOURCE_BYTE;
		const entry: Entry = {
			root,
			service,
			versions,
			components,
			converted,
			overlay,
			cost: Math.max(floor, process.memoryUsage().heapUsed - before),
			used: now()
		};
		entryRef.current = entry;
		entries.set(workspace.key, entry);
		reclaim(workspace.key);
		return entry;
	};

	const readOf =
		(entry: Entry) =>
		(path: string): string | undefined => {
			const drafted = entry.overlay[path];
			if (drafted !== undefined) return drafted;
			const file = join(entry.root, path);
			return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
		};

	const inside = (root: string, file: string): string => {
		const path = relative(root, file);
		return path.startsWith('..') || isAbsolute(path) ? file : path;
	};

	/** The program's copy of a workspace file; a component joins the program when first asked about. */
	const sourceOf = (entry: Entry, path: string): ts.SourceFile => {
		const file = join(entry.root, path);
		if (isComponent(file) && (existsSync(file) || path in entry.overlay))
			entry.components.add(file);
		const source = entry.service.getProgram()?.getSourceFile(file);
		if (source === undefined)
			throw new Error(
				`${path} is not a file of this workspace's program: it does not exist, or tsconfig.json does not include it.`
			);
		return source;
	};

	/** A position in a program file as its author reads it: a component's, in its `.svelte` source. */
	const authored = (
		entry: Entry,
		source: ts.SourceFile,
		start: number
	): { line: number; character: number } | undefined => {
		const at = source.getLineAndCharacterOfPosition(start);
		const component = entry.converted.get(source.fileName);
		return component === undefined ? at : translate(component.toOriginal, at.line, at.character);
	};

	return {
		hover: (workspace, position) => {
			const entry = open(workspace);
			const source = sourceOf(entry, position.path);
			const [line, column] = [Math.max(0, position.line - 1), Math.max(0, position.column - 1)];
			const component = entry.converted.get(source.fileName);
			const at =
				component === undefined
					? { line, character: column }
					: translate(component.toGenerated, line, column);
			const starts = source.getLineStarts();
			if (at === undefined || at.line >= starts.length) return undefined;
			// A column past the line's end is the line's end: the compiler asserts on anything further.
			const offset = Math.min(
				starts[at.line]! + at.character,
				(starts[at.line + 1] ?? source.text.length + 1) - 1
			);
			const info = entry.service.getQuickInfoAtPosition(source.fileName, offset);
			if (info === undefined) return undefined;
			const [definition] = entry.service.getDefinitionAtPosition(source.fileName, offset) ?? [];
			const declared =
				definition === undefined
					? undefined
					: entry.service.getProgram()?.getSourceFile(definition.fileName);
			const where =
				definition === undefined || declared === undefined
					? undefined
					: authored(entry, declared, definition.textSpan.start);
			const documentation = ts.displayPartsToString(info.documentation);
			const declaredPath =
				definition === undefined ? undefined : inside(entry.root, definition.fileName);
			// A collection's generated `$types.d.ts` is not where anyone wrote the field: point at the
			// model column and carry the comment its author put there.
			const generated =
				declaredPath === undefined || definition === undefined
					? undefined
					: GENERATED_COLLECTION.exec(declaredPath);
			const authoredField =
				generated === null || generated === undefined || definition === undefined
					? undefined
					: collectionDocs(readOf(entry), generated[1]!)?.fields[definition.name];
			return {
				text: ts.displayPartsToString(info.displayParts),
				documentation: documentation === '' ? (authoredField?.text ?? '') : documentation,
				...(authoredField !== undefined
					? { definition: sourceLocation(authoredField.source) }
					: where === undefined || declaredPath === undefined
						? {}
						: { definition: { path: declaredPath, line: where.line + 1 } })
			};
		},
		named: (workspace, name) => {
			const entry = open(workspace);
			const read = readOf(entry);
			const hash = name.indexOf('#');
			const dotted = /^(automations|functions|apps|channels)\.([A-Za-z0-9_-]+)$/.exec(name);
			const candidates =
				hash >= 0
					? [name.slice(0, hash)]
					: dotted !== null
						? authoredFileOf(dotted[1]!, dotted[2]!)
						: /\.(?:[cm]?ts|svelte)$/.test(name)
							? [name]
							: [];
			if (candidates.length === 0)
				throw new Error(
					`${name} is not a workspace name: use automations.<name>, functions.<name>, apps.<name>, channels.<name>, <path>#<export> or a file path; collections.<name> is answered from the index.`
				);
			const path = candidates.find((candidate) => read(candidate) !== undefined);
			if (path === undefined)
				throw new Error(`${name}: no ${candidates.join(' or ')} in this workspace.`);
			const symbol = hash >= 0 ? name.slice(hash + 1) || undefined : undefined;
			const exportName = symbol ?? 'default';
			const source = sourceOf(entry, path);
			const checker = entry.service.getProgram()?.getTypeChecker();
			const module = checker?.getSymbolAtLocation(source);
			const exported =
				checker === undefined || module === undefined
					? undefined
					: checker.getExportsOfModule(module).find((entry) => entry.name === exportName);
			if (checker === undefined || exported === undefined)
				throw new Error(`${path} has no export ${exportName}.`);
			const target =
				(exported.flags & ts.SymbolFlags.Alias) !== 0
					? checker.getAliasedSymbol(exported)
					: exported;
			const declaration = target.valueDeclaration ?? target.declarations?.[0];
			const type =
				declaration === undefined
					? checker.getDeclaredTypeOfSymbol(target)
					: checker.getTypeOfSymbolAtLocation(target, declaration);
			const text = read(path) ?? '';
			const line = declarationLine(path, text, symbol);
			const written = docAtLine(path, text, line);
			const documentation = ts.displayPartsToString(target.getDocumentationComment(checker));
			return {
				text: `${exportName}: ${checker.typeToString(type, source, ts.TypeFormatFlags.NoTruncation).slice(0, 6_000)}`,
				documentation: documentation === '' ? written : documentation,
				definition: { path, line }
			};
		},
		check: (workspace, paths) => {
			const entry = open(workspace);
			return paths
				.flatMap((path) => {
					const source = sourceOf(entry, path);
					return [
						...entry.service.getSyntacticDiagnostics(source.fileName),
						...entry.service.getSemanticDiagnostics(source.fileName)
					].flatMap((diagnostic) => {
						const at =
							diagnostic.file === undefined || diagnostic.start === undefined
								? { line: 0, character: 0 }
								: authored(entry, diagnostic.file, diagnostic.start);
						// A component diagnostic with no source position is in svelte2tsx's scaffolding.
						if (at === undefined) return [];
						return [
							{
								path,
								line: at.line + 1,
								column: at.character + 1,
								code: diagnostic.code,
								message: flatten(diagnostic.messageText)
							}
						];
					});
				})
				.slice(0, MAX_DIAGNOSTICS);
		},
		stats: () => ({
			workspaces: entries.size,
			heapBytes: [...entries.values()].reduce((sum, entry) => sum + entry.cost, 0),
			evictions
		}),
		dispose: () => {
			for (const key of [...entries.keys()]) drop(key);
			evictions = 0;
		}
	};
};

/**
 * The two tools a host mounts for its authoring agent, specified once here so every host offers the
 * same contract. The host maps its own session to a `TypeServiceWorkspace` and forwards the input.
 */
/** What a collection's authored files say, read the way `bolt sync` reads them into the index. */
export { collectionDocs, readFromDisk } from './authored-docs.js';

/**
 * The answer `workspace_type` gives from the live service, in the shape the sync-time index answers
 * collections with: the type, the author's comment, and the `path:line` to read.
 */
export const answerTypeQuery = (
	service: WorkspaceTypeService,
	workspace: TypeServiceWorkspace,
	query: Readonly<{ name?: string; path?: string; line?: number; column?: number }>
): Readonly<{ found: boolean; type?: string; docs?: string; source?: string }> => {
	const hover =
		query.name !== undefined
			? service.named(workspace, query.name)
			: query.path !== undefined && query.line !== undefined && query.column !== undefined
				? service.hover(workspace, { path: query.path, line: query.line, column: query.column })
				: (() => {
						throw new Error('workspace_type takes a name, or a path with line and column.');
					})();
	if (hover === undefined) return { found: false };
	return {
		found: true,
		type: hover.text,
		...(hover.documentation === '' ? {} : { docs: hover.documentation }),
		...(hover.definition === undefined
			? {}
			: { source: `${hover.definition.path}:${hover.definition.line}` })
	};
};

/**
 * The tools a host mounts for its authoring agent, specified once here so every host offers the
 * same contract. `workspace_type` shares its name with Bolt's platform tool, which answers
 * collection names from the index and hands everything else here; the model sees one tool.
 */
export const typeServiceTools = [
	{
		name: 'workspace_type',
		description:
			'The live half of workspace_type: names other than collections, and file positions, resolved by the compiler against your current draft.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1 },
				path: { type: 'string', minLength: 1 },
				line: { type: 'integer', minimum: 1 },
				column: { type: 'integer', minimum: 1 }
			},
			additionalProperties: false
		},
		readOnly: true
	},
	{
		name: 'workspace_check',
		description:
			'Type-check workspace files against your current draft in well under a second, without a build: the compiler errors each file has, with line and column. Run it after an edit, before workspace_validate.',
		inputSchema: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 50 }
			},
			required: ['paths'],
			additionalProperties: false
		},
		readOnly: true
	}
] as const;
