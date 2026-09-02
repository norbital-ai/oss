/**
 * Reactive-ownership rules.
 *
 * The pack is `packs/reactive/*.yaml`. This module only loads that directory.
 */
import { definePack } from '@norbital-ai/doctor';
import { loadLocalRules } from './load.js';

export const reactivePack = definePack({
	name: 'norbital/reactive',
	rules: loadLocalRules('reactive')
});
