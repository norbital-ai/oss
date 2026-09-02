/**
 * Typed boundaries: `any`, casts, and decoding.
 *
 * The pack is `packs/boundaries/*.yaml`. This module only loads that directory.
 */
import { loadYamlPack } from './load.js';

const loaded = loadYamlPack('boundaries', 'norbital/boundaries');

export const boundaryRules = loaded.rules;
export const boundariesPack = loaded.pack;
