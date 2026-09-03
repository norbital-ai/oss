// repository-health:allow SEM_PARALLEL -- pattern forms the rule authoring surface carrying rules; provider/consumer of the same algebra.
/**
 * How a YAML rule document is compiled.
 *
 * Pack rules are declared as YAML. `defineRule` is the compiler: a `rule` field becomes a matcher,
 * and a `visitor` field is bound to a named check.
 *
 * Both forms compile to an ordinary `Rule`, so the runner, the ignore file, the allowance comments
 * and the catalogue treat them identically.
 *
 * Examples are mandatory on a matcher, and a composite must carry a negative. A rule with no
 * counter-example is the usual way a detector becomes noise: `QRY1` had no example of the defect
 * spelled a second way, so nobody noticed it recognised only the first.
 */
import ts from 'typescript';
import './analyses/index.js';
import { projectFile } from './frontend/markup.js';
import {
	bindMatchHost,
	bindingTexts,
	compile,
	match,
	matcherKinds,
	metavariablesOf,
	withUtils,
	type Bindings,
	type Constraints,
	type Matcher,
	type Utils
} from './matcher.js';
import { hasNamespacedKind, lineOf, matchTree } from './model.js';
import {
	defineVisitorRule,
	type NodeKind,
	type Confidence,
	type Principle,
	type Rule,
	type RuleContext,
	type Severity
} from './rules.js';

export type { Matcher, StopBy } from './matcher.js';

/** Source that must be reported, and source that must not. Both are executed by the suite. */
export type Examples = Readonly<{
	readonly bad: ReadonlyArray<string>;
	readonly good: ReadonlyArray<string>;
	/**
	 * Other files the examples need, keyed by repository-relative path.
	 *
	 * A rule whose claim is about the file system cannot state it in one buffer: `MOD1` asks whether
	 * a specifier resolves back to the importing file, and `IMP1` asks whether a declared path alias
	 * already covers it. Both were unprovable by an example until the example could bring a
	 * neighbouring module and a `tsconfig.json` with it.
	 */
	readonly fixture?: Readonly<Record<string, string>> | undefined;
	/**
	 * Repository-relative path the example is written to.
	 *
	 * `IMP1` claims a `../../` specifier is already covered by a declared alias, which is only true
	 * from a file deep enough for `../../` to land back inside the aliased tree. The default path is
	 * `src/probe.ts`, and no example written there can state that.
	 */
	readonly file?: string | undefined;
}>;

type Common = Readonly<{
	readonly id: string;
	readonly severity: Severity;
	readonly summary: string;
	readonly principles: ReadonlyArray<Principle>;
	/** How strongly the syntax implies a problem. Defaults to `high`. */
	readonly confidence?: Confidence | undefined;
	readonly files?: ReadonlyArray<string> | undefined;
	readonly ignore?: ReadonlyArray<string> | undefined;
	readonly dominates?: ReadonlyArray<string> | undefined;
}>;

/**
 * A rule stated as a shape. The only way to describe a pattern.
 *
 * The field is called `rule` because that is what ast-grep calls it, so a rule written against
 * ast-grep's reference translates without renaming anything. `constraints` and `utils` sit beside
 * it exactly as they do in ast-grep's `SerializableRuleCore`.
 */
export type ShapeRule = Common &
	Readonly<{
		/** What to match. A string is shorthand for `{ pattern }`. */
		readonly rule: Matcher;
		/**
		 * Source that must be reported, and source that must not. Mandatory for a shape.
		 *
		 * A rule with no counter-example is the usual way a detector becomes noise: `QRY1` had no
		 * example of the defect spelled a second way, so nobody noticed it recognised only the first.
		 */
		readonly examples: Examples;
		/**
		 * Named rules the matcher may reference through `{ matches: name }`. ast-grep's `utils`.
		 *
		 * A util may reference another, including itself, which is how a rule describes a recursive
		 * shape without the compiler recursing.
		 */
		readonly utils?: Utils | undefined;
		/**
		 * A rule per metavariable, narrowing what it is allowed to bind. ast-grep's `constraints`.
		 *
		 * Keyed by the metavariable with or without its `$`. A constraint is a full rule, not a
		 * regular expression, so "the callee must itself be a call" is expressible where a text
		 * regex could only approximate it.
		 */
		readonly constraints?: Constraints | undefined;
	}>;

/**
 * A rule stated as a visitor over one syntax kind. The escape hatch.
 *
 * Reach for this only when the claim is not a shape — counting occurrences, or reading something
 * about the file rather than the node. Everything expressible as a shape should be one, because a
 * shape can be read, reviewed and mechanically checked against its own examples.
 */
export type VisitorRule = Common &
	Readonly<{
		readonly when: ReadonlyArray<NodeKind>;
		check(node: ts.Node, context: RuleContext): void;
		/** Optional here: a visitor's behaviour is asserted by the port suite rather than inline. */
		readonly examples?: Examples | undefined;
	}>;

