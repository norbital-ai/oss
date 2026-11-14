// Integration webhook signatures cover the raw body before decoding. Provider challenges answer directly;
// verified deliveries retain the provider id or body digest for the integration inbox's durable deduplication.
import { Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { fromBase64, hmacSha256, timingSafeEqual, toBase64 } from '../crypto.ts';
import { sha256, to_hex } from '@norbital-ai/store';

export type WebhookRequest = {
	method: string;
	headers: { readonly [lowercase: string]: string | undefined };
	query?: { readonly [name: string]: string | undefined };
	body: Uint8Array;
};
type WebhookResponse = { status: number; body?: string };
const TOLERANCE_S = 300;

const utf8 = new TextEncoder();
const same = (a: string, b: string): boolean => timingSafeEqual(utf8.encode(a), utf8.encode(b));
const hmac = (key: string | Uint8Array, text: Uint8Array, encoding: 'hex' | 'base64') =>
	(encoding === 'hex' ? to_hex : toBase64)(hmacSha256(key, text));
const fresh = (ts: string | undefined, now: number) =>
	ts !== undefined && /^\d+$/.test(ts) && Math.abs(now / 1000 - Number(ts)) <= TOLERANCE_S;
const cat = (prefix: string, body: Uint8Array) => {
	const head = utf8.encode(prefix),
		out = new Uint8Array(head.length + body.length);
	out.set(head);
	out.set(body, head.length);
	return out;
};

/** The most of a delivery's body buffered before its signature is checked; past it, nothing more is read. */
export const WEBHOOK_BYTES = 4 * 1024 * 1024;
/** The body, read up to `max` bytes; `null` once it is longer (by its declared length or as it streams). */
export async function cappedBody(request: Request, max = WEBHOOK_BYTES): Promise<Uint8Array | null> {
	if (Number(request.headers.get('content-length') ?? 0) > max) return null;
	const reader = request.body?.getReader();
	if (reader === undefined) return new Uint8Array();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		parts.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}
/** Schemes whose signature covers no timestamp: a captured delivery verifies again, so a repeat is refused by its id. */
export const UNSTAMPED: readonly string[] = ['bearer', 'hmac-sha256', 'meta'];
/**
 * Deliveries answered within the tolerance window, by `<instance>:<delivery id>`: a repeat inside it is a replay.
 * ponytail: memory per activation; a replay after the window or on another activation reaches the handler, whose
 * keyed acts answer from their commit.
 */
export class Replays {
	private readonly seen = new Map<string, number>();
	/** Whether `key` was answered within the window; forgets what aged out (insertion order is age order). */
	has(key: string, now: number): boolean {
		for (const [k, at] of this.seen) {
			if (now - at < TOLERANCE_S * 1000) break;
			this.seen.delete(k);
		}
		return this.seen.has(key);
	}
	add(key: string, now: number) {
		this.seen.delete(key);
		this.seen.set(key, now);
	}
}

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
				.map((p) => p.split('='));
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
 * its delivery id (the provider's, else the body digest). Integration sync hints use this verified delivery.
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
					: undefined) ?? to_hex(sha256(r.body));
	return { body: obj, delivery: String(delivery) };
}
