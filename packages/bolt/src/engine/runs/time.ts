// The run queue's shared time arithmetic (rules 52a and 54).
import { BoltError } from '../../protocol/errors.ts';

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
