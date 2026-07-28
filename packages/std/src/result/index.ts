import type { Outcome } from './outcome.js';
import { failure as _failure, success as _success } from './outcome.js';
export type { Outcome } from './outcome.js';

function buildError<E>(err: unknown, mapErr?: (err: unknown) => E): E {
	if (mapErr) return mapErr(err);
	if (err instanceof Error) return err as E;
	// Preserve SvelteKit control-flow throwables (Redirect, HttpError) — they are not Error instances.
	return err as E;
}

export function tryCatch<T>(fn: () => T): Outcome<T>;
export function tryCatch<T, E>(fn: () => T, mapErr: (err: unknown) => E): Outcome<T, E>;
export function tryCatch<T>(promise: Promise<T>): Promise<Outcome<T>>;
export function tryCatch<T, E>(
	promise: Promise<T>,
	mapErr: (err: unknown) => E
): Promise<Outcome<T, E>>;
export function tryCatch<T>(fn: () => Promise<T>): Promise<Outcome<T>>;
export function tryCatch<T, E>(
	fn: () => Promise<T>,
	mapErr: (err: unknown) => E
): Promise<Outcome<T, E>>;
export function tryCatch<T, E = Error>(
	fnOrPromise: (() => T) | (() => Promise<T>) | Promise<T>,
	mapErr?: (err: unknown) => E
): Outcome<T, E> | Promise<Outcome<T, E>> {
	if (fnOrPromise instanceof Promise) {
		return fnOrPromise.then(
			(result): Outcome<T, E> => _success(result),
			(err): Outcome<T, E> => _failure(buildError(err, mapErr))
		);
	}

	if (typeof fnOrPromise === 'function') {
		try {
			const result = fnOrPromise();
			if (result instanceof Promise) {
				return result.then(
					(r): Outcome<T, E> => _success(r),
					(err): Outcome<T, E> => _failure(buildError(err, mapErr))
				);
			}
			return _success<T, E>(result);
		} catch (err: unknown) {
			return _failure<T, E>(buildError(err, mapErr));
		}
	}

	throw new TypeError('tryCatch: expected a function or Promise');
}

export { failure, isFailure, isSuccess, success } from './outcome.js';
