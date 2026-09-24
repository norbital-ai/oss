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
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';

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
	check(workspace: TypeServiceWorkspace, paths: ReadonlyArray<string>): ReadonlyArray<TypeDiagnostic>;
	stats(): TypeServiceStats;
	dispose(): void;
}

const DEFAULT_BUDGET = 1024 * 1024 * 1024;
const DEFAULT_IDLE = 10 * 60 * 1000;
/** Diagnostics answered per check; past this the list stops helping a reader. */
const MAX_DIAGNOSTICS = 200;

type Entry = {
	readonly root: string;
	readonly service: ts.LanguageService;
	readonly versions: Map<string, string>;
	overlay: Readonly<Record<string, string>>;
	cost: number;
	used: number;
};

const flatten = (message: string | ts.DiagnosticMessageChain): string =>
	ts.flattenDiagnosticMessageText(message, '\n');

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
		if (held !== undefined && held.root === workspace.root) {
			// A changed draft bumps only its own version: the next query re-checks that file alone.
			for (const [path, text] of Object.entries(overlay))
				if (held.overlay[path] !== text) held.versions.set(join(held.root, path), String(now()));
			for (const path of Object.keys(held.overlay))
				if (!(path in overlay)) held.versions.set(join(held.root, path), String(now()));
			held.overlay = overlay;
			held.used = now();
			return held;
		}
		if (held !== undefined) drop(workspace.key);
		const root = workspace.root;
		const configPath = join(root, 'tsconfig.json');
		if (!existsSync(configPath))
			throw new Error(`No tsconfig.json at ${root}: the workspace cannot be type-checked.`);
		const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(flatten(diagnostic.messageText));
			}
		});
		if (config === undefined) throw new Error(`${configPath} could not be parsed.`);
		const compilerOptions: ts.CompilerOptions = { ...config.options, noEmit: true };
		delete compilerOptions['plugins'];
		const versions = new Map<string, string>();
		const entryRef: { current?: Entry } = {};
		const draft = (file: string): string | undefined => {
			const path = relative(root, file);
			return path.startsWith('..') || isAbsolute(path)
				? undefined
				: entryRef.current?.overlay[path];
		};
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [
				...new Set([
					...config.fileNames,
					...Object.keys(entryRef.current?.overlay ?? overlay)
						.filter((path) => /\.[cm]?tsx?$/.test(path))
						.map((path) => join(root, path))
				])
			],
			getScriptVersion: (file) => versions.get(file) ?? '0',
			getScriptSnapshot: (file) => {
				const text = draft(file) ?? (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
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
		service.getProgram();
		const entry: Entry = {
			root,
			service,
			versions,
			overlay,
			cost: Math.max(0, process.memoryUsage().heapUsed - before),
			used: now()
		};
		entryRef.current = entry;
		entries.set(workspace.key, entry);
		reclaim(workspace.key);
		return entry;
	};

	const inside = (root: string, file: string): string => {
		const path = relative(root, file);
		return path.startsWith('..') || isAbsolute(path) ? file : path;
	};

	return {
		hover: (workspace, position) => {
			const entry = open(workspace);
			const file = join(entry.root, position.path);
			const source = entry.service.getProgram()?.getSourceFile(file);
			if (source === undefined) return undefined;
			const offset = source.getPositionOfLineAndCharacter(
				Math.max(0, position.line - 1),
				Math.max(0, position.column - 1)
			);
			const info = entry.service.getQuickInfoAtPosition(file, offset);
			if (info === undefined) return undefined;
			const [definition] = entry.service.getDefinitionAtPosition(file, offset) ?? [];
			const defined =
				definition === undefined
					? undefined
					: {
							path: inside(entry.root, definition.fileName),
							line:
								(entry.service.getProgram()?.getSourceFile(definition.fileName)
									?.getLineAndCharacterOfPosition(definition.textSpan.start).line ?? 0) + 1
						};
			return {
				text: ts.displayPartsToString(info.displayParts),
				documentation: ts.displayPartsToString(info.documentation),
				...(defined === undefined ? {} : { definition: defined })
			};
		},
		check: (workspace, paths) => {
			const entry = open(workspace);
			return paths
				.flatMap((path) => {
					const file = join(entry.root, path);
					return [
						...entry.service.getSyntacticDiagnostics(file),
						...entry.service.getSemanticDiagnostics(file)
					].map((diagnostic) => {
						const at =
							diagnostic.file === undefined || diagnostic.start === undefined
								? { line: 0, character: 0 }
								: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
						return {
							path,
							line: at.line + 1,
							column: at.character + 1,
							code: diagnostic.code,
							message: flatten(diagnostic.messageText)
						};
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
export const typeServiceTools = [
	{
		name: 'workspace_hover',
		description:
			'The type of the symbol at a line and column of a workspace file, as the compiler resolves it — a variable, a call signature, a component prop, a platform API — with where it is declared. Line and column are 1-based, as workspace_read numbers them. Faster and more exact than reading the declaration.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', minLength: 1 },
				line: { type: 'integer', minimum: 1 },
				column: { type: 'integer', minimum: 1 }
			},
			required: ['path', 'line', 'column'],
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
