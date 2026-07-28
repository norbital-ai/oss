import type {
	ComputationDefinition,
	ComputationManifest,
	ReckonResult,
	ValidationResult
} from './definition.js';
import type { ReckonEnvironment, CustomOp } from './cel.server.js';
import { createEnvironment, validateDefinition } from './cel.server.js';
import { runComputationWithEnv } from './runtime.server.js';
import { replayManifest, type ReplayResult } from './replay.js';
import { hashDefinition } from './hash.js';

/**
 * Reckon computation engine — declarative, auditable, pure.
 *
 * Create an instance via `createReckonEngine()`. Register custom ops for
 * domain-specific calculations. Validate and run computation definitions.
 *
 * @example
 * ```ts
 * const engine = createReckonEngine();
 *
 * const def: ComputationDefinition = {
 *   id: 'pcb',
 *   tables: { pcbTable: { kind: 'progressive', rows: [...] } },
 *   exprs: { pcb: 'round(applyProgressive(income * 12, "pcbTable") / 12, "NEAREST_CENT")' },
 *   outputs: ['pcb'],
 * };
 *
 * const { outputs, manifest } = engine.runComputation<{ income: number }, { pcb: number }>(def, { income: 5000 });
 * console.log(outputs.pcb); // typed as number
 * console.log(manifest.nodes[0].opAudit); // { op: 'applyProgressive', audit: { matchedTier: {...} } }
 * ```
 */
export class ReckonEngine {
	private readonly customOps: CustomOp[] = [];
	private readonly envCache = new Map<string, ReckonEnvironment>();

	/** Register a custom op available in all computations. Invalidates the env cache. */
	registerFunction(
		name: string,
		signature: string,
		handler: (...args: unknown[]) => unknown
	): this {
		this.customOps.push({ signature, handler });
		this.envCache.clear();
		return this;
	}

	/** Validate a computation definition without executing it. */
	validateDefinition(def: ComputationDefinition): ValidationResult {
		return validateDefinition(def, this.customOps);
	}

	/**
	 * Run a computation and return typed outputs + a full replayable manifest.
	 *
	 * The compiled environment is cached by definition hash, so repeated runs
	 * with different inputs reuse the parsed/topo-sorted CEL expressions.
	 *
	 * @typeParam TInput - The input shape
	 * @typeParam TOutput - The output shape
	 */
	runComputation<
		TInput extends object = Record<string, unknown>,
		TOutput = Record<string, unknown>
	>(def: ComputationDefinition, input: TInput): ReckonResult<TOutput> {
		const env = this.getOrCreateEnv(def);
		return runComputationWithEnv<TInput, TOutput>(env, input);
	}

	/** Replay a manifest to verify integrity against a stored definition. */
	replayManifest(manifest: ComputationManifest, def: ComputationDefinition): ReplayResult {
		return replayManifest(manifest, def);
	}

	/** Get or create a cached environment for a definition. */
	private getOrCreateEnv(def: ComputationDefinition): ReckonEnvironment {
		const hash = hashDefinition(def);
		let env = this.envCache.get(hash);
		if (!env) {
			env = createEnvironment(def, this.customOps);
			this.envCache.set(hash, env);
		}
		return env;
	}
}

/** Create a new Reckon engine instance. */
export function createReckonEngine(): ReckonEngine {
	return new ReckonEngine();
}
