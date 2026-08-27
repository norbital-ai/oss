export type {
	ComputationDefinition,
	InlinedTable,
	RoundingMethod,
	ComputationManifest,
	ComputationManifestNode,
	ReckonResult,
	ValidationError,
	ValidationResult
} from './definition.js';

export {
	ComputationDefinitionSchema,
	InlinedTableSchema,
	RoundingMethodSchema,
	ComputationManifestSchema,
	ComputationManifestNodeSchema,
	ValidationErrorSchema,
	ValidationResultSchema
} from './definition.js';

export {
	canonicalSchemaStepEncoding,
	digestSchemaSteps,
	hashDefinition,
	sha256Json,
	sha256Text
} from './hash.js';
export type { DigestibleSchemaStep } from './hash.js';

// Synchronous computation runtime entry points; hashing stays portable for tenant bundles.
export { createEnvironment, validateDefinition } from './cel.server.js';
export type { ReckonEnvironment, CustomOp } from './cel.server.js';
export { runComputation } from './runtime.server.js';
export { replayManifest, ReplayResultSchema } from './replay.js';
export type { ReplayResult } from './replay.js';
export { createReckonEngine, ReckonEngine } from './register.server.js';
export type { AuditEntry, AuditRef, OpRegistration } from './ops.js';
export { extractIdentifiers, partitionDependencies, topoSort, CycleError } from './deps.js';
