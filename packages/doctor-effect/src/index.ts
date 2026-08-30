/**
 * Effect ownership and ceremony rules for the doctor.
 *
 * These are the packs a repository imports when Effect is part of its architecture and its
 * ownership laws should be enforced beside the neutral baseline. Everything here is authored on
 * the core's public surface — `defineRule`, `definePack`, and their friends — so this package is
 * a worked example of the pack-authoring API as much as a rule set.
 */
export { effectCeremonyPack, effectCeremonyPatterns } from './effect-ceremony.js';
export { effectPack, effectRules } from './effect.js';
