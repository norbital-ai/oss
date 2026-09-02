/**
 * Runes and the shared layout contract.
 *
 * Ported from `V1`, `V7`, `V14`, `V15`, `V18` and the `UI5`–`UI16` layout family. The Svelte 4
 * rules — `V3`, `V4`, `V5`, `V6`, `V16`, `V17`, `V19`, `UI1`–`UI4` — are written off: their syntax
 * occurs in **0 files** across all four repositories, measured, and is recorded in `docs/triage.md`.
 *
 * The layout rules read the `class` attribute, which the runner sees because a component's
 * `<script>` is not the only thing extracted — these match on the source text of the file rather
 * than its script AST, so they are expressed as source rules over the whole component.
 */
import { defineRule } from '@norbital-ai/doctor';
import { definePack, type Pack, type Rule } from '@norbital-ai/doctor';
import { svelteMarkup } from '@norbital-ai/doctor';
import { SYSTEM_COLLECTION_FIELD_NAMES } from '@norbital-ai/std/collection';
import { loadLocalRules } from './load.js';

const COMPONENT = ['**/*.svelte'];
const SYSTEM_COLLECTION_FIELD_PATTERN = SYSTEM_COLLECTION_FIELD_NAMES.map((name) =>
	name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
).join('|');
const SYSTEM_COLLECTION_COMPOSITION_PATTERN = new RegExp(
	`<(?:Column|Field)\\b(?:(?!\\/>|>)[\\s\\S])*?\\bname\\s*=\\s*(?:["'](?:${SYSTEM_COLLECTION_FIELD_PATTERN})["']|\\{\\s*["'](?:${SYSTEM_COLLECTION_FIELD_PATTERN})["']\\s*\\})`
);

const effectAsLastResort = defineRule({
	id: 'V1',
	severity: 'error',
	summary: '$effect is last-resort external sync; prefer $derived or {@attach}',
	principles: ['simplicity', 'straightforwardness', 'testability'],
	when: ['CallExpression'],
	files: COMPONENT,
	check(node, context) {
		if (context.calleeName(node) !== '$effect') return;
		const ts = context.ts;
		const call = node as import('typescript').CallExpression;
		const [body] = call.arguments;
		if (body === undefined || !ts.isFunctionLike(body) || body.body === undefined) return;
		const text = context.text(body.body);
		// An effect that only computes a value is a `$derived`; one that touches the outside world
		// is what `$effect` is for.
		const known =
			/\b(?:addEventListener|removeEventListener|setInterval|setTimeout|requestAnimationFrame|IntersectionObserver|ResizeObserver|document\.|window\.|fetch\()/.test(
				text
			);
		// Structure, not vocabulary. The list above names DOM and timer globals, so an effect that
		// pushes state across a component boundary, navigates, starts a subscription, or returns a
		// teardown all read as pure recomputation — and `$derived` can express none of them. A
		// returned function is a teardown by definition, and a call standing alone as a statement is
		// a side effect by definition; a value being computed would be assigned, not discarded.
		let performs = false;
		const visit = (current: import('typescript').Node): void => {
			if (ts.isReturnStatement(current) && current.expression !== undefined) {
				const returned = current.expression;
				if (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned)) performs = true;
			}
			if (ts.isExpressionStatement(current)) {
				const inner = ts.isAwaitExpression(current.expression)
					? current.expression.expression
					: current.expression;
				if (ts.isCallExpression(inner)) performs = true;
			}
			ts.forEachChild(current, visit);
		};
		visit(body.body);
		const assignsState = /\w+\s*=\s*[^=]/.test(text);
		if (!known && !performs && assignsState)
			context.report(node, 'body=pure-assignment prefer=$derived');
	}
});

const computedBindingShouldDerive = defineRule({
	id: 'V15',
	severity: 'error',
	summary: 'computed binding in a rune module should be $derived',
	principles: ['straightforwardness', 'testability'],
	when: ['VariableDeclaration'],
	files: COMPONENT,
	check(node, context) {
		const ts = context.ts;
		const declaration = node as import('typescript').VariableDeclaration;
		if (!ts.isIdentifier(declaration.name)) return;
		if (!ts.isVariableDeclarationList(declaration.parent)) return;
		if (!ts.isSourceFile(declaration.parent.parent.parent ?? declaration.parent.parent)) return;
		const initializer = declaration.initializer;
		if (initializer === undefined) return;
		const text = context.text(initializer);
		if (/^\$(?:state|derived|props|bindable|effect)/.test(text)) return;
		// A binding computed from other reactive reads is a derivation; a literal or a call with no
		// reactive input is just a constant.
		if (!ts.isPropertyAccessExpression(initializer) && !ts.isBinaryExpression(initializer)) return;
		if (!/\.(?:current|value)\b|\$state\b|\$props\b/.test(text)) return;
		context.report(node, `name=${declaration.name.text} prefer=$derived`);
	}
});

