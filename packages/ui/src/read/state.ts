import type { LiveError } from '../client/contract.js';
export type ReadState<T> =
	| { kind: 'loading' }
	| { kind: 'empty' }
	| { kind: 'noAccess' }
	| { kind: 'error'; code: string; message: string }
	| { kind: 'ready'; value: T };
export function readState<T>(
	value: T | undefined,
	error: LiveError | undefined,
	loading = true
): ReadState<T> {
	if (error !== undefined)
		return error.code === 'forbidden'
			? { kind: 'noAccess' }
			: { kind: 'error', code: error.code, message: error.message };
	return value === undefined ? { kind: loading ? 'loading' : 'empty' } : { kind: 'ready', value };
}
/** A one-shot read's rejection as a state (reads reject with `{ code }`, §3.5). */
export const failed = (e: unknown): ReadState<never> => {
	const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'error';
	return code === 'forbidden'
		? { kind: 'noAccess' }
		: { kind: 'error', code, message: e instanceof Error ? e.message : String(e) };
};
