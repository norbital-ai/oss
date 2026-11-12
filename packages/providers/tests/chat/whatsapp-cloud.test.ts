// WhatsApp Business Cloud: deliveries signed as Meta signs them, through the real provider, its API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { whatsappCloud } from '../../src/chat/whatsapp-cloud/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = {
	accessToken: 'token',
	appSecret: 'secret',
	verifyToken: 'verify',
	phoneNumberId: '100'
};
const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';
const answer = (call: Call) =>
	call.url.endsWith('/100/whatsapp_business_profile')
		? json({ data: [{ about: 'Acme' }] })
		: call.url.endsWith('/100/messages')
			? json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out1' }] })
			: call.url.endsWith('/media1')
				? json({ url: LOOKASIDE, mime_type: 'application/pdf', file_size: 3 })
				: call.url.endsWith('/media2')
					? json({ url: 'https://evil.example/file', mime_type: 'application/pdf' })
					: call.url === LOOKASIDE
						? new Response(new Uint8Array([1, 2, 3]))
						: json({});
const hook = (message: object, phone = '100') =>
	JSON.stringify({
		object: 'whatsapp_business_account',
		entry: [
			{
				id: 'W1',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { display_phone_number: '6591234567', phone_number_id: phone },
							contacts: [{ wa_id: '6580000000', profile: { name: 'Mei' } }],
							messages: [
								{ from: '6580000000', id: 'wamid.1', timestamp: '1790000000', ...message }
							]
						}
					}
				]
			}
		]
	});
const signature = (body: string) => ({
	'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
});
const text = { type: 'text', text: { body: 'hello' } };

describe('WhatsApp Business Cloud', () => {
	it('is a provider of the whatsapp driver', () =>
		expect(chatProvider(whatsappCloud).driver).toBe('whatsapp'));
	it.live('stores a signed message with its reply and sender', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings),
				body = hook({ ...text, context: { from: '100', id: 'wamid.0' } });
			expect(h.status).toMatchObject({ state: 'connected', account: '100' });
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([
				{
					kind: 'messages',
					messages: [
						{
							id: 'wamid.1',
							thread: '6580000000',
							sent_at: '2026-09-21T14:13:20.000Z',
							from: { handle: '6580000000', name: 'Mei' },
							text: 'hello',
							group: false,
							reply_to: 'wamid.0',
							attachments: [],
							invocation: 'direct'
						}
					]
				}
			]);
		})
	);
	it.live('answers Meta’s handshake only with the verify token', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings);
			const query = (token: string) =>
				new Request(
					`https://hook.test/?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`
				);
			const good = yield* required(h.link.webhook)(query('verify'));
			expect(yield* Effect.promise(() => good.text())).toBe('42');
			expect((yield* required(h.link.webhook)(query('wrong'))).status).toBe(401);
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings),
				body = hook(text);
			const forged = yield* required(h.link.webhook)(
				webhook(body, { 'x-hub-signature-256': 'sha256=forged' })
			);
			expect(forged.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = hook(text);
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('leaves another number’s message, a status and a reaction alone', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings);
			for (const body of [
				hook(text, '200'),
				hook({ type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.0' } }),
				JSON.stringify({
					entry: [
						{
							changes: [
								{
									field: 'messages',
									value: {
										metadata: { phone_number_id: '100' },
										statuses: [{ id: 'wamid.out1', status: 'read' }]
									}
								}
							]
						}
					]
				})
			])
				expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('fetches media in two steps, sending its token only to Meta’s hosts', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings);
			const document = (id: string) => ({
				type: 'document',
				document: { id, mime_type: 'application/pdf', filename: 'a.pdf', caption: 'see', sha256: 'x' }
			});
			const good = hook(document('media1')),
				bad = hook({ id: 'wamid.2', ...document('media2') });
			yield* required(h.link.webhook)(webhook(good, signature(good)));
			yield* required(h.link.webhook)(webhook(bad, signature(bad)));
			expect(h.events[0]).toMatchObject({
				messages: [
					{
						text: 'see',
						attachments: [{ name: 'a.pdf', mime: 'application/pdf', bytes: 3, bin: 0 }]
					}
				],
				bins: [new Uint8Array([1, 2, 3])]
			});
			const download = api.calls.find((call) => call.url === LOOKASIDE);
			expect(download?.headers.get('authorization')).toBe('Bearer token');
			expect(h.events[1]).toMatchObject({
				messages: [{ attachments: [{ name: 'a.pdf', mime: 'application/pdf', bytes: 0 }] }]
			});
			expect(api.calls.some((call) => call.url.startsWith('https://evil.example'))).toBe(false);
		})
	);
	it.live('sends through the phone number, by a scoped id when that is all it has', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(whatsappCloud, settings);
			expect(yield* required(h.link.send)({ to: '6580000000', text: 'Hello' }, [])).toMatchObject({
				provider_id: 'wamid.out1'
			});
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://graph.facebook.com/v25.0/100/messages');
			expect(call?.headers.get('authorization')).toBe('Bearer token');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				messaging_product: 'whatsapp',
				recipient_type: 'individual',
				to: '6580000000',
				type: 'text',
				text: { preview_url: false, body: 'Hello' }
			});
			yield* required(h.link.send)({ to: 'SG.ENT.abc123', text: 'Hello' }, []);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toMatchObject({
				recipient: 'SG.ENT.abc123'
			});
			const before = api.calls.length;
			yield* required(h.link.send)({ to: '6580000000', text: 'a'.repeat(4097) }, []);
			expect(
				api.calls.slice(before).map((one) => JSON.parse(one.body).text.body.length)
			).toEqual([4096, 1]);
		})
	);
	it.live('a token Meta refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: { message: 'Invalid token', code: 190 } }, 401));
			const h = yield* host(chatProvider(whatsappCloud), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
