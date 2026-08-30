/**
 * The `norbital` pack: every rule ported from the legacy detector, plus the two rules that
 * replaced its co-occurrence family.
 *
 * `packs: ['norbital']` in a config selects this. It is a pack like any other — a repository that
 * omits it gets none of it, which is what makes the engine product-neutral rather than a Norbital
 * tool that other projects tolerate.
 */
import { capabilityPack } from './capability.js';
import { definePack, type Pack, type Rule } from '@norbital-ai/doctor';
import { boundaryRules } from '@norbital-ai/doctor';
import { effectRules } from '@norbital-ai/doctor-effect';
import { platformRules } from './platform.js';
import { structureRules } from '@norbital-ai/doctor';
import { svelteRules } from './svelte.js';

/**
 * Every syntactic rule the base enforces.
 *
 * The capability rows come last because they are the ones that replaced `QRY1` and `MUT1`: those
 * two legacy rules are not in `platformRules`, deliberately, because a co-occurrence rule keyed on
 * variable names is the specific mistake this rebuild exists to correct.
 */
export const norbitalRules: ReadonlyArray<Rule> = [
	...boundaryRules,
	...effectRules,
	...structureRules,
	...platformRules,
	...svelteRules,
	...capabilityPack().rules
];

export const norbitalPack: Pack = definePack({ name: 'norbital/base', rules: norbitalRules });
