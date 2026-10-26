// Webhooks (rule 56a): the signature is verified by the declared scheme over the raw body before the body is read (a
// failure is 401 and records nothing); a body that does not decode is 400 and a refused delivery; deliveries are
// deduplicated by the provider's delivery id (or the body digest); Slack and Meta challenges are answered without a run;
// a valid delivery is acknowledged only after its run row is committed.
import { Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { fromBase64, hmacSha256, timingSafeEqual, toBase64 } from '../crypto.ts';
import { sha256, toHex } from '@norbital-ai/store';

export type WebhookRequest = {
	method: string;
	headers: { readonly [lowercase: string]: string | undefined };
	query?: { readonly [name: string]: string | undefined };
	body: Uint8Array;
};
export type WebhookResponse = { status: number; body?: string };
const TOLERANCE_S = 300;

const utf8 = new TextEncoder();
const same = (a: string, b: string): boolean => timingSafeEqual(utf8.encode(a), utf8.encode(b));
const hmac = (key: string | Uint8Array, text: Uint8Array, encoding: 'hex' | 'base64') =>
	(encoding === 'hex' ? toHex : toBase64)(hmacSha256(key, text));
const fresh = (ts: string | undefined, now: number) =>
	ts !== undefined && /^\d+$/.test(ts) && Math.abs(now / 1000 - Number(ts)) <= TOLERANCE_S;
const cat = (prefix: string, body: Uint8Array) => {
	const head = utf8.encode(prefix),
		out = new Uint8Array(head.length + body.length);
	out.set(head);
	out.set(body, head.length);
	return out;
};

/** Whether `request` carries a valid signature under `scheme` with `secret`. */
export function verifySignature(
	scheme: string,
	secret: string,
	r: WebhookRequest,
	now: number
): boolean {
	const h = r.headers,
		body = r.body;
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
		// Standard Webhooks: `webhook-*` headers, or Svix's `svix-*` (the same scheme under its first name)
		case 'standard': {
			const id = h['webhook-id'] ?? h['svix-id'],
				ts = h['webhook-timestamp'] ?? h['svix-timestamp'];
			const want = hmac(
				fromBase64(secret.replace(/^whsec_/, '')),
				cat(`${id}.${ts}.`, body),
				'base64'
			);
			return (
				id !== undefined &&
				fresh(ts, now) &&
				(h['webhook-signature'] ?? h['svix-signature'] ?? '')
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
 * its delivery id (the provider's, else the body digest). Automation webhooks and sync hints share it.
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
	)(new TextDecoder().decode(r.body));
	const obj = Option.getOrUndefined(decoded);
	if (scheme === 'slack' && obj?.['type'] === 'url_verification')
		return { answer: { status: 200, body: String(obj['challenge'] ?? '') } };

	const delivery =
		(scheme === 'standard'
			? (r.headers['webhook-id'] ?? r.headers['svix-id'])
			: scheme === 'stripe'
				? obj?.['id']
				: scheme === 'slack'
					? obj?.['event_id']
					: undefined) ?? toHex(sha256(r.body));
	return { body: obj, delivery: String(delivery) };
}
