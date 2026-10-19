/**
 * `.doctorignore` — repository-scoped scan exclusions.
 *
 * Some source is deliberately outside a rule set's architecture: a build-time tool that cannot take
 * the runtime's dependencies, a vendored detector, a fixture corpus that exists to be malformed.
 * The per-finding `repository-health:allow` comment answers "this one line is a reviewed
 * exception"; it does not answer "this whole tree is out of scope", and thirty allowances in a row
 * is not a reviewed exception, it is a missing setting.
 *
 * The format is `.gitignore`'s familiar subset: one glob per line, `#` comments, blank lines
 * ignored, `!` to re-include. Paths are repository-relative with POSIX separators.
 *
 * The syntactic runner and the type-aware tier both read it here, so an exclusion holds for every
 * tier.
 */
// repository-health:allow STATE2 -- parsed rules cached per root; `sourceFiles` clears the entry before each scan, and re-reading `.doctorignore` per scanned path would dominate scan cost.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

type IgnoreRule = Readonly<{
	/** A leading `!` re-includes a path an earlier glob removed. */
	negated: boolean;
	/**
	 * Rule ids named after the glob. Empty means the whole file leaves the scan; non-empty means
	 * the file is still parsed and counted and only these rules are silenced for it.
	 */
	rules: ReadonlyArray<string>;
	globs: ReadonlyArray<string>;
}>;

const CACHE = new Map<string, ReadonlyArray<IgnoreRule>>();

/** Forget one root's parsed rules so a long-lived process observes edits to `.doctorignore`. */
export function clearIgnoreCache(root: string): void {
	CACHE.delete(root);
}

/** One `.gitignore`-style line. A bare directory name excludes the tree beneath it, as git does. */
function parseLine(pattern: string): IgnoreRule {
	const negated = pattern.startsWith('!');
	const body = negated ? pattern.slice(1) : pattern;
	const [glob = '', ...rules] = body.split(/\s+/).filter(Boolean);
	const anchored = glob.startsWith('/') ? glob.slice(1) : glob;
	const globs = anchored.endsWith('/') ? [`${anchored}**`] : [anchored, `${anchored}/**`];
	return { negated, rules, globs };
}

const covers = (rule: IgnoreRule, file: string): boolean =>
	rule.globs.some((glob) => posix.matchesGlob(file, glob));

/**
 * Ignore files this one can borrow from, named by an `inherit:` line.
 *
 * A repository already states what is not source — in `.gitignore`, `.prettierignore`,
 * `.dockerignore`, `.eslintignore`. Restating it here is how the two drift, and the drift is
 * invisible until a scan reports a build directory as unscanned production code. `inherit:` reads
 * those files in place instead:
 *
 * ```
 * inherit: .gitignore .prettierignore
 * packages/doctor/src/  EFF1 EFF2 EFF3 IO1
 * ```
 *
 * Only exclusions are borrowed. A `!` re-inclusion in a borrowed file is skipped, because those
 * exist to make a build artifact committable, not to make it source.
 */
const INHERIT = /^inherit:\s*(.+)$/;

/** Parsed rules for a root, or an empty list when it has no `.doctorignore`. */
function ignoreRules(root: string): ReadonlyArray<IgnoreRule> {
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
			const inherited = INHERIT.exec(line)?.[1];
			if (inherited === undefined) {
				rules.push(parseLine(line));
				continue;
			}
			for (const name of inherited.split(/\s+/).filter(Boolean)) {
				const source = join(root, name);
				if (!existsSync(source)) continue;
				for (const borrowed of readFileSync(source, 'utf8').split(/\r?\n/)) {
					const entry = borrowed.trim();
					if (entry === '' || entry.startsWith('#') || entry.startsWith('!')) continue;
					rules.push(parseLine(entry));
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
 * just those rules — the file is still parsed, still graph-resolved, still counted.
 *
 * Later lines win, so a `!` line can re-include a path an earlier glob removed.
 */
export function ignoredFile(root: string, file: string): boolean {
	let excluded = false;
	for (const rule of ignoreRules(root))
		if (rule.rules.length === 0 && covers(rule, file)) excluded = !rule.negated;
	return excluded;
}

/**
 * Whether one rule is scoped out for one file.
 *
 * This is for source that is deliberately outside a rule set's architecture — a build-time tool
 * that cannot take the runtime's dependencies — rather than for silencing a rule that applies.
 * Scoping out every rule for a path is what the bare-glob form is for.
 */
export function ignoredRule(root: string, file: string, ruleId: string): boolean {
	let excluded = false;
	for (const rule of ignoreRules(root))
		if (rule.rules.includes(ruleId) && covers(rule, file)) excluded = !rule.negated;
	return excluded;
}
