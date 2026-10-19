import { Cause, type Stream } from 'effect';
import { live } from '../effect/index.js';
import { failed, readState } from './state.js';
/** A component-owned live read: follows its reactive source, exposes value/error/state and releases subscriptions. */
export function watch<T, E>(source: () => Stream.Stream<T, E> | null) {
	const store = live(source);
	return {
		get state() {
			const result = store.result;
			return result._tag === 'Failure'
				? failed(store.error ?? Cause.squash(result.cause))
				: readState(store.current, undefined, store.loading);
		},
		get value() {
			return store.current;
		},
		get error() {
			return store.error;
		}
	};
}
