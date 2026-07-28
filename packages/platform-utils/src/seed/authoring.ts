// Seed authoring primitives + reckon helpers, usable without depending on pod.
// The contract lives here (below pod in the dependency graph); pod re-exports it.
export type {
	SeedStepId,
	SeedMutationStep,
	CompiledSeedPlan,
	WorkspaceSeedDefinition,
	SeedRecordRef,
	SeedSystemFields,
	SeedInsertRecord,
	SeedRelationRow
} from './plan.js';
export {
	defineSeed,
	seedStep,
	seedRef,
	seedRow,
	seedRows,
	sortSeedSteps,
	compileSeedManifest,
	compiledSeedPlanFromManifest
} from './plan.js';

export type { SeedManifest, SeedManifestStep } from './manifest.js';
export { SEED_MANIFEST_CONTRACT_VERSION, parseSeedManifest, seedManifestJson } from './manifest.js';

// Re-export reckon primitives used by seed step authoring (hashing computation defs).
export type {
	ComputationDefinition,
	InlinedTable,
	RoundingMethod,
	ComputationManifest,
	ComputationManifestNode,
	ReckonResult,
	ValidationError,
	ValidationResult
} from '@norbital-ai/std/reckon';
export { hashDefinition } from '@norbital-ai/std/reckon';
