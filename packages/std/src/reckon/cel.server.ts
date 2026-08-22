import { Environment, type ParseResult } from '@marcbachmann/cel-js';
import { Effect } from 'effect';
import type {
	ComputationDefinition,
	InlinedTable,
	ValidationError,
	ValidationResult
} from './definition.js';
import {
	createScalarOps,
	createTableOps,
	createFoldOp,
	type AuditRef,
	type OpRegistration
} from './ops.js';
import { extractIdentifiers, partitionDependencies, topoSort, CycleError } from './deps.js';
import { hashDefinition } from './hash.js';

/** Mutable scope ref — set by the runtime before each expr evaluation. */
type ScopeRef = { scope: Record<string, unknown> | null };

/** A compiled CEL environment bound to a specific computation definition. */
export type ReckonEnvironment = {
	readonly id: string;
	readonly outputs: ReadonlyArray<string>;
	readonly exprs: Record<string, string>;
	readonly tables: Record<string, InlinedTable>;
	readonly exprOrder: string[];
	readonly exprDeps: Map<string, Set<string>>;
	readonly allRefs: Map<string, Set<string>>;
	readonly definitionHash: string;
	readonly compiled: Map<string, ParseResult>;
	readonly auditRef: AuditRef;
	readonly scopeRef: ScopeRef;
};

/** Custom op registered via the engine's public extension API. */
export type CustomOp = { signature: string; handler: (...args: unknown[]) => unknown };

/**
 * Create a Reckon environment for a computation definition.
 *
 * Parses all exprs, extracts dependencies via AST walk, topo-sorts, and
 * registers all ops (scalar + table-aware + fold) with audit/scope side channels.
 *
 * @throws on parse errors or dependency cycles
 */
export function createEnvironment(
	def: ComputationDefinition,
	customOps: CustomOp[] = []
): ReckonEnvironment {
	const env = new Environment({
		unlistedVariablesAreDyn: true,
		homogeneousAggregateLiterals: false
	});

	const auditRef: AuditRef = { sink: [] };
	const scopeRef: ScopeRef = { scope: null };

	for (const { signature, handler } of createScalarOps(auditRef)) {
		env.registerFunction(signature, handler);
	}
	for (const { signature, handler } of createTableOps(def.tables, auditRef)) {
		env.registerFunction(signature, handler);
	}

	const foldOp = createFoldOp(
		(exprStr) => {
			const parsed = env.parse(exprStr);
			return (ctx) => parsed(ctx);
		},
		scopeRef,
		auditRef
	);
	env.registerFunction(foldOp.signature, foldOp.handler);

	for (const op of customOps) {
		env.registerFunction(op.signature, op.handler);
	}

	const exprNames = new Set(Object.keys(def.exprs));
	const exprDeps = new Map<string, Set<string>>();
	const allRefs = new Map<string, Set<string>>();
	const compiled = new Map<string, ParseResult>();

	for (const [name, exprStr] of Object.entries(def.exprs)) {
		const parsed = env.parse(exprStr);
		compiled.set(name, parsed);
		const ids = extractIdentifiers(parsed.ast);
		const { exprDeps: deps, others } = partitionDependencies(ids, exprNames);
		exprDeps.set(name, deps);
		allRefs.set(name, new Set([...deps, ...others]));
	}

	const exprOrder = topoSort(exprDeps);
	const definitionHash = hashDefinition(def);

	return {
		id: def.id,
		outputs: def.outputs,
		exprs: def.exprs,
		tables: def.tables,
		exprOrder,
		exprDeps,
		allRefs,
		definitionHash,
		compiled,
		auditRef,
		scopeRef
	};
}

/**
 * Validate a computation definition without executing it.
 *
 * Checks:
 * 1. All exprs parse as valid CEL
 * 2. No dependency cycles
 * 3. All declared outputs exist as exprs
 */
export function validateDefinition(
	def: ComputationDefinition,
	customOps: CustomOp[] = []
): ValidationResult {
	const errors: ValidationError[] = [];

	for (const out of def.outputs) {
		if (!(out in def.exprs)) {
			errors.push({ message: `Output "${out}" is not defined in exprs` });
		}
	}
	if (errors.length > 0) return { ok: false, errors };

	return Effect.runSync(
		Effect.try({
			try: () => createEnvironment(def, customOps),
			catch: (cause) => cause
		}).pipe(
			Effect.match({
				onSuccess: (env): ValidationResult => ({
					ok: true as const,
					definitionHash: env.definitionHash,
					order: env.exprOrder
				}),
				onFailure: (err): ValidationResult =>
					err instanceof CycleError
						? { ok: false, errors: [{ message: err.message }] }
						: {
								ok: false,
								errors: [{ message: err instanceof Error ? err.message : String(err) }]
							}
			})
		)
	);
}
