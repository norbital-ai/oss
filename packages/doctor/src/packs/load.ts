/**
 * Where shipped pack YAML lives, relative to this module.
 *
 * Compiled output sits at `build/packs/`; source sits at `src/packs/`. In both cases two
 * directories up is the package root, which is where `packs/` is published from.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackDirectory } from '../patterns-yaml.js';
import { definePack, type Pack, type Rule } from '../rules.js';

const DOCTOR_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function packDirectory(name: string): string {
	return join(DOCTOR_PACKAGE_ROOT, 'packs', name);
}

/** Load a shipped YAML pack and wrap it. The directory is the pack. */
export function loadYamlPack(
	name: string,
	packName: string
): { rules: ReadonlyArray<Rule>; pack: Pack } {
	const rules = loadPackDirectory(packDirectory(name));
	return { rules, pack: definePack({ name: packName, rules }) };
}
