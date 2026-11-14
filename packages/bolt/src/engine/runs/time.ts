// The run queue's shared time arithmetic.
import { Array as EffectArray } from 'effect';
import { duration_seconds } from '@norbital-ai/store/vars';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { compile_var, evaluate_var, type ActorVars } from '@norbital-ai/store/vars';

export const BUCKET_MS = 300_000;
export function duration(value: string): number {
	const seconds = duration_seconds(value, true);
	if (seconds === undefined)
		throw BoltError.make('invalid', 'decode', `'${value}' is not a duration`);
	return seconds * 1_000;
}
export const due_at = (now: number, at: number): number =>
	at - now < BUCKET_MS ? at : Math.ceil(at / BUCKET_MS) * BUCKET_MS;
export const iso = (ms: number): string => new Date(ms).toISOString();
/** What an edge evaluates a read's time variables at: its day and instant, and its actor where it is known. */
export type VarsAt = {
	readonly today: string;
	readonly now: string;
	readonly actor?: ActorVars;
};
/**
 * A read's time variables at the edge — a `{ var }` CEL expression reading `today` (the workspace-zone date) or `now`
 * (the instant): `{ var: 'today - days(7)' }`, `{ var: 'start_of_month(today)' }` — as the literals they are at `at`. The
 * wire and the store never carry a time variable: the agent's read and a described filter materialize before lowering;
 * a page materializes at `bolt.clock`. An actor-only variable stays for the read to bind; a faulty one stays for
 * the read to refuse.
 */
export function materialize(v: Json, at: VarsAt): Json {
	if (v === null || typeof v !== 'object') return v;
	if (EffectArray.isArray<typeof v>(v)) return v.map((x) => materialize(x, at));
	const text = v['var'];
	if (typeof text === 'string' && Object.keys(v).length === 1) {
		const c = compile_var(text);
		if ('error' in c || !c.time) return v;
		try {
			return evaluate_var(c, at);
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
