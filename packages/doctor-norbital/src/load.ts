/**
 * Where this package's pack YAML lives, relative to this module.
 *
 * Compiled output sits at `build/`; source sits at `src/`. One directory up is the package root.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackDirectory, type Rule } from '@norbital-ai/doctor';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadLocalRules(name: string): ReadonlyArray<Rule> {
	return loadPackDirectory(join(PACKAGE_ROOT, 'packs', name));
}
