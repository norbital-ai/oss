/**
 * The Norbital product rule pack for the doctor.
 *
 * `packs: ['norbital']` in a config selects the aggregate through the core's registry, which
 * resolves this package by name; importing `norbitalPack` directly is the explicit form. Either
 * way it is a pack like any other — a repository that omits it gets none of it, which is what
 * keeps the engine product-neutral rather than a Norbital tool that other projects tolerate.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	boundaryRules,
	definePack,
	loadPackDirectory,
	structureRules,
	type Pack,
	type Rule
} from '@norbital-ai/doctor';
import { effectRules } from '@norbital-ai/doctor-effect';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

function load(name: string): ReadonlyArray<Rule> {
	return loadPackDirectory(join(PACKS, name));
}

export const platformRules: ReadonlyArray<Rule> = load('platform');
export const platformPack: Pack = definePack({ name: 'norbital/platform', rules: platformRules });

export const svelteRules: ReadonlyArray<Rule> = load('svelte');
export const sveltePack: Pack = definePack({ name: 'norbital/svelte', rules: svelteRules });

export function capabilityPack(): Pack {
	return definePack({ name: 'norbital/capability', rules: load('capability') });
}

export const reactivePack = definePack({
	name: 'norbital/reactive',
	rules: load('reactive')
});

/** Every syntactic rule the base enforces. */
export const norbitalRules: ReadonlyArray<Rule> = [
	...boundaryRules,
	...effectRules,
	...structureRules,
	...platformRules,
	...svelteRules,
	...capabilityPack().rules
];

export const norbitalPack: Pack = definePack({ name: 'norbital/base', rules: norbitalRules });