/**
 * The layout contract, read from the `class` attribute.
 *
 * These are source-text rules rather than AST rules: the attribute is markup, not script, and the
 * runner parses only the script. Matching the raw component source is the honest way to express
 * that, and keeps the line numbers pointing at the markup a person has to edit.
 */
type LayoutRule = Readonly<{
	id: string;
	summary: string;
	dominates?: ReadonlyArray<string>;
	pattern: RegExp;
	/** Optional component-source shape that may span attribute lines. */
	sourcePattern?: RegExp;
	prefer: string;
}>;

const LAYOUT: ReadonlyArray<LayoutRule> = [
	{
		id: 'UI5',
		summary: 'raw overflow scroll region bypasses the Scroll primitive',
		pattern: /\boverflow(?:-[xy])?-(?:auto|scroll)\b/,
		prefer: 'Scroll'
	},
	// Moving the container to a primitive takes the sibling margins with it, so UI7 at the same
	// element is the same edit stated twice.
	{
		id: 'UI6',
		dominates: ['UI7'],
		summary: 'raw flex/grid container bypasses the layout primitives',
		pattern: /\bclass="[^"]*\b(?:flex|grid)\b(?:[^"]*\bgap-)/,
		prefer: 'Stack|Inline|Grid'
	},
	{
		id: 'UI7',
		summary: 'sibling margin bypasses the parent gap contract',
		pattern: /\bclass="[^"]*\b(?:space-[xy]-\d|m[tblr]-(?:[2-9]|1\d))\b/,
		prefer: 'parent gap'
	},
	{
		id: 'UI8',
		summary: 'literal app inset classes bypass the inset tokens',
		// Inside a `class` attribute. Without the guard this matched the layout documentation page,
		// where the string appears in a `<code>` block telling readers not to write it.
		pattern: /\bclass="[^"]*\b(?:px-4 (?:py-2 )?sm:px-6|mx-4 sm:mx-6)\b/,
		prefer: 'inset tokens'
	},
	{
		id: 'UI12',
		summary: 'Tailwind arbitrary value built at runtime emits no CSS',
		pattern: /class=\{[^}]*['"`][a-z-]+-\[\$\{/,
		prefer: 'static classes'
	},
	{
		id: 'UI17',
		summary: 'template exposes uuid/system id to operators',
		// Markup, not script — the previous form tested for a JSX expression, which Svelte never
		// produces, so it could not fire at all.
		//
		// The interpolation must be the id and nothing else. Allowing anything before it matched
		// `{ eq: record.id }` inside a `where` prop and `{#each rows as row (row.id)}` — a query
		// argument and a keyed-list key, neither of which a person ever sees. "Exposed to an
		// operator" means rendered.
		// `$` excludes a `${…}` hole inside a template literal; `=` excludes an attribute value like
		// `tenantId={record.id}`. Neither is text a person reads — one is a string being built, the
		// other is a value being handed to a component.
		pattern: /(?<![$=])\{\s*[A-Za-z_$][\w$.]*\.(?:id|uuid|_id)\s*\}/,
		sourcePattern: SYSTEM_COLLECTION_COMPOSITION_PATTERN,
		prefer: 'recordLabel'
	},
	{
		id: 'UI15',
		summary: 'fixed layout dimension on a primitive instead of Bound size',
		pattern:
			/<(?:Stack|Inline|Cluster|Grid|Bound|Cover|Scroll)\b[^>]*\bclass="[^"]*\b(?:h|w|min-h|min-w)-\[/,
		prefer: 'Bound size'
	}
];

function layoutRule(rule: LayoutRule): Rule {
	return defineRule({
		id: rule.id,
		severity: 'error',
		summary: rule.summary,
		principles: ['simplicity', 'straightforwardness', 'colocation'],
		...(rule.dominates === undefined ? {} : { dominates: rule.dominates }),
		// Dispatch on the file's root; the match is over source text, not the script AST.
		when: ['SourceFile'],
		files: COMPONENT,
		check(node, context) {
			void node;
			// Markup only. `files: COMPONENT` already restricts this to `.svelte`.
			const markup = svelteMarkup(context.source);
			if (rule.sourcePattern) {
				const match = rule.sourcePattern.exec(markup);
				if (match?.index != null) {
					context.reportAt(
						markup.slice(0, match.index).split('\n').length,
						`prefer=${rule.prefer}`
					);
					return;
				}
			}
			for (const [index, line] of markup.split('\n').entries()) {
				if (!rule.pattern.test(line)) continue;
				// One finding per file: the contract is broken here, and a component repeating the same
				// class on twenty elements is one edit, not twenty.
				context.reportAt(index + 1, `prefer=${rule.prefer}`);
				return;
			}
		}
	});
}

export const svelteRules: ReadonlyArray<Rule> = [
	...loadLocalRules('svelte'),
	effectAsLastResort,
	computedBindingShouldDerive,
	...LAYOUT.map(layoutRule)
];

export const sveltePack: Pack = definePack({ name: 'norbital/svelte', rules: svelteRules });
