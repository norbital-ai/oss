/**
 * The rule authoring surface.
 *
 * A rule is a plain object with a `check` function. It is authored in TypeScript, committed to the
 * repository like any other source, and picked up by the plugin and the CLI without a build step —
 * Node strips the types on import. That is the whole point: a person or an agent adds a file, opens
 * a pull request, and the next audit enforces it.
 *
 * Rules run in the syntactic tier: one file at a time, no cross-file state, no type checker. That
 * restriction is what makes them cheap enough to run on every save and safe to run in parallel.
 *
 * ```ts
 * // dr/rules/no-raw-fetch.ts
 * import { defineRule } from '@norbital-ai/doctor';
 *
 * export default defineRule({
 *   id: 'ACME1',
 *   severity: 'error',
 *   summary: 'raw fetch bypasses the http client',
 *   principles: ['straightforwardness', 'testability'],
 *   when: ['CallExpression'],
 *   check(node, context) {
 *     if (context.calleeName(node) !== 'fetch') return;
 *     context.report(node, 'callee=fetch prefer=@acme/http#request');
 *   }
 * });
 * ```
 */
import ts from 'typescript';

/**
 * Health is strict: a finding is either something to fix or inventory to read.
 *
 * There is no middle tier. A "warning" is a finding nobody is accountable for — it accumulates,
 * and a gate that tolerates a growing pile of them is not a gate. Rules that describe real debt
 * are errors; rules that only nominate candidates for review are hints and never fail a run.
 */
export type Severity = 'error' | 'hint';
export type Confidence = 'high' | 'medium';

/** The eight report axes. A finding carries one or more; they explain why it matters. */
/** Canonical report order. Findings must carry principles in this order, whatever a rule declares. */
export const PRINCIPLE_ORDER = [
	'simplicity',
	'straightforwardness',
	'modularity',
	'testability',
	'efficiency',
	'type-safety',
	'colocation',
	'no-bloat'
] as const;

export type Principle =
	| 'simplicity'
	| 'straightforwardness'
	| 'modularity'
	| 'testability'
	| 'efficiency'
	| 'type-safety'
	| 'colocation'
	| 'no-bloat';

/**
 * A TypeScript syntax-kind name, e.g. `'CallExpression'`.
 *
 * Named rather than numeric so a rule reads as prose and a typo is a type error.
 */
export type NodeKind = keyof typeof ts.SyntaxKind;

export type RuleContext = Readonly<{
	/** Repository-relative path, POSIX separators. */
	readonly file: string;
	readonly source: string;
	readonly root: string;
	readonly sourceFile: ts.SourceFile;
	/** The compiler namespace, so a rule can use `ts.isCallExpression` and friends. */
	readonly ts: typeof ts;

	/** Source text of a node. */
	text(node: ts.Node): string;
	/** Enclosing nodes, nearest first. */
	ancestors(node: ts.Node): ReadonlyArray<ts.Node>;
	/** `foo.bar()` → `'foo.bar'`; `fetch()` → `'fetch'`; otherwise undefined. */
	calleeName(node: ts.Node): string | undefined;
	/** Every module this file imports, mapped to the names it took from each. */
	imports(): ReadonlyMap<string, ReadonlySet<string>>;
	/** True when the file imports `specifier` or a subpath of it. */
	importsFrom(specifier: string): boolean;

	/**
	 * Record a finding at this node.
	 *
	 * `evidence` is mechanically derived detail — the matched callee, the offending class, the
	 * competing owner. It is read by a person deciding on a repair, so state what was found, not
	 * what to do about it.
	 */
	report(node: ts.Node, evidence?: string): void;
	/**
	 * Report at a 1-based line rather than a node.
	 *
	 * Markup has no node: a component's `class` attribute never reaches the script AST, so a rule
	 * about it can only name a line. Reporting such a match against the file's root node pointed
	 * every layout finding at line 1, which is not where the person has to edit.
	 */
	reportAt(line: number, evidence?: string): void;
}>;

export type Rule = Readonly<{
	/** Stable identifier, unique across every loaded pack. Appears in the catalogue. */
	readonly id: string;
	readonly severity: Severity;
	/** How strongly the syntax implies a problem. Defaults to `high`. */
	readonly confidence?: Confidence | undefined;
	/** One line, lowercase, describing the defect rather than the fix. */
	readonly summary: string;
	readonly principles: ReadonlyArray<Principle>;
	/** Syntax kinds this rule wants. The engine dispatches by kind, so keep it narrow. */
	readonly when: ReadonlyArray<NodeKind>;
	/** Restrict to files matching any of these patterns (`*` and `**` supported). */
	readonly files?: ReadonlyArray<string> | undefined;
	/** Skip files matching any of these patterns. */
	readonly ignore?: ReadonlyArray<string> | undefined;
	/**
	 * Rules whose finding at the same site *is* this rule's finding, stated less specifically.
	 *
	 * When both fire on one line the dominated one is dropped, so a single defect counts once. This
	 * belongs on the rule rather than in a central table: a pack that adds a sharper rule over
	 * someone else's general one can say so without editing the engine.
	 */
	readonly dominates?: ReadonlyArray<string> | undefined;
	check(node: ts.Node, context: RuleContext): void;
}>;

export type Pack = Readonly<{
	readonly name: string;
	readonly rules: ReadonlyArray<Rule>;
}>;

/**
 * Validate a visitor-form rule.
 *
 * Not the authoring surface — `defineRule` in `pattern.ts` is, and it funnels both forms here so
 * every rule is validated identically however it was written.
 */
export function defineVisitorRule(rule: Rule): Rule {
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(rule.id))
		throw new Error(`norbital-doctor: rule id must be alphanumeric, received "${rule.id}"`);
	if (rule.when.length === 0)
		throw new Error(
			`norbital-doctor: rule ${rule.id} matches no syntax kinds; "when" cannot be empty`
		);
	for (const kind of rule.when)
		if (ts.SyntaxKind[kind] === undefined)
			throw new Error(`norbital-doctor: rule ${rule.id} names an unknown syntax kind "${kind}"`);
	if (rule.principles.length === 0)
		throw new Error(`norbital-doctor: rule ${rule.id} must carry at least one principle`);
	if (rule.dominates?.includes(rule.id) === true)
		throw new Error(`norbital-doctor: rule ${rule.id} cannot dominate itself`);
	return rule;
}

/** Group rules under a name so a repository can adopt or drop them together. */
export function definePack(pack: Pack): Pack {
	const seen = new Set<string>();
	for (const rule of pack.rules) {
		if (seen.has(rule.id))
			throw new Error(`norbital-doctor: pack ${pack.name} declares rule ${rule.id} twice`);
		seen.add(rule.id);
	}
	return pack;
}
