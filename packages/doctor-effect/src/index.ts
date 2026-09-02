/**
 * Effect ownership and ceremony rules for the doctor.
 *
 * Matcher rules are YAML under `packs/`. The matcher compares `let`/`const` declaration-list
 * flags, so STATE1 can name `let` without also matching `const`.
 */
export { effectCeremonyPack, effectCeremonyRules } from './effect-ceremony.js';
export { effectPack, effectRules } from './effect.js';
