/**
 * `.doctorignore` — repository-scoped scan exclusions, ported from `engine/scripts/ignore.mjs`.
 *
 * The TypeScript build is rooted at `src/`, so the analyzer carries its own copy of the engine
 * module. That copy is a liability only if the two drift, so it is kept line-for-line with it: the analyzer's file inventory and the scanner's are
 * cross-checked by digest, and an exclusion honored on one side only makes every scan report as
 * stale rather than as scoped.
 *
 * The format is `.gitignore`'s familiar subset: one glob per line, `#` comments, blank lines
 * ignored, `!` to re-include. Paths are repository-relative with POSIX separators. An
 * `inherit:` line borrows the exclusion globs of another ignore file in the same repository.
 */
// repository-health:allow STATE2 -- parsed ignore rules cached per repository root for the scan's lifetime; clearIgnoreCache exists for the long-lived-process case and re-reading .doctorignore per file would dominate scan cost.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One translated glob: whether it excludes or re-includes, scoped rule ids, and its matcher. */
type IgnoreRule = Readonly<{
	negated: boolean;
	rules: ReadonlyArray<string>;
	expression: RegExp;
}>;

const CACHE = new Map<string, ReadonlyArray<IgnoreRule>>();

/** Forget one root's parsed rules so a long-lived process observes edits to `.doctorignore`. */
export function clearIgnoreCache(root: string): void {
	CACHE.delete(root);
}

/** Translate one `.gitignore`-style glob into an anchored expression. */
function toRegExp(pattern: string): IgnoreRule {
	const negated = pattern.startsWith('!');
	const body = negated ? pattern.slice(1) : pattern;
	const [glob, ...rules] = body.split(/\s+/).filter(Boolean);
	const anchored = (glob ?? '').startsWith('/') ? (glob ?? '').slice(1) : (glob ?? '');
	const escaped = anchored.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const expression = escaped
		.replace(/\*\*\//g, ' SLASH ')
		.replace(/\*\*/g, ' ANY ')
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(/ SLASH /g, '(?:.*/)?')
		.replace(/ ANY /g, '.*');
	// A bare directory name excludes the tree beneath it, as git does.
	const source = anchored.endsWith('/') ? `${expression}.*` : `${expression}(?:/.*)?`;
	return { negated, rules, expression: new RegExp(`^${source}$`) };
}

/** Files this one can borrow exclusions from, named by an `inherit:` line. */
const INHERIT = /^inherit:\s*(.+)$/;

/** Parsed rules for a root, or an empty list when it has no `.doctorignore`. */
export function ignoreRules(root: string): ReadonlyArray<IgnoreRule> {
	const cached = CACHE.get(root);
	if (cached !== undefined) return cached;
	const path = join(root, '.doctorignore');
	const rules: Array<IgnoreRule> = [];
	if (existsSync(path)) {
		const lines = readFileSync(path, 'utf8')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== '' && !line.startsWith('#'));
		for (const line of lines) {
			const inherited = INHERIT.exec(line);
			if (inherited === null) {
				rules.push(toRegExp(line));
				continue;
			}
			for (const name of (inherited[1] ?? '').split(/\s+/).filter(Boolean)) {
				const source = join(root, name);
				if (!existsSync(source)) continue;
				for (const borrowed of readFileSync(source, 'utf8').split(/\r?\n/)) {
					const entry = borrowed.trim();
					if (entry === '' || entry.startsWith('#') || entry.startsWith('!')) continue;
					rules.push(toRegExp(entry));
				}
			}
		}
	}
	CACHE.set(root, rules);
	return rules;
}

/**
 * Whether a repository-relative file leaves the scan entirely.
 *
 * Only bare globs do this. A line that names rules keeps the file in the inventory and silences
 * just those rules, so the scanner's and the analyzer's file lists continue to agree. Later lines
 * win, so a `!` line can re-include a path an earlier glob removed.
 */
export function ignoredFile(root: string, file: string): boolean {
	let excluded = false;
	for (const { negated, rules, expression } of ignoreRules(root))
		if (rules.length === 0 && expression.test(file)) excluded = !negated;
	return excluded;
}

/**
 * Whether one rule is scoped out for one file: source that is deliberately outside a rule set's
 * architecture rather than a rule that silently stopped applying.
 */
export function ignoredRule(root: string, file: string, ruleId: string): boolean {
	let excluded = false;
	for (const { negated, rules, expression } of ignoreRules(root))
		if (rules.length > 0 && rules.includes(ruleId) && expression.test(file)) excluded = !negated;
	return excluded;
}
