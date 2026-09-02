/**
 * Effect ownership and ceremony rules for the doctor.
 *
 * Matcher rules are YAML under `packs/`. The matcher compares `let`/`const` declaration-list
 * flags, so STATE1 can name `let` without also matching `const`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePack, loadPackDirectory, type Pack, type Rule } from '@norbital-ai/doctor';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

function load(name: string, packName: string): { rules: ReadonlyArray<Rule>; pack: Pack } {
	const rules = loadPackDirectory(join(PACKS, name));
	return { rules, pack: definePack({ name: packName, rules }) };
}

const effect = load('effect', 'norbital/effect');
export const effectRules = effect.rules;
export const effectPack = effect.pack;

const ceremony = load('ceremony', 'norbital/effect-ceremony');
export const effectCeremonyRules = ceremony.rules;
export const effectCeremonyPack = ceremony.pack;
