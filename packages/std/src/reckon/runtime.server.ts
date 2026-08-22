import type {
	ComputationDefinition,
	ComputationManifest,
	ComputationManifestNode,
	ReckonResult
} from './definition.js';
import type { ReckonEnvironment } from './cel.server.js';
import { createEnvironment } from './cel.server.js';
import type { AuditEntry } from './ops.js';

/**
 * Execute a computation against an input and produce typed outputs + a full manifest.
 *
 * If no environment is provided, one is created from the definition (and should
 * be cached by the caller for repeated runs with different inputs). Each expr is
 * evaluated in topo-sorted order. Results accumulate into the scope so dependent
 * exprs can reference them. The audit sink is cleared before each expr and read
 * after to capture structured op audit.
 *
 * @typeParam TInput - The input shape (defaults to `Record<string, unknown>`)
 * @typeParam TOutput - The output shape (defaults to `Record<string, unknown>`)
 *
 * @example
 * ```ts
 * const { outputs, manifest } = runComputation<PayrollInput, PayrollOutput>(def, input);
 * // outputs.netPay: number  (typed by PayrollOutput)
 * // manifest.nodes: [{ id: 'pcb', expr: '...', inputs: {...}, output: 416.67, opAudit: {...} }]
 * ```
 */
export function runComputation<
	TInput extends object = Record<string, unknown>,
	TOutput extends Record<string, unknown> = Record<string, unknown>
>(def: ComputationDefinition, input: TInput, env?: ReckonEnvironment): ReckonResult<TOutput> {
	const reckonEnv = env ?? createEnvironment(def);
	return evaluate<TInput, TOutput>(reckonEnv, input);
}

function evaluate<TInput extends object, TOutput extends Record<string, unknown>>(
	reckonEnv: ReckonEnvironment,
	input: TInput
): ReckonResult<TOutput> {
	const inputSnapshot = Object.fromEntries(Object.entries(input));
	const scope: Record<string, unknown> = { ...inputSnapshot };
	const nodes: ComputationManifestNode[] = [];

	for (const name of reckonEnv.exprOrder) {
		reckonEnv.scopeRef.scope = scope;
		reckonEnv.auditRef.sink = [];

		const compiled = reckonEnv.compiled.get(name);
		if (!compiled) throw new Error(`No compiled expression for "${name}"`);

		const result = compiled(scope);
		scope[name] = result;

		const auditEntries: AuditEntry[] = reckonEnv.auditRef.sink;

		const foldEntry = auditEntries.find((e) => e.op === 'fold');
		const foldAudit = foldEntry?.audit as
			{ iterations: { input: unknown; output: unknown }[] } | undefined;
		const iterations = foldAudit?.iterations?.map((it) => ({ input: it.input, output: it.output }));

		const nonFoldAudit = auditEntries.filter((e) => e.op !== 'fold');
		const opAudit =
			nonFoldAudit.length > 0
				? nonFoldAudit.length === 1
					? nonFoldAudit[0]
					: nonFoldAudit
				: undefined;

		const deps = reckonEnv.exprDeps.get(name) ?? new Set<string>();
		const inputs: Record<string, unknown> = {};
		for (const dep of deps) {
			if (dep in scope) inputs[dep] = scope[dep];
		}

		nodes.push({
			id: name,
			expr: reckonEnv.exprs[name]!,
			inputs,
			output: result,
			opAudit,
			iterations
		});
	}

	const outputs: Record<string, unknown> = {};
	const manifestOutputs: Record<string, { value: unknown; nodeId: string }> = {};
	for (const out of reckonEnv.outputs) {
		outputs[out] = scope[out];
		manifestOutputs[out] = { value: scope[out], nodeId: out };
	}

	const manifest: ComputationManifest = {
		computationId: reckonEnv.id,
		definitionHash: reckonEnv.definitionHash,
		inputSnapshot,
		nodes,
		outputs: manifestOutputs
	};

	return { outputs: outputs as TOutput, manifest };
}
