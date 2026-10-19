/**
 * Open fact registry. A fact is a named, parameterised, memoised predicate — never a rule.
 */
// repository-health:allow STATE2 -- open registry: packs register once at load and every rule evaluation must observe the same registry.
import type ts from 'typescript';

type FactBindings = Map<string, ts.Node>;

export type FactContext = Readonly<{
	node: ts.Node;
	source: ts.SourceFile;
	bindings: FactBindings;
	file: string;
	root: string;
}>;

type FactParams = Readonly<Record<string, unknown>>;

type Fact = Readonly<{
	name: string;
	parameters: ReadonlyArray<string>;
	optional?: ReadonlyArray<string>;
	run: (context: FactContext, params: FactParams) => boolean;
}>;

const FACTS = new Map<string, Fact>();
const MEMO = new WeakMap<object, Map<string, unknown>>();

export function registerFact(fact: Fact): void {
	if (FACTS.has(fact.name))
		throw new Error(`norbital-doctor: fact "${fact.name}" is already registered`);
	FACTS.set(fact.name, fact);
}

/** Compute once per host object (usually the source file) and reuse across every rule. */
export function memoised<T>(host: object, key: string, compute: () => T): T {
	let bucket = MEMO.get(host);
	if (bucket === undefined) {
		bucket = new Map();
		MEMO.set(host, bucket);
	}
	const cached = bucket.get(key);
	if (cached !== undefined) return cached as T;
	const value = compute();
	bucket.set(key, value);
	return value;
}

export function evaluateFact(name: string, params: FactParams, context: FactContext): boolean {
	const fact = FACTS.get(name);
	if (fact === undefined) throw new Error(`norbital-doctor: unknown fact "${name}"`);
	for (const key of fact.parameters)
		if (params[key] === undefined)
			throw new Error(`norbital-doctor: fact "${name}" requires parameter "${key}"`);
	return fact.run(context, params);
}
