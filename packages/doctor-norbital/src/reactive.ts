/**
 * Reactive-ownership rules: the ones the legacy detector claims and does not enforce.
 *
 * `QRY1` is documented as "manual query state/cache ownership bypasses the reactive client", but it
 * fires only when a file happens to declare a variable named `rows`/`records`/`cache` *and* one
 * named `loading`/`pending` *and* two of `version`/`notify`/`refresh`. That describes one shape of
 * hand-rolled cache class. It does not describe the law, which is that UI code owns no polling, no
 * refresh counters and no cache invalidation — so the dangerous version, a `setInterval` driving
 * `query.refresh()` inside an `$effect`, passes silently.
 *
 * These rules match the mechanism instead of the naming, and because they run on the authored-rule
 * runner they behave identically in `.ts` and `.svelte`: the runner parses a component's `<script>`
 * with the same parser and the same line mapping as a module.
 */
import ts from 'typescript';
import { defineRule } from '@norbital-ai/doctor';
import { definePack, type Rule, type RuleContext } from '@norbital-ai/doctor';

/** Timer constructors that turn a declarative subscription into a poll. */
const TIMERS = new Set(['setInterval', 'setTimeout']);

/** Lifecycle owners inside which a timer is component-owned rather than module setup. */
const REACTIVE_OWNERS = new Set(['$effect', 'onMount', 'afterUpdate', 'beforeUpdate']);

/** Does this subtree call `.refresh()`, `.reload()`, `.invalidate()` or `.refetch()`? */
function callsRefresh(node: ts.Node): boolean {
	let found = false;
	const visit = (current: ts.Node): void => {
		if (found) return;
		if (
			ts.isCallExpression(current) &&
			ts.isPropertyAccessExpression(current.expression) &&
			['refresh', 'reload', 'invalidate', 'refetch'].includes(current.expression.name.text)
		) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	};
	visit(node);
	return found;
}

/** The nearest enclosing call whose callee names a reactive lifecycle owner. */
function reactiveOwner(node: ts.Node, context: RuleContext): string | undefined {
	for (const parent of context.ancestors(node)) {
		if (!ts.isCallExpression(parent)) continue;
		const callee = context.calleeName(parent);
		if (callee !== undefined && REACTIVE_OWNERS.has(callee)) return callee;
	}
	return undefined;
}

const polling = defineRule({
	id: 'REACT1',
	severity: 'error',
	summary: 'a timer drives query refresh; the client already owns the subscription',
	principles: ['simplicity', 'straightforwardness', 'efficiency', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		const callee = context.calleeName(node);
		if (callee === undefined || !TIMERS.has(callee)) return;
		const callback = (node as ts.CallExpression).arguments[0];
		if (callback === undefined || !callsRefresh(callback)) return;
		const owner = reactiveOwner(node, context) ?? 'module scope';
		context.report(node, `timer=${callee} owner=${owner} prefer=live-subscription`);
	}
});

const imperativeRefresh = defineRule({
	id: 'REACT2',
	severity: 'error',
	summary: 'generated query is refreshed imperatively instead of re-deriving',
	principles: ['straightforwardness', 'modularity', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		const call = node as ts.CallExpression;
		if (!ts.isPropertyAccessExpression(call.expression)) return;
		if (!['refresh', 'refetch', 'invalidate'].includes(call.expression.name.text)) return;
		// A timer-driven refresh is already REACT1; report the shape once, at its cause.
		if (reactiveOwner(node, context) === undefined) return;
		context.report(
			node,
			`call=${context.calleeName(node) ?? 'refresh'} prefer=$derived-parameters`
		);
	}
});

/** A `Set`/`Map` built at component or module scope purely to remember what was already done. */
const manualCache = defineRule({
	id: 'REACT3',
	severity: 'error',
	summary: 'hand-rolled memo of completed work duplicates the client cache',
	principles: ['simplicity', 'modularity', 'no-bloat'],
	when: ['NewExpression'],
	check(node, context) {
		const constructed = context.calleeName(node);
		if (constructed !== 'Set' && constructed !== 'Map') return;
		const declaration = context
			.ancestors(node)
			.find((parent): parent is ts.VariableDeclaration => ts.isVariableDeclaration(parent));
		if (declaration === undefined || !ts.isIdentifier(declaration.name)) return;
		if (!/^(?:refreshed|seen|handled|processed|synced|done|fetched)/i.test(declaration.name.text))
			return;
		// Only a module/component-level memo hides lifetime; a local one dies with its call.
		if (context.ancestors(node).some((parent) => ts.isFunctionLike(parent))) return;
		context.report(node, `name=${declaration.name.text} kind=${constructed}`);
	}
});

const environmentBranch = defineRule({
	id: 'REACT4',
	severity: 'error',
	summary: 'component branches on the runtime environment instead of a lifecycle boundary',
	principles: ['straightforwardness', 'testability'],
	when: ['TypeOfExpression'],
	files: ['**/*.svelte'],
	check(node, context) {
		const operand = (node as ts.TypeOfExpression).expression;
		if (!ts.isIdentifier(operand) || !['window', 'document'].includes(operand.text)) return;
		context.report(node, `global=${operand.text} prefer=onMount|browser-boundary`);
	}
});

export const reactivePack = definePack({
	name: 'norbital/reactive',
	rules: [polling, imperativeRefresh, manualCache, environmentBranch] as ReadonlyArray<Rule>
});
