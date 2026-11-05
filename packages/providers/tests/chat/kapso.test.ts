// Kapso: deliveries signed as its webhooks are, and its WhatsApp proxy faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { kapso } from '../../src/chat/kapso/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { apiKey: 'key', phoneNumberId: '1001', webhookSecret: 'hook' },
	API = 'https://api.kapso.ai/meta/whatsapp/v23.0',
	person = '15551234567';
const answer = (call: Call) => {
	if (call.url.includes('/1001/conversations')) return json({ data: [], paging: { cursors: {} } });
	if (call.url.endsWith('/1001/messages'))
		return json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out' }] });
	if (call.url.includes('/media1?')) return json({ url: 'https://files.kapso.ai/media1' });
	if (call.url.includes('/media2?'))
		return json({ url: 'https://lookaside.test/old', download_url: 'https://cdn.test/media2' });
	if (call.url.includes('/media')) return new Response(new Uint8Array([1, 2, 3]));
	return json({});
};
const message = (extra: object = {}) => ({
	id: 'wamid.1',
	type: 'text',
	timestamp: '1790000000',
	from: person,
	text: { body: 'Hello' },
	kapso: { direction: 'inbound', contact_name: 'Ann' },
	...extra
});
const event = (extra: object = {}, conversation: object = {}) => ({
	message: message(extra),
	conversation: { id: 'c1', phone_number: `+${person}`, phone_number_id: '1001', ...conversation },
	phone_number_id: '1001'
});
const sign = (body: string, secret = settings.webhookSecret) => ({
	'x-webhook-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
	'x-webhook-event': 'whatsapp.message.received'
});

