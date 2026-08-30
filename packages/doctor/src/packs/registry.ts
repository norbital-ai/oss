/**
 * Named packs a configuration can select by string.
 *
 * The registry is the whole modularity story: the core never statically imports an opinionated
 * rule into its default rule set, so a repository that names nothing is measured by the neutral
 * baseline alone — graph, type-aware, metrics, semantics — and a pack's code joins the audit only
 * when some repository's `doctor.config` writes its name. Since the Effect and Norbital packs
 * moved into their own packages (`@norbital-ai/doctor-effect`, `@norbital-ai/doctor-norbital`),
 * a registered name resolves through that package rather than through this one: selecting a name
 * whose package is not installed is a thrown error that says exactly what to install, never a
 * silent no-op.
 *
 * The root index does not re-export these packs at all anymore. Importing a pack explicitly —
 * `import { reactivePack } from '@norbital-ai/doctor-norbital'` — is the other selection form,
 * and needs no registry.
 */
import type { Pack } from '../rules.js';

const PACKAGES: Readonly<Record<string, { specifier: string; member: string }>> = {
	effect: { specifier: '@norbital-ai/doctor-effect', member: 'effectPack' },
	norbital: { specifier: '@norbital-ai/doctor-norbital', member: 'norbitalPack' },
	'norbital/reactive': {
		specifier: '@norbital-ai/doctor-norbital',
		member: 'reactivePack'
	}
};

/** Every selectable name, sorted — the error text below must not depend on insertion order. */
const REGISTERED_PACKS: ReadonlyArray<string> = Object.keys(PACKAGES).sort();

const LOADERS: Readonly<Record<string, () => Promise<Pack>>> = Object.fromEntries(
	REGISTERED_PACKS.map((name) => [
		name,
		async (): Promise<Pack> => {
			const { specifier, member } = PACKAGES[name] ?? {};
			try {
				const module = (await import(specifier ?? '')) as Record<string, unknown>;
				const pack = module[member ?? ''];
				if (pack === undefined || pack === null)
					throw new Error(`${specifier} does not export ${member}`);
				return pack as Pack;
			} catch (error) {
				const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
				throw new Error(
					`the "${name}" pack lives in ${specifier}, which is not resolvable from @norbital-ai/doctor — install it beside the doctor, or import the pack object from ${specifier} in your config (${detail})`
				);
			}
		}
	])
);

/**
 * Load a pack by registered name, or return `undefined` when the name is not one of ours.
 *
 * Returning `undefined` rather than throwing keeps resolution single-purpose: the caller decides
 * whether an unregistered string is a module specifier or a mistake, which is where that
 * knowledge lives. A registered name whose package is missing throws from the loader above.
 */
export async function loadRegisteredPack(name: string): Promise<Pack | undefined> {
	const loader = LOADERS[name];
	if (loader === undefined) return undefined;
	return loader();
}
