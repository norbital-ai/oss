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

/** Whether a signed Unix timestamp is within the platform's delivery window. */
export const fresh = (timestamp: string | null, toleranceS = 300): boolean =>
	Math.abs(Date.now() / 1000 - Number(timestamp)) <= toleranceS;

/** Standard Webhooks sign the delivery id, timestamp and raw body. */
export const standardWebhook = (
	headers: Headers,
	body: string,
	key: Buffer,
	version?: 'v1'
): void => {
	const id = headers.get('webhook-id');
	const at = headers.get('webhook-timestamp');
	const want = hmac(key, `${id}.${at}.${body}`, 'base64');
	const matches = headers
		.get('webhook-signature')
		?.split(' ')
		.some((one) =>
			version === undefined
				? same(one.slice(one.indexOf(',') + 1), want)
				: same(one, `${version},${want}`)
		);
	if (id === null || !fresh(at) || matches !== true) throw new Unverified('bad signature');
};
