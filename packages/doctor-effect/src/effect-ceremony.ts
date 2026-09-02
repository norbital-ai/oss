/**
 * Effect used as ceremony rather than for what Effect is for.
 *
 * The pack is `packs/ceremony/*.yaml`. This module only loads that directory.
 */
import { loadLocalPack } from './load.js';

const loaded = loadLocalPack('ceremony', 'norbital/effect-ceremony');

export const effectCeremonyPack = loaded.pack;
export const effectCeremonyRules = loaded.rules;
