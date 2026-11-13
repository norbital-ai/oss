import { Predicate } from 'effect';
import { encode_wire, type Json } from '@norbital-ai/store/wire';
import type { Value } from '@norbital-ai/store/kind';
import type { UiContext, ViewBolt } from './contract.js';
import type { ModelExposure } from '../kinds/context.js';
const withOutput = (layer: Json, output: string | undefined): Json =>
	output !== undefined && Predicate.isObject(layer) && layer['output'] === undefined
		? { ...layer, output }
		: layer;
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
/** `ctx`'s view client, its reads in the caller's view outputs; controlled local views render without one. */
export const optional_bolt_of = (ctx: UiContext): ViewBolt | undefined => {
	const first = ctx.ui.bolt;
	if (first === undefined) return undefined;
	// every member reads through the host's current client; `query` and `aggregate` gain the views' outputs
	return new Proxy(first, {
		get: (_target, key) => {
			const target = ctx.ui.bolt ?? first,
				catalog = ctx.ui.kinds.catalog;
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
/** `ctx`'s view client for native reads, actions and translated text. */
export function bolt_of(ctx: UiContext): ViewBolt {
	const bolt = optional_bolt_of(ctx);
	if (bolt === undefined) throw new Error('A view needs the shell: pass the page ctx with its ui.bolt.');
	return bolt;
}
