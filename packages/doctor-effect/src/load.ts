/**
 * Where this package's pack YAML lives, relative to this module.
 *
 * Compiled output sits at `build/`; source sits at `src/`. One directory up is the package root.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePack, loadPackDirectory, type Pack, type Rule } from '@norbital-ai/doctor';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadLocalPack(
	name: string,
	packName: string
): { rules: ReadonlyArray<Rule>; pack: Pack } {
	const rules = loadPackDirectory(join(PACKAGE_ROOT, 'packs', name));
	return { rules, pack: definePack({ name: packName, rules }) };
}
