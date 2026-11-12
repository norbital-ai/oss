import { getContext, setContext } from 'svelte';
import { Predicate } from 'effect';
import { encode_wire, type Json } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import type { ViewBolt } from './contract.js';
import { useKinds, type ModelExposure } from '../kinds/context.js';
const BOLT = Symbol('ui.views.bolt');
const withOutput = (layer: Json, output: string | undefined): Json =>
	output !== undefined && Predicate.isObject(layer) && layer['output'] === undefined
		? { ...layer, output }
		: layer;
/** Hands the page's client to every view beneath; the shell calls it once per page. */
export const provide_bolt = (client: () => ViewBolt) => setContext(BOLT, client);
export const usePageContext = () => getContext<(() => ViewBolt) | undefined>(BOLT);
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
			return [path, withOutput(layer, output)];
		})
	);
/** The host client when present, its reads in the caller's view outputs; controlled local views can render without one. */
export const useOptionalBolt = (): ViewBolt | undefined => {
	const client = usePageContext(),
		catalog = useKinds().catalog;
	if (client === undefined) return undefined;
	// every member reads through the host's own client; `query` and `aggregate` gain the views' outputs
	return new Proxy(client(), {
		get: (_target, key) => {
			const target = client();
			if (key === 'query')
				return (request: { readonly [path: string]: Json }) =>
					target.query(withOutputs(request, catalog));
			if (key === 'aggregate')
				return (model: string, args: Value) =>
					target.aggregate(model, withOutput(encode_wire(args), catalog?.[model]?.output));
			const value: unknown = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
};
/** The shell client for native reads, actions and translated text. Capture it during component initialization. */
export function useBolt(): ViewBolt {
	const bolt = useOptionalBolt();
	if (bolt === undefined) throw new Error('A view needs the shell: call provide_bolt above it.');
	return bolt;
}
