/**
 * The capability manifest: one rule, parameterised by a table.
 *
 * > A lexical scope exhibits at least N *bypass mechanisms* of capability C, and never calls C's
 * > *owner*.
 *
 * This is the generalisation of two things that already existed in narrower form. `overlaps.ts`
 * says "this shape reimplements a library primitive"; a capability says the same about a *platform*
 * capability, where the reimplementation has no single shape and is only visible as several
 * mechanisms occurring together. And `REACT1`–`REACT4` are four hardcoded rules that, read
 * together, are one capability row.
 *
 * Why mechanism-plus-absence rather than shape:
 *
 * A hand-rolled query cache and a correct use of the generated client are *maximally similar* by
 * any surface measure — same nouns, same domain, same imports. What separates them is not present
 * in either one on its own. It is that the reimplementation performs work the client already does
 * (a timer, a loading flag, a memo) *and* never calls the client. The decisive evidence is an
 * absence, which is exactly what a shape matcher cannot express and what a similarity score cannot
 * see.
 *
 * It also resists an agent rewriting the code. Renaming every identifier does not remove the timer,
 * does not remove the flag, and does not add the missing client call.
 *
 * Adding `mutation`, `auth`, `cache` or `http` is a row in `CAPABILITIES`, not new code.
 */
import type { Matcher } from '@norbital-ai/doctor';
import { defineScope, type Examples } from '@norbital-ai/doctor';
import { definePack, type NodeKind, type Pack, type Principle, type Rule } from '@norbital-ai/doctor';

/** Scopes a capability is judged within. A component script body is `SourceFile` after extraction. */
const DEFAULT_SCOPES: ReadonlyArray<NodeKind> = [
	'FunctionDeclaration',
	'ArrowFunction',
	'FunctionExpression',
	'MethodDeclaration',
	'SourceFile'
];

type Capability = Readonly<{
	/** Short name; becomes the rule id as `CAP_<NAME>`. */
	readonly name: string;
	readonly summary: string;
	readonly principles: ReadonlyArray<Principle>;
	/** Calling any of these means the scope is using the capability rather than rebuilding it. */
	readonly owner: ReadonlyArray<Matcher>;
	/** Work the owner already does. Each counts once per scope. */
	readonly mechanisms: ReadonlyArray<Matcher>;
	/** How many distinct mechanisms constitute a reimplementation. */
	readonly threshold: number;
	readonly scopes?: ReadonlyArray<NodeKind> | undefined;
	readonly files?: ReadonlyArray<string> | undefined;
	readonly examples: Examples;
}>;

/**
 * The `query` capability.
 *
 * Mechanisms are drawn from what the generated client already owns: subscription lifetime, loading
 * state, invalidation, and freshness. A scope doing two of those by hand, and never calling the
 * client, has rebuilt it.
 */