export type RuleDefinition = ShapeRule | VisitorRule;

/** A rule with no example that must match cannot demonstrate it detects anything. */
function assertExamples(
	rule: Common & { readonly examples: Examples },
	requireNegative: boolean
): void {
	if (rule.examples.bad.length === 0)
		throw new Error(`norbital-doctor: ${rule.id} has no example that must match`);
	if (requireNegative && rule.examples.good.length === 0)
		throw new Error(
			`norbital-doctor: ${rule.id} is a composite and must carry an example that must not match`
		);
}

/** Bound metavariables, rendered for a finding's evidence line. */
function evidence(bindings: ReadonlyMap<string, string>): string {
	return [...bindings].map(([key, value]) => `${key}=${value.slice(0, 40)}`).join(' ');
}

/**
 * Define a rule.
 *
 * One entry point, two forms: give it a `rule` to describe a shape, or `when` + `check` to write a
 * visitor. There were three functions here — `definePattern`, `defineMatcher` and a separate
 * `defineRule` — which meant three places to look for how matching works and three subtly different
 * ways to say the same thing.
 */
export function defineRule(definition: ShapeRule): Rule;
export function defineRule(definition: VisitorRule): Rule;
export function defineRule(definition: RuleDefinition): Rule {
	if (!('rule' in definition)) {
		const { examples: _examples, ...rest } = definition;
		return defineVisitorRule(rest);
	}

	const { rule, utils, constraints, examples: _examples, ...rest } = definition;
	assertExamples(definition, true);

	const kinds = withUtils(utils ?? {}, () => matcherKinds(rule));
	if (kinds === undefined || kinds.size === 0)
		throw new Error(
			`norbital-doctor: ${definition.id} has no dispatchable kind. Wrap it as { all: [{ kind: '…' }, …] } so the engine knows where to start.`
		);

	const compiled = withUtils(utils ?? {}, () => compile(rule));
	// A constraint on a metavariable the matcher never binds is a misspelling, and one that would
	// otherwise never announce itself: the rule simply reports nothing, for ever.
	const bound = metavariablesOf(rule);
	for (const name of Object.keys(constraints ?? {})) {
		const key = name.startsWith('$') ? name : `$${name}`;
		if (!bound.has(key))
			throw new Error(
				`norbital-doctor: ${definition.id} constrains ${key}, which its matcher never binds`
			);
	}
	const constrained = Object.entries(constraints ?? {}).map(
		([name, constraint]) =>
			[
				name.startsWith('$') ? name : `$${name}`,
				withUtils(utils ?? {}, () => compile(constraint))
			] as const
	);

	if (hasNamespacedKind(rule)) {
		return defineVisitorRule({
			...rest,
			when: ['SourceFile'],
			check(_node, context) {
				bindMatchHost(context.sourceFile, { root: context.root, file: context.file });
				const tree = projectFile(context.file, context.source);
				for (const matched of matchTree(rule, tree, {
					file: context.file,
					root: context.root,
					source: context.sourceFile,
					original: context.source
				})) {
					context.reportAt(lineOf(context.source, matched.range.start), 'matched');
				}
			}
		});
	}

	return defineVisitorRule({
		...rest,
		when: [...kinds],
		check(node, context) {
			bindMatchHost(context.sourceFile, { root: context.root, file: context.file });
			const bindings: Bindings = new Map();
			if (!compiled.run(node, context.sourceFile, bindings)) return;
			for (const [name, constraint] of constrained) {
				const captured = bindings.get(name);
				// Validated at definition time, so an absent binding here means the pattern took a
				// branch that did not bind it — an `any`, say — and the constraint cannot hold.
				if (captured === undefined) return;
				if (!constraint.run(captured, context.sourceFile, new Map(bindings))) return;
			}
			context.report(node, evidence(bindingTexts(bindings, context.sourceFile)) || 'matched');
		}
	});
}

/** Run one described rule's own examples against its compiled form, returning the failures. */
export function verifyExamples(
	description: Common & Readonly<{ examples: Examples }>,
	compiled: Rule,
	run: (source: string, rule: Rule) => number
): ReadonlyArray<string> {
	const shorten = (source: string): string => source.replace(/\s+/g, ' ').trim().slice(0, 70);
	const failures: Array<string> = [];
	for (const source of description.examples.bad)
		if (run(source, compiled) === 0)
			failures.push(`${description.id}: expected a match — ${shorten(source)}`);
	for (const source of description.examples.good)
		if (run(source, compiled) > 0)
			failures.push(`${description.id}: unexpected match — ${shorten(source)}`);
	return failures;
}

/** Match one matcher anywhere in a source string. For tests and for authoring. */
export function matchSource(matcher: Matcher, source: string): boolean {
	const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (match(matcher, node, file).matched) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}
