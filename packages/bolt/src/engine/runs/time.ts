// The run queue's shared time arithmetic (rules 52a and 54).
import { Array as EffectArray } from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { compileVar, evaluateVar, type Requestor } from '@norbital-ai/std/vars';

const UNIT_MS: Readonly<Record<string, number>> = {
	s: 1_000,
	min: 60_000,
	h: 3_600_000,
	d: 86_400_000
};
export const BUCKET_MS = 300_000;
export function duration(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(s|min|h|d)$/.exec(value);
	const unit = match === null ? undefined : UNIT_MS[match[2] ?? ''];
	if (match === null || unit === undefined)
		throw BoltError.make('invalid', 'decode', `'${value}' is not a duration`);
	return Number(match[1]) * unit;
}
export function offsetMs(value: string): number {
	if (value === '') return 0;
	if (value[0] !== '+' && value[0] !== '-')
		throw BoltError.make('invalid', 'decode', `'${value}' is not an offset`);
	return (value[0] === '-' ? -1 : 1) * duration(value.slice(1));
}
export const dueAt = (now: number, at: number): number =>
	at - now < BUCKET_MS ? at : Math.ceil(at / BUCKET_MS) * BUCKET_MS;
export const backoffMs = (backoff: string, attempt: number): number =>
	Math.min(duration(backoff) * 2 ** (attempt - 1), 3_600_000);
export const iso = (ms: number): string => new Date(ms).toISOString();
/** What an edge evaluates a read's time variables at: its day and instant, and its requestor where it is known. */
export type VarsAt = {
	readonly today: string;
	readonly now: string;
	readonly requestor?: Requestor;
};
/**
 * A read's time variables at the edge — a `{ var }` CEL expression reading `today` (the workspace-zone date) or `now`
 * (the instant): `{ var: 'today - days(7)' }`, `{ var: 'startOfMonth(today)' }` — as the literals they are at `at`. The
 * wire and the store never carry a time variable: the agent's read and a described filter materialize before lowering;
 * a page materializes at `bolt.clock`. A requestor-only variable stays for the read to bind; a faulty one stays for
 * the read to refuse.
 */
export function materialize(v: Json, at: VarsAt): Json {
	if (v === null || typeof v !== 'object') return v;
	if (EffectArray.isArray<typeof v>(v)) return v.map((x) => materialize(x, at));
	const text = v['var'];
	if (typeof text === 'string' && Object.keys(v).length === 1) {
		const c = compileVar(text);
		if ('error' in c || !c.time) return v;
		try {
			return evaluateVar(c, at);
		} catch (cause) {
			throw BoltError.make(
				'invalid',
				'decode',
				`'${text}': ${cause instanceof Error ? cause.message : String(cause)}`
			);
		}
	}
	return materializeEach(v, at);
}
/** `materialize` over an object's members (a `where`). */
export const materializeEach = (
	o: { readonly [key: string]: Json },
	at: VarsAt
): { readonly [key: string]: Json } =>
	Object.fromEntries(Object.entries(o).map(([k, x]) => [k, materialize(x, at)]));