const query: Capability = {
	name: 'QUERY',
	summary: 'a scope rebuilds query ownership the generated client already provides',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'testability', 'no-bloat'],
	owner: [
		'$CLIENT.db.$COLLECTION.$METHOD($...ARGS)',
		'$CLIENT.$NAMESPACE.$METHOD($...ARGS)',
		'createQuery($...ARGS)'
	],
	mechanisms: [
		// A timer driving refresh: the subscription is already live.
		{
			all: [
				{ kind: 'CallExpression' },
				{ regex: '^set(Interval|Timeout)\\b' },
				{ has: { regex: '\\.(refresh|refetch|reload|invalidate)\\s*\\(' }, stopBy: 'end' }
			]
		},
		// A hand-held loading flag beside a query that publishes one.
		{
			all: [
				{ kind: 'VariableDeclaration' },
				{ regex: '\\b(loading|pending|fetching|isLoading)\\b' },
				{ has: '$state($...ARGS)', stopBy: 'end' }
			]
		},
		// A memo of work already done, at scope level.
		{
			all: [
				{ kind: 'NewExpression' },
				{ regex: '^new (Set|Map)\\b' },
				{ inside: { kind: 'SourceFile' }, stopBy: { kind: 'FunctionDeclaration' } }
			]
		},
		// Copying a live value into local state freezes it.
		{
			all: [
				{ kind: 'CallExpression' },
				{ regex: '^\\$effect' },
				{ has: { regex: '\\.current\\b' }, stopBy: 'end' }
			]
		},
		// Guarding a read with native control flow rather than rendering the error the query owns.
		{
			all: [
				{ kind: 'TryStatement' },
				{ has: { regex: '\\.(current|findMany|findFirst)\\b' }, stopBy: 'end' }
			]
		}
	],
	threshold: 2,
	examples: {
		bad: [
			// The case the original rule reported clean: a timer refreshing, plus a memo, and no
			// client call anywhere in the scope.
			`function panel() {
	const refreshed = new Set();
	const timer = setInterval(() => { for (const q of active) void q.refresh(); }, 1000);
	void refreshed; void timer;
}`,
			`function panel() {
	let loading = $state(false);
	const seen = new Map();
	void loading; void seen;
}`
		],
		good: [
			// Calling the owner exonerates the scope, whatever else it does.
			`function panel() {
	const rows = client.db.employees.findMany({});
	const timer = setInterval(() => void rows.refresh(), 1000);
	void timer;
}`,
			// One mechanism is not a reimplementation.
			`function panel() {
	const timer = setInterval(() => tick(), 1000);
	void timer;
}`
		]
	}
};

/**
 * The `mutation` capability.
 *
 * The generated mutation owns pending, error and result. A scope keeping its own copies of those
 * around a call has rebuilt the lifecycle rather than rendering it.
 */
const mutation: Capability = {
	name: 'MUTATION',
	summary: 'a scope rebuilds mutation lifecycle the generated client already provides',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'testability'],
	owner: ['$CLIENT.db.$COLLECTION.$METHOD($...ARGS)', '$MUTATION.mutate($...ARGS)'],
	mechanisms: [
		{
			all: [
				{ kind: 'VariableDeclaration' },
				{ regex: '\\b(saving|submitting|pending|inFlight)\\b' },
				{ has: '$state($...ARGS)', stopBy: 'end' }
			]
		},
		{
			all: [
				{ kind: 'VariableDeclaration' },
				{ regex: '\\b(error|failure|lastError)\\b' },
				{ has: '$state($...ARGS)', stopBy: 'end' }
			]
		},
		{ all: [{ kind: 'TryStatement' }, { has: { regex: '\\bawait\\b' }, stopBy: 'end' }] },
		{ all: [{ kind: 'CallExpression' }, { regex: '^toast\\.(success|error)\\b' }] }
	],
	threshold: 3,
	examples: {
		bad: [
			`async function save() {
	let saving = $state(false);
	let error = $state(undefined);
	try { await send(); } catch (cause) { error = cause; }
	void saving;
}`
		],
		good: [
			`async function save() {
	const result = client.db.things.create(input);
	void result;
}`,
			`async function save() {
	let saving = $state(false);
	void saving;
}`
		]
	}
};

export const CAPABILITIES: ReadonlyArray<Capability> = [query, mutation];

/** Compile one capability row into a rule. */
export function defineCapability(capability: Capability): Rule {
	const { name, owner, mechanisms, threshold, scopes, ...definition } = capability;
	return defineScope({
		...definition,
		id: `CAP_${name}`,
		severity: 'error',
		scope: scopes ?? DEFAULT_SCOPES,
		signals: mechanisms,
		atLeast: threshold,
		owner: { any: owner }
	});
}

/** Build a pack from a manifest, defaulting to the rows above. */
export function capabilityPack(rows: ReadonlyArray<Capability> = CAPABILITIES): Pack {
	return definePack({ name: 'norbital/capability', rules: rows.map(defineCapability) });
}
