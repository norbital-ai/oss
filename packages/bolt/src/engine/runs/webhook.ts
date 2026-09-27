/// <reference types="node" />
// Webhooks (rule 56a): the signature is verified by the declared scheme over the raw body before the body is read (a
// failure is 401 and records nothing); a body that does not decode is 400 and a refused delivery; deliveries are
// deduplicated by the provider's delivery id (or the body digest); Slack and Meta challenges are answered without a run;
// a valid delivery is acknowledged only after its run row is committed.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest, TenantDb } from '../contracts.ts';
import { answer, Chain, GATED } from '../write/sql.ts';
import { iso, triggersOf } from './queue.ts';

export type WebhookRequest = { method: string; headers: { readonly [lowercase: string]: string | undefined };
	query?: { readonly [name: string]: string | undefined }; body: Uint8Array };
export type WebhookResponse = { status: number; body?: string };
const TOLERANCE_S = 300;

const same = (a: string, b: string): boolean => {
	const x = Buffer.from(a), y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};
const hmac = (key: string | Buffer, text: Buffer, encoding: 'hex' | 'base64') => createHmac('sha256', key).update(text).digest(encoding);
const fresh = (ts: string | undefined, now: number) => ts !== undefined && /^\d+$/.test(ts) && Math.abs(now / 1000 - Number(ts)) <= TOLERANCE_S;
const cat = (...parts: (string | Buffer)[]) => Buffer.concat(parts.map((p) => typeof p === 'string' ? Buffer.from(p) : p));

/** Whether `request` carries a valid signature under `scheme` with `secret`. */
export function verifySignature(scheme: string, secret: string, r: WebhookRequest, now: number): boolean {
	const h = r.headers, body = Buffer.from(r.body);
	switch (scheme) {
		case 'bearer': return same(h['authorization'] ?? '', `Bearer ${secret}`);
		case 'hmac-sha256': return same((h['x-signature'] ?? '').replace(/^sha256=/, ''), hmac(secret, body, 'hex'));
		case 'meta': return same(h['x-hub-signature-256'] ?? '', `sha256=${hmac(secret, body, 'hex')}`);
		case 'slack': {
			const ts = h['x-slack-request-timestamp'];
			return fresh(ts, now) && same(h['x-slack-signature'] ?? '', `v0=${hmac(secret, cat(`v0:${ts}:`, body), 'hex')}`);
		}
		case 'stripe': {
			const parts = (h['stripe-signature'] ?? '').split(',').map((p) => p.split('=') as [string, string]);
			const t = parts.find(([k]) => k === 't')?.[1];
			const want = hmac(secret, cat(`${t}.`, body), 'hex');
			return fresh(t, now) && parts.some(([k, v]) => k === 'v1' && same(v ?? '', want));
		}
		case 'svix': {
			const id = h['svix-id'], ts = h['svix-timestamp'];
			const want = hmac(Buffer.from(secret.replace(/^whsec_/, ''), 'base64'), cat(`${id}.${ts}.`, body), 'base64');
			return id !== undefined && fresh(ts, now) && (h['svix-signature'] ?? '').split(' ').some((s) => s.startsWith('v1,') && same(s.slice(3), want));
		}
	}
	return false;
}

export type WebhookContext = { manifest: EngineManifest; db: TenantDb; env: (name: string) => string | undefined; now: () => number;
	/** The committed run's due time, for the deadlines port. */
	queued: (due: string) => void };

export async function deliverWebhook(x: WebhookContext, path: string, r: WebhookRequest): Promise<WebhookResponse> {
	const t = triggersOf(x.manifest).webhooks.find((w) => w.path === path);
	if (t === undefined) return { status: 404 };
	const secret = x.env(t.secret);
	if (secret === undefined || secret === '') return { status: 401 };
	const now = x.now();
	// Meta's subscription check is a signed-less GET answered with its challenge
	if (t.scheme === 'meta' && r.method === 'GET' && r.query?.['hub.mode'] === 'subscribe')
		return same(r.query['hub.verify_token'] ?? '', secret) ? { status: 200, body: r.query['hub.challenge'] ?? '' } : { status: 401 };
	if (!verifySignature(t.scheme, secret, r, now)) return { status: 401 };

	let body: Json | undefined;
	try {
		body = JSON.parse(Buffer.from(r.body).toString('utf8')) as Json;
	} catch {
		body = undefined;
	}
	const obj = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as { readonly [k: string]: Json } : undefined;
	if (t.scheme === 'slack' && obj?.['type'] === 'url_verification') return { status: 200, body: String(obj['challenge'] ?? '') };

	const delivery = (t.scheme === 'svix' ? r.headers['svix-id'] : t.scheme === 'stripe' ? obj?.['id'] : t.scheme === 'slack' ? obj?.['event_id'] : undefined)
		?? createHash('sha256').update(r.body).digest('hex');
	const key = `webhook:${t.automation}:${String(delivery)}`;
	const due = iso(now);
	// ponytail: decode is "a JSON object"; the automation's declared `input` decoder lands with rule 23's input decoding
	const refused = obj === undefined;
	const c = new Chain(), id = crypto.randomUUID();
	c.cte('idem', `INSERT INTO bolt_idem (key, digest, issued_at, run) VALUES (${c.p(key)}, '', ${c.p(due)}::timestamptz, ${c.p(id)}) ON CONFLICT (key) DO NOTHING RETURNING key`);
	c.cte('q', `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, error, finished_at)
	SELECT ${c.p(id)}, ${c.p(t.automation)}, ${c.p(refused ? {} : obj)}::jsonb, ${c.p(due)}::timestamptz, 'webhook', 0,
		${refused ? `'failed', '{"code":"invalidInput","message":"The body did not decode."}'::jsonb, ${c.p(due)}::timestamptz` : `'queued', NULL, NULL`}
	WHERE ${GATED} RETURNING id`);
	await x.db.write(c.sql(answer(c, key, '', `'null'::jsonb`)));
	if (refused) return { status: 400 };
	x.queued(due);
	return { status: 200 };
}
