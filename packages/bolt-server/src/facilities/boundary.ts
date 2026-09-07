import { AsyncLocalStorage } from 'node:async_hooks';
import { Predicate } from 'effect';
import { getErrorMessage } from '@norbital-ai/std';
import {
	failure,
	makeWireError,
	type FacilityBinding,
	type FacilityBindings,
	type FacilityResult
} from '@norbital-ai/bolt-protocol';

/**
 * The host's side of the facility contract: a binding invoked for a guest answers with a
 * `FacilityResult`, and nothing it does can reach the process.
 *
 * Three ways a binding used to escape that contract. It could throw before returning a promise;
 * it could reject; and it could resolve while a socket it opened was still alive and then emit
 * `error` with no listener, which Node raises as a process-level uncaught exception. The first
 * two are converted here. The third cannot be converted after the fact, so every call runs inside
 * an async scope: whatever the binding starts, however late it fails, is still attributable to the
 * call that started it. `attributeEscapedFailure` is what the process policy consults before it
 * decides a failure belongs to the host rather than to a tenant's call.
 */
export type FacilityScope = Readonly<{
	readonly facility: string;
	readonly effectId: string;
	/** Settles the call as a failure when it is still pending; a no-op once it has answered. */
	readonly fail: (cause: unknown) => void;
}>;

const scopes = new AsyncLocalStorage<FacilityScope>();
const guarded = new WeakSet<object>();

const isFacilityResult = (value: unknown): value is FacilityResult<unknown> =>
	Predicate.isObject(value) &&
	(Reflect.get(value, '_tag') === 'Success' ||
		(Reflect.get(value, '_tag') === 'Failure' && Predicate.isObject(Reflect.get(value, 'error'))));

const facilityFailure = (facility: string, message: string) =>
	failure(
		makeWireError('facility_failure', `${facility}: ${message}`, {
			retryable: false,
			outcome: 'unknown'
		})
	);

/**
 * Wraps one binding so its `call` always resolves to a `FacilityResult`.
 *
 * A synchronous throw, a rejection and a non-result value are each that call's failure. The call
 * runs in a facility scope, so a failure raised later by work it started is attributable to it.
 * Wrapping is idempotent: a binding already guarded is returned as is.
 */
export const guardBinding = <Input, Output>(
	facility: string,
	binding: FacilityBinding<Input, Output>
): FacilityBinding<Input, Output> => {
	if (guarded.has(binding)) return binding;
	const wrapped: FacilityBinding<Input, Output> = {
		call: (metadata, input, signal, onProgress) =>
			new Promise<FacilityResult<Output>>((resolve) => {
				let settled = false;
				const settle = (result: FacilityResult<Output>) => {
					if (settled) return;
					settled = true;
					resolve(result);
				};
				const scope: FacilityScope = {
					facility,
					effectId: String(metadata.effectId ?? ''),
					fail: (cause) => settle(facilityFailure(facility, getErrorMessage(cause)))
				};
				scopes.run(scope, () => {
					try {
						Promise.resolve(binding.call(metadata, input, signal, onProgress)).then(
							(result) =>
								settle(
									isFacilityResult(result)
										? (result as FacilityResult<Output>)
										: facilityFailure(facility, 'binding answered with something other than a facility result')
								),
							(cause: unknown) => settle(facilityFailure(facility, getErrorMessage(cause)))
						);
					} catch (cause) {
						settle(facilityFailure(facility, getErrorMessage(cause)));
					}
				});
			})
	};
	guarded.add(wrapped);
	return wrapped;
};

/** Guards every binding in the set; `scope` and anything that is not a binding pass through. */
export const guardBindings = (bindings: FacilityBindings): FacilityBindings => {
	const entries = Object.entries(bindings).map(([name, value]) =>
		Predicate.isObject(value) && typeof Reflect.get(value, 'call') === 'function'
			? [name, guardBinding(name, value as FacilityBinding<unknown, unknown>)]
			: [name, value]
	);
	return Object.fromEntries(entries) as FacilityBindings;
};

/**
 * Names the facility call whose async scope raised a process-level failure, settling that call as a
 * failure if it has not answered yet. `undefined` when the failure is the host's own.
 *
 * Node keeps the raising callback's async context active while it emits `uncaughtException` and
 * `unhandledRejection`, which is what makes the scope readable here.
 */
export const attributeEscapedFailure = (cause: unknown): FacilityScope | undefined => {
	const scope = scopes.getStore();
	if (scope === undefined) return undefined;
	scope.fail(cause);
	return scope;
};