describe('Kapso', () => {
	it.live('is a WhatsApp provider', () =>
		Effect.sync(() => expect(chatProvider(kapso).driver).toBe('whatsapp'))
	);
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(kapso, settings),
				body = JSON.stringify(event({ context: { id: 'wamid.0' } }));
			expect(h.status).toMatchObject({ state: 'connected', account: '1001' });
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'wamid.1',
						thread: person,
						sentAt: new Date(1_790_000_000_000).toISOString(),
						text: 'Hello',
						from: { handle: person, name: 'Ann' },
						replyTo: 'wamid.0',
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(kapso, settings),
				body = JSON.stringify(event());
			expect((yield* h.link.webhook!(webhook(body, sign(body, 'forged')))).status).toBe(401);
			expect((yield* h.link.webhook!(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(kapso, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = JSON.stringify(event());
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(500);
		})
	);
	it.live('a batch stores each message, and a missing sender comes from the conversation', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(kapso, settings);
			const body = JSON.stringify({
				data: [
					event({ id: 'wamid.2' }),
					event({ id: 'wamid.3', from: undefined, kapso: {} }, { kapso: { contactName: 'Bo' } })
				]
			});
			yield* h.link.webhook!(webhook(body, sign(body)));
			expect(h.events).toHaveLength(2);
			expect(h.events[1]).toMatchObject({
				messages: [{ id: 'wamid.3', thread: person, from: { handle: person, name: 'Bo' } }]
			});
		})
	);
	it.live('stores neither its own, a reaction, another number, nor another event', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(kapso, settings);
			for (const body of [
				JSON.stringify(event({ kapso: { direction: 'outbound' } })),
				JSON.stringify(event({ type: 'reaction' })),
				JSON.stringify({ ...event(), phone_number_id: '2002' })
			])
				expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			const sent = JSON.stringify(event());
			yield* h.link.webhook!(
				webhook(sent, { ...sign(sent), 'x-webhook-event': 'whatsapp.message.sent' })
			);
			expect(h.events).toEqual([]);
		})
	);
	it.live('reads a caption, a location and a button as its text', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(kapso, settings);
			for (const extra of [
				{ text: undefined, video: { caption: 'Clip' } },
				{ text: undefined, location: { name: 'Depot', address: '1 Road' } },
				{ text: undefined, interactive: { button_reply: { title: 'Yes' } } }
			]) {
				const body = JSON.stringify(event(extra));
				yield* h.link.webhook!(webhook(body, sign(body)));
			}
			expect(h.events).toMatchObject([
				{ messages: [{ text: 'Clip' }] },
				{ messages: [{ text: 'Depot\n1 Road' }] },
				{ messages: [{ text: 'Yes' }] }
			]);
		})
	);
	it.live('fetches a file by its id, sending the key only to Kapso', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(kapso, settings);
			const hosted = JSON.stringify(
				event({
					type: 'document',
					text: undefined,
					document: {
						id: 'media1',
						filename: 'a.pdf',
						mime_type: 'application/pdf',
						caption: 'Bill'
					},
					kapso: { media_data: { byte_size: 3 } }
				})
			);
			const linked = JSON.stringify(
				event({ id: 'wamid.2', type: 'image', text: undefined, image: { id: 'media2' } })
			);
			yield* h.link.webhook!(webhook(hosted, sign(hosted)));
			yield* h.link.webhook!(webhook(linked, sign(linked)));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [
					{
						text: 'Bill',
						attachments: [{ name: 'a.pdf', mime: 'application/pdf', bytes: 3, bin: 0 }]
					}
				]
			});
			expect(h.events[1]).toMatchObject({
				messages: [{ attachments: [{ name: 'image-media2', bytes: 3 }] }]
			});
			const key = (url: string) =>
				api.calls.find((call) => call.url === url)?.headers.get('x-api-key');
			expect(key(`${API}/media1?phone_number_id=1001`)).toBe('key');
			expect(key('https://files.kapso.ai/media1')).toBe('key');
			expect(key('https://cdn.test/media2')).toBeNull();
		})
	);
	it.live('sends through the proxy, and claims no dedupe', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(kapso, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: person, text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'wamid.out' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe(`${API}/1001/messages`);
			expect(call?.headers.get('x-api-key')).toBe('key');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				messaging_product: 'whatsapp',
				recipient_type: 'individual',
				to: person,
				type: 'text',
				text: { body: 'Hello' }
			});
			const connection = yield* Effect.promise(() =>
				kapso.connect(settings, {
					fetch,
					webhookUrl: 'https://hook.test/',
					receive: () => Promise.resolve()
				})
			);
			const answered = yield* Effect.promise(() => connection.send(person, 'Hello', 'r1', []));
			expect(answered).toEqual({ id: 'wamid.out' });
		})
	);
	it.live('a refused send fails for good, a rate limit retries when it says', () =>
		Effect.gen(function* () {
			let status = 400;
			yield* platformApi((call) =>
				call.url.endsWith('/1001/messages')
					? new Response('{"error":{}}', { status, headers: { 'retry-after': '3' } })
					: answer(call)
			);
			const h = yield* connected(kapso, settings);
			const refused = yield* Effect.flip(h.link.send!({ to: person, text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			status = 429;
			const later = yield* Effect.flip(h.link.send!({ to: person, text: 'Hello' }, []));
			expect(later).toMatchObject({ _tag: 'ProviderUnavailable', retryAfterMs: 3000 });
		})
	);
	it.live('reads a number back since a time, keeping the thread and paging to the end', () =>
		Effect.gen(function* () {
			const full = Array.from({ length: 100 }, (_, index) =>
				message({ id: `a${index}`, from: index === 0 ? person : '15550000000' })
			);
			const api = yield* platformApi((call) => {
				if (!call.url.includes('/1001/messages?')) return answer(call);
				return call.url.includes('after=next')
					? json({ data: [message({ id: 'b0' })], paging: { cursors: { after: 'last' } } })
					: json({ data: full, paging: { cursors: { after: 'next' } } });
			});
			const connection = yield* Effect.promise(() =>
				kapso.connect(settings, {
					fetch,
					webhookUrl: 'https://hook.test/',
					receive: () => Promise.resolve()
				})
			);
			const read = yield* Effect.promise(async () =>
				connection.history?.(person, '2026-01-01T00:00:00.000Z')
			);
			expect(read?.complete).toBe(true);
			expect(read?.messages.map((one) => one.id)).toEqual(['a0', 'b0']);
			expect(Object.fromEntries(new URL(api.calls.at(-1)?.url ?? '').searchParams)).toEqual({
				direction: 'inbound',
				since: '2026-01-01T00:00:00.000Z',
				limit: '100',
				fields: 'kapso(direction,media_data,contact_name)',
				after: 'next'
			});
		})
	);
	it.live('a window larger than the pages it reads is not whole', () =>
		Effect.gen(function* () {
			const full = Array.from({ length: 100 }, (_, index) => message({ id: `a${index}` }));
			yield* platformApi((call) =>
				call.url.includes('/1001/messages?')
					? json({ data: full, paging: { cursors: { after: 'more' } } })
					: answer(call)
			);
			const connection = yield* Effect.promise(() =>
				kapso.connect(settings, {
					fetch,
					webhookUrl: 'https://hook.test/',
					receive: () => Promise.resolve()
				})
			);
			const read = yield* Effect.promise(async () =>
				connection.history?.(person, '2026-01-01T00:00:00.000Z')
			);
			expect(read?.complete).toBe(false);
		})
	);
	it.live('a key Kapso refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'unauthorized' }, 401));
			const h = yield* host(chatProvider(kapso), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
