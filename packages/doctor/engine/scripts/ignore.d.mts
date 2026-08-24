/**
 * Types for the hand-written `.doctorignore` reader that the engine and the analyzer share.
 *
 * The module itself stays `.mjs` because both scanner processes import it directly; this file is
 * what lets the TypeScript side consume it without widening anything to `any`.
 */

export type IgnoreRule = Readonly<{
	/** A leading `!` re-includes a path an earlier glob removed. */
	negated: boolean;
	/**
	 * Rule ids named after the glob. Empty means the whole file leaves the scan; non-empty means
	 * the file is still parsed and counted and only these rules are silenced for it.
	 */
	rules: ReadonlyArray<string>;
	expression: RegExp;
}>;

/** Forget one root's parsed rules so a long-lived process observes edits to `.doctorignore`. */
export function clearIgnoreCache(root: string): void;

/** Parsed rules for a root, or an empty list when it has no `.doctorignore`. */
export function ignoreRules(root: string): ReadonlyArray<IgnoreRule>;

/** Whether a repository-relative file leaves the scan entirely. */
export function ignoredFile(root: string, file: string): boolean;

/** Whether one rule is scoped out for one file that otherwise stays in the scan. */
export function ignoredRule(root: string, file: string, ruleId: string): boolean;
