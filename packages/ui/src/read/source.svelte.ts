// A native query, Stream, declared query or local array, consumed by the shared UI edge.
import { Effect, Stream } from 'effect';
import type { Json, Live, Q, ViewBolt } from '../client/contract.js';
import type { Values } from '../collection/types.js';
import { watch } from './live.svelte.js';
import type { ReadState } from './state.js';

type NamedQuery = { query: string; input?: Json; on?: readonly string[] };
export type ViewSource = Q<unknown> | Live<unknown> | NamedQuery | readonly Values[];
const local = (source: ViewSource): source is readonly Values[] => Array.isArray(source);
const queryRead = (source: ViewSource): source is Q<unknown> => Effect.isEffect(source);
const named = (source: ViewSource): source is NamedQuery =>
	!local(source) && !Effect.isEffect(source) && !Stream.isStream(source) && 'query' in source;
export function readSource(
	bolt: ViewBolt,
	source: () => ViewSource,
	every: () => string | undefined
): { readonly state: ReadState<unknown> } {
	const read = watch(() => {
		const value = source(),
			interval = every(),
			options = interval === undefined ? {} : { every: interval };
		if (local(value)) return null;
		if (Stream.isStream(value)) return value;
		if (queryRead(value)) return bolt.live(value, options);
		if (named(value))
			return bolt.live(bolt.query(value.query, value.input ?? {}), {
				...options,
				on: value.on ?? [value.query.slice(0, value.query.lastIndexOf('.'))]
			});
		return null;
	});
	return {
		get state(): ReadState<unknown> {
			const value = source();
			return local(value) ? { kind: 'ready', value } : read.state;
		}
	};
}
