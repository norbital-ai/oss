/**
 * Metric primitives for the merged analyzer: pure functions over the compiler AST plus a few
 * arithmetic formulas that take numbers in. Everything here is deterministic by contract —
 * no wall clock, no registry, no ambient state — so callers inject `now` and resolvers where
 * the outside world is unavoidable.
 */
export { cognitiveComplexity } from './cognitive.js';
export { halsteadVolume } from './halstead.js';
export type { Halstead } from './halstead.js';
export { maintainabilityIndex } from './maintainability.js';
export type { MaintainabilityInput } from './maintainability.js';
export { crap } from './crap.js';
export { lcomHendersonSellers } from './lcom.js';
export {
	abstractness,
	countAbstractDeclarations,
	distanceFromMainSequence,
	instability
} from './main-sequence.js';
export { countSuppressions } from './suppression.js';
export type { SuppressionCensus } from './suppression.js';
export { analyzeAssertions } from './assertions.js';
export type { AssertionReport } from './assertions.js';
export { computeLibyear, parseRange } from './libyear.js';
export type { LibyearManifest, LibyearReport, LibyearRow, RegistryView } from './libyear.js';
