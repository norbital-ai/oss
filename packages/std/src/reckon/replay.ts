import type { ComputationDefinition, ComputationManifest } from './definition.js';
import { createEnvironment } from './cel.server.js';
import { runComputationWithEnv } from './runtime.server.js';

/** Result of replaying a manifest. */
export type ReplayResult = {
	/** The outputs produced by replaying. */
	outputs: Record<string, unknown>;
	/** Whether the replayed outputs match the manifest's recorded outputs. */
	matches: boolean;
	/** Per-output comparison (only included when there's a mismatch). */
	mismatches?: Record<string, { expected: unknown; actual: unknown }>;
};

/**
 * Replay a computation manifest to verify integrity.
 *
 * Re-runs the computation using the manifest's `inputSnapshot` and the
 * provided definition, then compares the outputs to the manifest's recorded
 * outputs. This is the core audit verification — if `matches` is `true`,
 * the recorded result is provably correct for the recorded inputs and definition.
 *
 * The caller must provide the `ComputationDefinition` that corresponds to the
 * manifest's `definitionHash`. In production, definitions are stored as DB
 * records keyed by hash, so the caller looks up the def by hash then replays.
 *
 * @example
 * ```ts
 * const result = replayManifest(manifest, storedDefinition);
 * if (!result.matches) {
 *   console.error('Audit failure:', result.mismatches);
 * }
 * ```
 */
export function replayManifest(
	manifest: ComputationManifest,
	def: ComputationDefinition
): ReplayResult {
	const env = createEnvironment(def);

	if (env.definitionHash !== manifest.definitionHash) {
		return {
			outputs: {},
			matches: false,
			mismatches: { _hash: { expected: manifest.definitionHash, actual: env.definitionHash } }
		};
	}

	const { outputs } = runComputationWithEnv(env, manifest.inputSnapshot);

	const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
	let matches = true;

	for (const [key, recorded] of Object.entries(manifest.outputs)) {
		const replayed = outputs[key];
		if (!deepEqual(recorded.value, replayed)) {
			matches = false;
			mismatches[key] = { expected: recorded.value, actual: replayed };
		}
	}

	return { outputs, matches, mismatches: matches ? undefined : mismatches };
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;
	if (typeof a !== 'object') return a === b;
	if (typeof b !== 'object') return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		return a.every((value, index) => deepEqual(value, b[index]));
	}
	if (Array.isArray(b)) return false;
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	return ak.every((key) => deepEqual(Reflect.get(a, key), Reflect.get(b, key)));
}
