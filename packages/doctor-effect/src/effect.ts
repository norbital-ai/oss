/**
 * Effect ownership: failure, concurrency, time, logging and IO.
 *
 * The pack is `packs/effect/*.yaml`. This module only loads that directory.
 */
import { loadLocalPack } from './load.js';

const loaded = loadLocalPack('effect', 'norbital/effect');

export const effectRules = loaded.rules;
export const effectPack = loaded.pack;
