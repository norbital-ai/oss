// Web push for inbox notices (§5.7 `POST /__bolt/push`, rule 48 "notice pushes"): a browser's subscription is a
// `bolt_push_subscriptions` row; a statement that inserts notices also queues one `bolt.push` run (a trigger, so every
// writer of `sys_notification` is covered and a refused statement queues nothing), and that run sends each notice to
// the devices of the member each inbox row belongs to through the host's `push` transport. No subscription, no run; no port, no push.
import type { Json } from '../decl/values.ts';
import type { TenantDb, TransportPort } from '../engine/contracts.ts';
import { callPort, LIMITS } from '../engine/contracts.ts';

export const NOTICE_PUSH = 'bolt.push';

type Obj = { readonly [k: string]: Json };
const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stores or removes one device's subscription for the member. */
export async function subscribe(db: TenantDb, user: string, body: { endpoint: string; keys?: Json; remove?: boolean }): Promise<void> {
	await db.write(body.remove === true
		? { text: `DELETE FROM bolt_push_subscriptions WHERE "user" = $1 AND endpoint = $2`, params: [user, body.endpoint] }
		: { text: `WITH gone AS (DELETE FROM bolt_push_subscriptions WHERE endpoint = $3)
			INSERT INTO bolt_push_subscriptions (id, "user", endpoint, keys) VALUES ($1, $2, $3, $4::jsonb)`,
		params: [crypto.randomUUID(), user, body.endpoint, JSON.stringify(body.keys ?? {})] });
}

/**
 * The `bolt.push` platform run: `{ ids }` → each notice to every subscribed device of its member (the inbox row's
 * `member`, L-BOLT-354), while that member is active. The message is `{ subscription: { endpoint, keys }, title, body,
 * link, url }`; the host's adapter sends `{ title, body, url }` to the subscription, signed with its VAPID key, and the
 * shell's service worker (`/__bolt/sw.js`) shows it.
 */
export function noticePush(db: TenantDb, push: TransportPort | undefined): (input: Json) => Promise<Json> {
	return async (input): Promise<Json> => {
		const ids = isObj(input) && Array.isArray(input['ids']) ? input['ids'].map(String) : [];
		if (ids.length === 0 || push === undefined) return { sent: 0 };
		const [rows] = await db.read([{ text: `SELECT n.title, n.body, n.link, s.endpoint, s.keys FROM sys_notification n
			JOIN bolt_push_subscriptions s ON s."user" = n.member JOIN sys_user u ON u.id = n.member AND u.active
			WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY s."user"`, params: [JSON.stringify(ids)] }]);
		let sent = 0, failed = 0;
		for (const r of rows!.rows) {
			const x = await callPort('push', push, LIMITS.callMs.http, (p, signal) => p.send('inbox', { subscription: { endpoint: r['endpoint']!, keys: r['keys']! },
				title: r['title']!, body: r['body'] ?? null, link: r['link'] ?? null, url: '/inbox' }, signal));
			if ('kind' in x) failed++; else sent++;
		}
		return { sent, failed };
	};
}
