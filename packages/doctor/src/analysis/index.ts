/**
 * Public surface of the analyzer port.
 *
 * One entrypoint, deliberately. `assembleReport` is byte-compatible with
 * `engine/scripts/analyze.mjs` given the same canonical options: same report JSON and markdown,
 * same atomic output behavior, same verdicts. The cutover replaces the engine spawn with this call
 * and maps `exitCode` onto the process exit status — nothing else changes.
 */
export { assembleReport } from './snapshot.js';
export type { AssembleOptions, AssembleResult, ReportFormat } from './snapshot.js';
export { computeCheckpointDelta, deltaSummary } from './delta.js';
export type {
	CheckpointDelta,
	DeltaOptions,
	DeltaSide,
	PillarDelta
} from './delta.js';
