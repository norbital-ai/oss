// The signature every webhook platform has some form of: an HMAC of the raw body, compared in constant time.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Unverified } from './adapter.ts';

export const hmac = (secret: string | Buffer, body: string, encoding: 'hex' | 'base64') =>
	createHmac('sha256', secret).update(body).digest(encoding);
/** Whether `given` is `want`, in constant time. */
export const same = (given: string, want: string) => {
	const a = Buffer.from(given),
		b = Buffer.from(want);
	return a.length === b.length && timingSafeEqual(a, b);
};
/** Refuses a delivery whose signature is not `want`. */
export const signed = (given: string | null, want: string) => {
	if (given === null || !same(given, want)) throw new Unverified('bad signature');
};
