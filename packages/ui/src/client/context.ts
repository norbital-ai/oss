import { getContext, setContext } from 'svelte';
import { Predicate } from 'effect';
import type { Json } from '@norbital-ai/std/wire';
import type { ViewBolt } from './contract.js';
import { useKinds, type ModelExposure } from '../kinds/context.js';
export const BOLT = Symbol('ui.views.bolt');
/** Hands the page's client to every view beneath; the shell calls it once per page. */
export const provideBolt = (bolt: ViewBolt) => setContext(BOLT, bolt);
/**
 * A view's read request with each root that names no `output` reading the one the catalog gives the caller's views
 * (`ModelExposure.output`; absent: `default`).
 */
export const withOutputs = (
	request: { readonly [path: string]: Json },
	catalog: { readonly [model: string]: ModelExposure } | undefined
): { readonly [path: string]: Json } =>
	Object.fromEntries(
		Object.entries(request).map(([path, layer]) => {
			const output = path.includes('.') ? undefined : catalog?.[path]?.output;
			return [
				path,
				output !== undefined && Predicate.isObject(layer) && layer['output'] === undefined
					? { ...layer, output }
					: layer
			];
		})
	);
/** The host client when present, its reads in the caller's view outputs; controlled local views can render without one. */
export const useOptionalBolt = (): ViewBolt | undefined => {
	const bolt = getContext<ViewBolt | undefined>(BOLT),
		catalog = useKinds().catalog;
	if (bolt === undefined) return undefined;
	// every member reads through the host's own client; only `query` gains the views' outputs
	return new Proxy(bolt, {
		get: (target, key) => {
			if (key === 'query')
				return (request: { readonly [path: string]: Json }) =>
					target.query(withOutputs(request, catalog));
			const value: unknown = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
};
/** The shell client for native reads, actions and translated text. Capture it during component initialization; eagerly registered renderers can avoid importing `$bolt` before boot. */
export function useBolt(): ViewBolt {
	const bolt = useOptionalBolt();
	if (bolt === undefined)
		throw new Error('A view needs the shell: call provideBolt(bolt) above it.');
	return bolt;
}
