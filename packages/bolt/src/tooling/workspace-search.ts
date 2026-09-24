/**
 * Structural search over a workspace, answered by the doctor's engine.
 *
 * The doctor already speaks ast-grep's rule language — `pattern` with `$A` / `$$$` metavariables,
 * `kind`, `has`, `inside`, `utils`, `constraints` — over TypeScript and over a `.svelte` file's markup
 * and script alike. A search is that engine asked one question instead of a pack of rules: no second
 * parser, no second language, and a query that finds something is already the body of a doctor rule
 * that would flag it. Nothing stays warm; each file is parsed, matched and dropped.
 *
 * Bolt's, not a host's: a host says where the workspace lives and which draft overlays it, and mounts
 * the tool `searchTools` describes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { searchRule, searchRules, sourceFiles, type Matcher } from '@norbital-ai/doctor';

export interface SearchWorkspace {
	/**
	 * A directory holding the workspace source. Absent when the overlay is the whole draft — a host
	 * whose draft store already holds every authored file needs no tree on disk to search it.
	 */
	readonly root?: string;
	/** Draft contents by workspace-relative path; each overrides the file on disk. */
	readonly overlay?: Readonly<Record<string, string>>;
}

export interface SearchQuery {
	/** Code with metavariables: `api.collection.$C.create($$$)`. Shorthand for `{ rule: { pattern } }`. */
	readonly pattern?: string;
	/** A doctor rule body: `{ all: [{ kind: 'svelte:Attribute' }, { regex: '^onclick' }] }`. */
	readonly rule?: Readonly<Record<string, unknown>>;
	/** Workspace-relative files or directories to search; the whole workspace when absent. */
	readonly paths?: ReadonlyArray<string>;
	readonly limit?: number;
}

export interface SearchMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
	/** What each metavariable bound, `$C=sites`, when the pattern has any. */
	readonly bindings?: string;
}

const SOURCE = /\.(?:[mc]?tsx?|[mc]?jsx?|svelte)$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const within = (path: string, paths: ReadonlyArray<string> | undefined): boolean =>
	paths === undefined ||
	paths.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`));

export const searchWorkspace = (
	workspace: SearchWorkspace,
	query: SearchQuery
): Readonly<{ matches: ReadonlyArray<SearchMatch>; total: number; truncated: boolean }> => {
	const matcher =
		query.rule !== undefined
			? query.rule
			: query.pattern !== undefined
				? { pattern: query.pattern }
				: undefined;
	if (matcher === undefined) throw new Error('workspace_search takes a pattern or a rule.');
	const overlay = workspace.overlay ?? {};
	const files = [
		...new Set([
			...(workspace.root === undefined
				? []
				: sourceFiles(workspace.root, query.paths === undefined ? {} : { paths: query.paths })),
			...Object.keys(overlay).filter((path) => SOURCE.test(path) && within(path, query.paths))
		])
	].sort();
	const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	const root = workspace.root;
	const found = searchRules({
		// The engine reads `.doctorignore` from its root; a draft-only search has none to honour.
		root: root ?? parse(process.cwd()).root,
		// A rule body the engine cannot compile throws here with the engine's own reason.
		rules: [searchRule(matcher as Matcher)],
		files,
		read: (path) => {
			const drafted = overlay[path];
			if (drafted !== undefined || root === undefined) return drafted;
			const file = join(root, path);
			return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
		},
		limit
	});
	return {
		matches: found.matches.map((match) => ({
			path: match.file,
			line: match.line,
			text: match.text,
			...(match.evidence === '' || match.evidence === 'matched' ? {} : { bindings: match.evidence })
		})),
		total: found.total,
		truncated: found.total > found.matches.length
	};
};

/** The tool a host mounts for its authoring agent. */
export const searchTools = [
	{
		name: 'workspace_search',
		description:
			"Find code in your current draft by structure, not text: every `.ts` and `.svelte` file, unsaved edits included. `pattern` is code with metavariables — `$A` one node, `$$$` any number (`api.collection.$C.create($$$)`, `defineCollection($$$)`). `rule` is the same object a doctor rule's `rule:` takes, for what a pattern cannot say: `{ kind: 'CallExpression', has: { pattern: 'refuse($$$)' } }`, `{ all: [{ kind: 'svelte:Attribute' }, { regex: '^onclick' }] }` (markup kinds: svelte:Element, svelte:Attribute, svelte:Directive, svelte:ClassToken, svelte:Interpolation, svelte:Block). Answers path, line, text and what each metavariable bound; read a hit with workspace_read, ask its type with workspace_type.",
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', minLength: 1 },
				rule: { type: 'object' },
				paths: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
				limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT }
			},
			additionalProperties: false
		},
		readOnly: true
	}
] as const;
