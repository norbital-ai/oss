/**
 * Named packs a configuration can select by string.
 *
 * The registry is the whole modularity story: the core never statically imports an opinionated
 * rule into its default rule set, so a repository that names nothing is measured by the neutral
 * baseline alone — graph, type-aware, metrics, semantics — and a pack's code joins the audit only
 * when some repository's `doctor.config` writes its name. Adding a curated rule set is adding an
 * entry here, not editing the engine.
 *
 * The root index also re-exports individual packs for pack authors and tests; importing one of
 * those explicitly is an opt-in act by the importer. What this registry owns is the default: it
 * stays empty.
 */
import type { Pack } from '../rules.js';

const REGISTRY: Readonly<Record<string, () => Promise<Pack>>> = {
	norbital: async () => (await import('./norbital.js')).norbitalPack
};

/** Every selectable name, sorted — the error text below must not depend on insertion order. */
const REGISTERED_PACKS: ReadonlyArray<string> = Object.keys(REGISTRY).sort();

/**
 * Load a pack by registered name, or return `undefined` when the name is not one of ours.
 *
 * Returning `undefined` rather than throwing keeps resolution single-purpose: the caller decides
 * whether an unregistered string is a module specifier or a mistake, which is where that
 * knowledge lives.
 */
export async function loadRegisteredPack(name: string): Promise<Pack | undefined> {
	const loader = REGISTRY[name];
	if (loader === undefined) return undefined;
	return loader();
}
