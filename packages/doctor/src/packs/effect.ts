/**
 * Effect ownership: failure, concurrency, time, logging and IO.
 *
 * Ported from `EFF1`–`EFF7`, `EQ1`, `LOG1`, `IO1`, `NONDET1`, `STATE1`. These fire the most of any
 * family in the realm — `EFF3` alone accounts for 3,107 of the 5,246 legacy findings — so their
 * behaviour is the most load-bearing thing in the port.
 *
 * Scope matters and is the thing the legacy rules got right: an Effect-owned module is one that
 * imports Effect. A plain Node script using `try`/`catch` is not violating anything, so every rule
 * here that concerns control flow checks that first.
 */
import { defineRule } from '../pattern.js';
import { definePack, type Pack, type Rule } from '../rules.js';

/** True when the file is Effect-owned, which is what makes native control flow a bypass. */
function effectOwned(context: import('../rules.js').RuleContext): boolean {
	return context.importsFrom('effect');
}

const nativeTryCatch = defineRule({
	id: 'EFF1',
	severity: 'error',
	summary: 'native try/catch bypasses Effect error control',
	principles: ['straightforwardness', 'testability', 'type-safety'],
	when: ['TryStatement'],
	check(node, context) {
		if (!effectOwned(context)) return;
		context.report(node, 'syntax=try');
	}
});

const nativePromise = defineRule({
	id: 'EFF2',
	severity: 'error',
	summary: 'native Promise control bypasses Effect concurrency',
	principles: ['straightforwardness', 'testability', 'efficiency'],
	// `await Promise.all(...)` is one defect: the combinator. Reporting the `await` beside it counts
	// the same line twice and makes the sharper claim look like noise.
	dominates: ['EFF3'],
	when: ['CallExpression', 'NewExpression'],
	check(node, context) {
		if (!effectOwned(context)) return;
		const callee = context.calleeName(node);
		if (callee === undefined) return;
		if (!/^Promise\.(all|allSettled|race|any)$/.test(callee) && callee !== 'Promise') return;
		context.report(node, `api=${callee}`);
	}
});

const asyncAwait = defineRule({
	id: 'EFF3',
	severity: 'error',
	summary: 'async/await appears in an Effect-owned module',
	principles: ['straightforwardness', 'testability'],
	when: ['AwaitExpression', 'AsyncKeyword'],
	check(node, context) {
		if (!effectOwned(context)) return;
		const ts = context.ts;
		context.report(
			node,
			node.kind === ts.SyntaxKind.AwaitExpression ? 'syntax=await' : 'syntax=async'
		);
	}
});

const ambientTimeInEffect = defineRule({
	id: 'EFF5',
	severity: 'error',
	summary: 'Effect workflow reads ambient time or randomness',
	principles: ['straightforwardness', 'testability'],
	when: ['CallExpression', 'NewExpression'],
	check(node, context) {
		if (!effectOwned(context)) return;
		const callee = context.calleeName(node);
		if (callee === undefined) return;
		if (!/^(Date\.now|Math\.random|performance\.now|crypto\.randomUUID|Date)$/.test(callee)) return;
		const ts = context.ts;
		// `new Date(millis)` converts a value somebody already holds — usually the `Clock` reading
		// two lines above it. Only `new Date()` reaches for the ambient clock, so only that is
		// ambient time. The bare `Date` in the alternation above had no arity test, so this rule was
		// reporting the very code that had adopted the Clock correctly.
		if (callee === 'Date' && ts.isNewExpression(node) && (node.arguments?.length ?? 0) > 0) return;
		// Inside an Effect workflow this is a service that should be injected; outside one it is
		// NONDET1's weaker claim.
		const inWorkflow = context.ancestors(node).some((parent) => {
			if (!ts.isCallExpression(parent)) return false;
			const owner = context.calleeName(parent) ?? '';
			return /^Effect\.(gen|sync|promise|fn|try|tryPromise)$/.test(owner);
		});
		if (inWorkflow) context.report(node, `api=${callee} prefer=Effect.Clock|Effect.Random`);
	}
});

const throwInEffect = defineRule({
	id: 'EFF6',
	severity: 'error',
	summary: 'throw escapes the typed Effect error channel',
	principles: ['simplicity', 'straightforwardness', 'testability', 'type-safety'],
	when: ['ThrowStatement'],
	check(node, context) {
		if (!effectOwned(context)) return;
		const ts = context.ts;
		const inWorkflow = context.ancestors(node).some((parent) => {
			if (!ts.isCallExpression(parent)) return false;
			return /^Effect\.(gen|fn)$/.test(context.calleeName(parent) ?? '');
		});
		if (inWorkflow) context.report(node, 'owner=Effect.gen prefer=Effect.fail');
	}
});

const singleYieldGen = defineRule({
	id: 'EFF7',
	severity: 'error',
	summary: 'single-yield Effect.gen adds no composition',
	principles: ['simplicity', 'straightforwardness', 'no-bloat'],
	when: ['CallExpression'],
	check(node, context) {
		if (context.calleeName(node) !== 'Effect.gen') return;
		const ts = context.ts;
		const call = node as import('typescript').CallExpression;
		const body = call.arguments[0];
		if (body === undefined || !ts.isFunctionLike(body) || body.body === undefined) return;
		let yields = 0;
		const visit = (current: import('typescript').Node): void => {
			if (ts.isYieldExpression(current)) yields += 1;
			ts.forEachChild(current, visit);
		};
		visit(body.body);
		if (yields === 1) context.report(node, 'yields=1');
	}
});

