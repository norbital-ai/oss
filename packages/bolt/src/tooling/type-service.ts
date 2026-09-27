/// <reference types="node" />
// `@norbital-ai/bolt/type-service` (§3.3.10): hover, go-to-definition and a draft check over a workspace's own tsconfig,
// answered by a warm TypeScript language service. A host (a Studio, an editor) says where a workspace lives and
// which unsaved drafts overlay it; nothing is emitted and no tsconfig `plugins` load. Services stay warm in an LRU
// keyed by workspace, and share one document registry, so a pinned dependency's declarations are parsed once.
// ponytail: `.ts` files only; a `.svelte` file is not in the program (svelte2tsx mapping, as svelte-check does, when a host needs it).
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export type TypeServiceWorkspace = {
	/** The same key reuses the warm service. */
	readonly key: string;
	/** Holds the workspace's `tsconfig.json` and `node_modules`. */
	readonly root: string;
	/** Draft contents by workspace-relative path; each overrides the file on disk. */
	readonly overlay?: Readonly<Record<string, string>>;
};
/** 1-based, as an editor numbers them; `path` is workspace-relative. */
export type TypePosition = { readonly path: string; readonly line: number; readonly column: number };
export type TypeHover = { readonly text: string; readonly documentation: string };
export type TypeDiagnostic = TypePosition & { readonly code: number; readonly message: string };

type State = { overlay: Readonly<Record<string, string>>; versions: Map<string, number> };
type Entry = State & { root: string; service: ts.LanguageService };

const MAX_DIAGNOSTICS = 200;

export function typeService(o: { max?: number } = {}) {
	const max = o.max ?? 4;
	const registry = ts.createDocumentRegistry();
	const entries = new Map<string, Entry>();   // insertion order is recency

	function open(ws: TypeServiceWorkspace): Entry {
		const overlay = ws.overlay ?? {};
		const held = entries.get(ws.key);
		if (held !== undefined && held.root === resolve(ws.root)) {
			entries.delete(ws.key);
			entries.set(ws.key, held);
			for (const path of new Set([...Object.keys(held.overlay), ...Object.keys(overlay)]))
				if (held.overlay[path] !== overlay[path]) { const f = join(held.root, path); held.versions.set(f, (held.versions.get(f) ?? 0) + 1); }
			held.overlay = overlay;
			return held;
		}
		held?.service.dispose();
		const root = resolve(ws.root), configPath = join(root, 'tsconfig.json');
		if (!existsSync(configPath)) throw new Error(`No tsconfig.json at ${root}: the workspace cannot be type-checked.`);
		const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
		if (config === undefined) throw new Error(`${configPath} could not be parsed.`);
		const options: ts.CompilerOptions = { ...config.options, noEmit: true };
		delete options['plugins'];
		const state: State = { overlay, versions: new Map() };
		const draft = (file: string) => { const p = relative(root, file); return p.startsWith('..') || isAbsolute(p) ? undefined : state.overlay[p]; };
		const read = (file: string) => draft(file) ?? ts.sys.readFile(file);
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [...new Set([...config.fileNames, ...Object.keys(state.overlay).filter((p) => /\.[cm]?tsx?$/.test(p)).map((p) => join(root, p))])],
			getScriptVersion: (f) => String(state.versions.get(f) ?? 0),
			getScriptSnapshot: (f) => { const t = read(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
			getCurrentDirectory: () => root,
			getCompilationSettings: () => options,
			getDefaultLibFileName: ts.getDefaultLibFilePath,
			fileExists: (f) => draft(f) !== undefined || ts.sys.fileExists(f),
			readFile: read,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath }),
		};
		const entry: Entry = Object.assign(state, { root, service: ts.createLanguageService(host, registry) });
		entries.set(ws.key, entry);
		for (const [key, e] of entries) { if (entries.size <= max) break; e.service.dispose(); entries.delete(key); }
		return entry;
	}

	function at(ws: TypeServiceWorkspace, pos: TypePosition): { entry: Entry; file: string; offset: number } | undefined {
		const entry = open(ws), file = join(entry.root, pos.path);
		const source = entry.service.getProgram()?.getSourceFile(file);
		if (source === undefined) throw new Error(`${pos.path} is not a file of this workspace's program: it does not exist, or tsconfig.json does not include it.`);
		const starts = source.getLineStarts(), line = pos.line - 1;
		if (line < 0 || line >= starts.length) return undefined;
		return { entry, file, offset: Math.min(starts[line]! + Math.max(0, pos.column - 1), (starts[line + 1] ?? source.text.length + 1) - 1) };
	}

	const where = (entry: Entry, file: string, start: number): TypePosition | undefined => {
		const source = entry.service.getProgram()?.getSourceFile(file);
		if (source === undefined) return undefined;
		const lc = source.getLineAndCharacterOfPosition(start), p = relative(entry.root, file);
		return { path: p.startsWith('..') || isAbsolute(p) ? file : p, line: lc.line + 1, column: lc.character + 1 };
	};

	return {
		/** The checker's quick info at a position (`const x: T`, a signature), with its doc comment. */
		hover(ws: TypeServiceWorkspace, pos: TypePosition): TypeHover | undefined {
			const a = at(ws, pos);
			const info = a && a.entry.service.getQuickInfoAtPosition(a.file, a.offset);
			return info === undefined ? undefined : { text: ts.displayPartsToString(info.displayParts), documentation: ts.displayPartsToString(info.documentation) };
		},
		/** Where the symbol at a position is declared: workspace-relative inside the workspace, absolute outside it. */
		definition(ws: TypeServiceWorkspace, pos: TypePosition): TypePosition | undefined {
			const a = at(ws, pos);
			const [d] = (a && a.entry.service.getDefinitionAtPosition(a.file, a.offset)) ?? [];
			return d === undefined || a === undefined ? undefined : where(a.entry, d.fileName, d.textSpan.start);
		},
		/** Syntactic and semantic errors of `paths` with the drafts applied (at most 200). */
		check(ws: TypeServiceWorkspace, paths: readonly string[]): readonly TypeDiagnostic[] {
			const entry = open(ws), out: TypeDiagnostic[] = [];
			for (const path of paths) {
				const file = join(entry.root, path);
				for (const d of [...entry.service.getSyntacticDiagnostics(file), ...entry.service.getSemanticDiagnostics(file)]) {
					if (out.length >= MAX_DIAGNOSTICS) return out;
					const w = d.file === undefined || d.start === undefined ? { path, line: 1, column: 1 } : where(entry, d.file.fileName, d.start) ?? { path, line: 1, column: 1 };
					out.push({ ...w, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
				}
			}
			return out;
		},
		dispose(): void { for (const e of entries.values()) e.service.dispose(); entries.clear(); },
	};
}

export type TypeService = ReturnType<typeof typeService>;
