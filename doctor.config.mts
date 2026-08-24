import {
	defineConfig,
	reactivePack,
	stringlyPack,
	effectCeremonyPack
} from './packages/doctor/build/index.js';

/**
 * Reactive-ownership rules run beside the built-in detector, not instead of it.
 *
 * They exist because the built-in `QRY1` matches a naming shape rather than the law it documents,
 * so a timer driving `query.refresh()` inside an `$effect` went unreported across the whole package.
 */
export default defineConfig({ packs: [reactivePack, stringlyPack, effectCeremonyPack] });
