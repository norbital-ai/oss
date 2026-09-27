// The `push` transport (§5.7, rule 61): the engine's `bolt.push` run hands one message per device,
// `{ subscription, title, body, link, url }`; the host signs it with `BOLT_VAPID_*` and sends `{ title, body, url }`, which
// the shell's service worker shows. A gone subscription (404/410) is removed so it is not tried again.
import webpush from 'web-push';
import type { TenantDb, TransportPort } from '@norbital-ai/bolt/engine';

type Message = { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; title: string; body: string | null; url: string };

export function push(db: TenantDb, vapid: { publicKey: string; privateKey: string }, subject: string,
	send: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush)): TransportPort {
	const vapidDetails = { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey };
	return {
		async send(_channel, message) {
			const m = message as unknown as Message;
			try {
				const r = await send(m.subscription, JSON.stringify({ title: m.title, body: m.body, url: m.url }), { vapidDetails, TTL: 86_400 });
				return { providerId: r.headers['location'] ?? `push:${r.statusCode}` };
			} catch (e) {
				const status = (e as { statusCode?: number }).statusCode;
				if (status === 404 || status === 410) await db.write({ text: `DELETE FROM bolt_push_subscriptions WHERE endpoint = $1`, params: [m.subscription.endpoint] });
				throw e;
			}
		},
		subscribe: () => () => {},
	};
}