const jsonEquality = defineRule({
	id: 'EQ1',
	severity: 'error',
	summary: 'JSON serialization is used as equality',
	principles: ['simplicity', 'straightforwardness', 'testability', 'efficiency', 'no-bloat'],
	rule: {
		any: [
			'JSON.stringify($LEFT) === JSON.stringify($RIGHT)',
			'JSON.stringify($LEFT) !== JSON.stringify($RIGHT)'
		]
	},
	examples: {
		bad: ['const same = JSON.stringify(a) === JSON.stringify(b);'],
		good: ['const same = Equal.equals(a, b);']
	}
});

/**
 * Code that is tooling rather than runtime, where logging and blocking IO are fine.
 *
 * Build configuration belongs here for the same reason `scripts/` does: a `vite.config.js` is
 * evaluated by the bundler before any runtime exists, and its `resolveId`/alias hooks are
 * synchronous by contract — there is no async form to prefer.
 */
const TOOL_PATH = /(?:^|\/)(?:scripts?|bin|cli|tools)(?:\/|$)|(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/i;

const consoleCall = defineRule({
	id: 'LOG1',
	severity: 'error',
	summary: 'runtime console call bypasses structured logging',
	principles: ['straightforwardness', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		if (TOOL_PATH.test(context.file)) return;
		const callee = context.calleeName(node);
		if (callee === undefined || !/^console\./.test(callee)) return;
		context.report(node, `api=${callee} prefer=Effect.log`);
	}
});

const SYNC_IO =
	/^(?:readFileSync|writeFileSync|existsSync|readdirSync|statSync|mkdirSync|rmSync|appendFileSync|execSync|execFileSync|spawnSync)$/;

const blockingIo = defineRule({
	id: 'IO1',
	severity: 'error',
	summary: 'runtime code performs blocking synchronous Node IO',
	principles: ['straightforwardness', 'testability', 'efficiency'],
	when: ['CallExpression'],
	check(node, context) {
		if (TOOL_PATH.test(context.file)) return;
		const callee = context.calleeName(node);
		if (callee === undefined) return;
		const bare = callee.split('.').pop() ?? '';
		if (!SYNC_IO.test(bare)) return;
		context.report(node, `api=${bare} prefer=Effect-FileSystem`);
	}
});

const ambientTimeOrdinary = defineRule({
	id: 'NONDET1',
	severity: 'error',
	summary: 'ordinary Effect-owned module reads ambient time or randomness',
	principles: ['straightforwardness', 'testability'],
	when: ['CallExpression', 'NewExpression'],
	check(node, context) {
		if (!effectOwned(context)) return;
		const callee = context.calleeName(node);
		if (callee === undefined) return;
		if (!/^(Date\.now|Math\.random|performance\.now|crypto\.randomUUID)$/.test(callee)) return;
		const ts = context.ts;
		// EFF5 owns the case inside a workflow; this is the weaker claim outside one.
		const inWorkflow = context.ancestors(node).some((parent) => {
			if (!ts.isCallExpression(parent)) return false;
			return /^Effect\.(gen|sync|promise|fn|try|tryPromise)$/.test(
				context.calleeName(parent) ?? ''
			);
		});
		if (!inWorkflow) context.report(node, `api=${callee}`);
	}
});

const moduleMutableState = defineRule({
	id: 'STATE1',
	severity: 'error',
	summary: 'module-scoped mutable state hides shared lifetime',
	principles: ['simplicity', 'modularity', 'testability'],
	when: ['VariableStatement'],
	// A component's `<script>` top level is instance scope, not module scope, and `$state` *requires*
	// `let` — so every one of this rule's 224 findings across oss was `let x = $state(...)`, the
	// idiom Svelte mandates. `V14` owns the rune question in components; this rule does not belong
	// there at all.
	ignore: ['**/*.svelte'],
	check(node, context) {
		const ts = context.ts;
		const statement = node as import('typescript').VariableStatement;
		if (!ts.isSourceFile(statement.parent)) return;
		// Belt and braces for a `.svelte.ts` rune module, where the same idiom is correct.
		if (
			statement.declarationList.declarations[0]?.initializer !== undefined &&
			/^\$(?:state|derived|props|bindable)\b/.test(
				context.text(statement.declarationList.declarations[0]!.initializer!)
			)
		)
			return;
		const list = statement.declarationList;
		const mutable = (list.flags & ts.NodeFlags.Const) === 0;
		const declaration = list.declarations[0];
		if (declaration === undefined) return;
		const initializer = declaration.initializer;
		// Reassignable bindings only, which is what the legacy rule meant.
		//
		// A module-level `const cache = new Map()` is also shared mutable state, and widening to it
		// took this rule from 65 findings to 505 across the realm — an eightfold change in meaning
		// smuggled in under a port. That case is real, but it belongs to the capability manifest,
		// where a memo is one mechanism among several rather than a finding on its own.
		if (!mutable) return;
		if (ts.isIdentifier(declaration.name))
			context.report(node, `name=${declaration.name.text} kind=let`);
	}
});

export const effectRules: ReadonlyArray<Rule> = [
	nativeTryCatch,
	nativePromise,
	asyncAwait,
	ambientTimeInEffect,
	throwInEffect,
	singleYieldGen,
	jsonEquality,
	consoleCall,
	blockingIo,
	ambientTimeOrdinary,
	moduleMutableState
];

export const effectPack: Pack = definePack({ name: 'norbital/effect', rules: effectRules });
