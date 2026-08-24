import type { Component } from 'svelte';
import type { DataRendererProps } from './data-renderer.types.js';

/**
 * The platform-owned datatypes' renderer loaders, keyed by catalog kind.
 *
 * This is the counterpart of the `customTypeRendererLoaders` a workspace generates for its own
 * `src/datatypes/<name>/+renderer.svelte` files — same shape, same consumption point, one
 * acquisition difference: the platform's loaders are injected (`renderClientRuntime` spreads
 * them into the same map) rather than discovered. The `@norbital-ai/bolt` compiler builds the
 * final map keyed by the name every `custom()` column declares. Platform definitions do not get a
 * second kind alias; `money` and `instant_range` resolve exactly as tenant datatype names do.
 */
export const platformCustomTypeRenderers: Readonly<
	Record<string, () => Promise<Component<DataRendererProps>>>
> = {
	money: () => import('./money/money.renderer.svelte').then((module) => module.default),
	instant_range: () =>
		import('./time_stamp_range/timestamp_range.renderer.svelte').then((module) => module.default)
};
