// repository-health:allow SEM_PARALLEL -- pattern forms the rule authoring surface carrying rules; provider/consumer of the same algebra.
/** A YAML `rule` compiles to the runner's `Rule`; it must carry a bad and a good example. */
import { projectFile } from './frontend/markup.js';
import {
	bindMatchHost,
	bindingTexts,
	compile,
	matcherKinds,
	metavariablesOf,
	withUtils,
	type Bindings,
	type Constraints,
	type Matcher,
	type Utils
} from './matcher.js';
import { compileModel, hasNamespacedKind, lineOf, matchTree } from './model.js';
import {
	defineVisitorRule,
	type Confidence,
	type Principle,
	type Rule,
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
type ShapeRule = Common &
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

/** A rule with no example that must match cannot demonstrate it detects anything. */
function assertExamples(rule: Common & { readonly examples: Examples }): void {
	if (rule.examples.bad.length === 0)
		throw new Error(`norbital-doctor: ${rule.id} has no example that must match`);
	if (rule.examples.good.length === 0)
		throw new Error(
			`norbital-doctor: ${rule.id} is a composite and must carry an example that must not match`
		);
}

/** Bound metavariables, rendered for a finding's evidence line. */
function evidence(bindings: ReadonlyMap<string, string>): string {
	return [...bindings].map(([key, value]) => `${key}=${value.slice(0, 40)}`).join(' ');
}

/** Compile a shape rule (one pack document) into the visitor the runner executes. */
export function defineRule(definition: ShapeRule): Rule {
	const { examples: _examples, ...shape } = definition;
	assertExamples(definition);
	return compileShape(shape);
}

type Shape = Omit<ShapeRule, 'examples'>;

/**
 * A shape compiled to the visitor the runner executes, behind `defineRule`.
 */
function compileShape(definition: Shape): Rule {
	const { rule, utils, constraints, ...rest } = definition;

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
		// The model binds no metavariables, so a constraint could never hold: refused, not ignored.
		if (constrained.length > 0)
			throw new Error(
				`norbital-doctor: ${definition.id} constrains ${constrained.map(([name]) => name).join(', ')}, which a front-end model rule never binds`
			);
		const model = compileModel(definition.id, rule);
		return defineVisitorRule({
			...rest,
			when: ['SourceFile'],
			check(_node, context) {
				bindMatchHost(context.sourceFile, { root: context.root, file: context.file });
				const tree = projectFile(context.file, context.source);
				for (const matched of matchTree(model, tree, {
					file: context.file,
					root: context.root,
					source: context.sourceFile,
					original: context.source
				})) {
					context.reportAt(lineOf(context.source, matched.range.start), 'matched', matched.text);
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

/** A search as a rule: ast-grep's rule language (a pattern, kind, relational and composite rules) asked where it matches. */
export function searchRule(
	rule: Matcher,
	options: Readonly<{ utils?: Utils | undefined; constraints?: Constraints | undefined }> = {}
): Rule {
	return compileShape({
		id: 'search',
		severity: 'hint',
		summary: 'search match',
		// a search judges nothing; a principle is only the registry's price of admission
		principles: ['straightforwardness'],
		rule,
		...(options.utils === undefined ? {} : { utils: options.utils }),
		...(options.constraints === undefined ? {} : { constraints: options.constraints })
	});
}
