/// <reference types="node" />
// Webhooks (rule 56a): the signature is verified by the declared scheme over the raw body before the body is read (a
// failure is 401 and records nothing); a body that does not decode is 400 and a refused delivery; deliveries are
// deduplicated by the provider's delivery id (or the body digest); Slack and Meta challenges are answered without a run;
// a valid delivery is acknowledged only after its run row is committed.
import { Option, Schema } from 'effect';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Json } from '../../decl/values.ts';

export type WebhookRequest = {
	method: string;
	headers: { readonly [lowercase: string]: string | undefined };
	query?: { readonly [name: string]: string | undefined };
	body: Uint8Array;
};
export type WebhookResponse = { status: number; body?: string };
const TOLERANCE_S = 300;

const same = (a: string, b: string): boolean => {
	const x = Buffer.from(a),
		y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (key: string | Buffer, text: Buffer, encoding: 'hex' | 'base64') =>
	createHmac('sha256', key).update(text).digest(encoding);
const fresh = (ts: string | undefined, now: number) =>
	ts !== undefined && /^\d+$/.test(ts) && Math.abs(now / 1000 - Number(ts)) <= TOLERANCE_S;
const cat = (...parts: (string | Buffer)[]) =>
	Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));

/** Whether `request` carries a valid signature under `scheme` with `secret`. */
export function verifySignature(
	scheme: string,
	secret: string,
	r: WebhookRequest,
	now: number
): boolean {
	const h = r.headers,
		body = Buffer.from(r.body);
	switch (scheme) {
		case 'bearer':
			return same(h['authorization'] ?? '', `Bearer ${secret}`);
		case 'hmac-sha256':
			return same((h['x-signature'] ?? '').replace(/^sha256=/, ''), hmac(secret, body, 'hex'));
		case 'meta':
			return same(h['x-hub-signature-256'] ?? '', `sha256=${hmac(secret, body, 'hex')}`);
		case 'slack': {
			const ts = h['x-slack-request-timestamp'];
			return (
				fresh(ts, now) &&
				same(h['x-slack-signature'] ?? '', `v0=${hmac(secret, cat(`v0:${ts}:`, body), 'hex')}`)
			);
		}
		case 'stripe': {
			const parts = (h['stripe-signature'] ?? '')
				.split(',')
				.map((p) => p.split('=') as [string, string]);
			const t = parts.find(([k]) => k === 't')?.[1];
			const want = hmac(secret, cat(`${t}.`, body), 'hex');
			return fresh(t, now) && parts.some(([k, v]) => k === 'v1' && same(v ?? '', want));
		}
		case 'svix': {
			const id = h['svix-id'],
				ts = h['svix-timestamp'];
			const want = hmac(
				Buffer.from(secret.replace(/^whsec_/, ''), 'base64'),
				cat(`${id}.${ts}.`, body),
				'base64'
			);
			return (
				id !== undefined &&
				fresh(ts, now) &&
				(h['svix-signature'] ?? '')
					.split(' ')
					.some((s) => s.startsWith('v1,') && same(s.slice(3), want))
			);
		}
	}
	return false;
}

/**
 * One delivery under `scheme` with `secret`, before anything is recorded: Meta's subscription check and Slack's URL
 * verification are answered, a bad signature is 401; else its body (an object, `undefined` when it does not decode) and
 * its delivery id (the provider's, else the body digest). Automation webhooks and custom conversations share it.
 */
export function verifiedWebhook(
	scheme: string,
	secret: string,
	r: WebhookRequest,
	now: number
):
	| { answer: WebhookResponse }
	| { body: { readonly [k: string]: Json } | undefined; delivery: string } {
	// Meta's subscription check is a signed-less GET answered with its challenge
	if (scheme === 'meta' && r.method === 'GET' && r.query?.['hub.mode'] === 'subscribe')
		return {
			answer: same(r.query['hub.verify_token'] ?? '', secret)
				? { status: 200, body: r.query['hub.challenge'] ?? '' }
				: { status: 401 }
		};
	if (!verifySignature(scheme, secret, r, now)) return { answer: { status: 401 } };

	const decoded = Schema.decodeUnknownOption(
		Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
	)(Buffer.from(r.body).toString('utf8'));
	const obj = Option.getOrUndefined(decoded);
	if (scheme === 'slack' && obj?.['type'] === 'url_verification')
		return { answer: { status: 200, body: String(obj['challenge'] ?? '') } };

	const delivery =
		(scheme === 'svix'
			? r.headers['svix-id']
			: scheme === 'stripe'
				? obj?.['id']
				: scheme === 'slack'
					? obj?.['event_id']
					: undefined) ?? createHash('sha256').update(r.body).digest('hex');
	return { body: obj, delivery: String(delivery) };
}
