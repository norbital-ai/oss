/**
 * The Norbital product rule pack for the doctor.
 *
 * `packs: ['norbital']` in a config selects the aggregate through the core's registry, which
 * resolves this package by name; importing `norbitalPack` directly is the explicit form. Either
 * way it is a pack like any other — a repository that omits it gets none of it, which is what
 * keeps the engine product-neutral rather than a Norbital tool that other projects tolerate.
 */
export { CAPABILITIES, capabilityPack, defineCapability } from './capability.js';
export { norbitalPack, norbitalRules } from './norbital.js';
export { platformPack, platformRules } from './platform.js';
export { reactivePack } from './reactive.js';
export { sveltePack, svelteRules } from './svelte.js';
