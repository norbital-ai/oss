// Resend: its real SDK, deliveries signed the way Svix signs them, and its API faked behind `fetch`.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { resend } from '../../src/chat/resend/index.ts';
import { hmac } from '../../src/chat/verify.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const key = Buffer.from('a webhook signing key').toString('base64');
const settings = { apiKey: 're_key', webhookSecret: `whsec_${key}`, inbox: 'desk@acme.test' };
const email = (extra: object = {}) => ({
	id: 'e1',
	direction: 'inbound',
	from: 'Ada Lovelace <Ada@example.com>',
	to: ['desk@acme.test'],
	cc: [],
	bcc: [],
	reply_to: [],
	subject: 'Invoice',
	message_id: '<e1@example.com>',
	html: null,
	text: 'Hello',
	attachments: [],
	read: false,
	received_at: '2026-11-05 10:00:00.123456+00',
	...extra
});
const thread = '/inboxes/in1/threads/t1/emails';
const answer =
	(emails: readonly object[] = [email()]) =>
	(call: Call) => {
		const { pathname } = new URL(call.url);
		if (pathname.endsWith('/reply')) return json({ id: 'out1', object: 'email' });
		if (pathname === '/emails') return json({ id: 'out2' });
		if (pathname === thread) return json({ object: 'list', has_more: false, data: emails });
		if (pathname === `${thread}/e1`) return json(emails[0]);
		return json({
			object: 'inbox',
			id: 'in1',
			name: 'Desk',
			email_address: 'desk@acme.test',
			from_name: null
		});
	};
const event = (extra: object = {}) =>
	JSON.stringify({
		type: 'inbox.email.received',
		created_at: '2026-11-05T10:00:00.000Z',
		data: { source: 'api', inbox_id: 'in1', thread_id: 't1', email_id: 'e1', ...extra }
	});
/** Svix's scheme: an HMAC of `id.timestamp.body`, keyed by the secret's base64 bytes. */
const signature = (body: string) => {
	const id = 'msg_1',
		timestamp = String(Math.floor(Date.now() / 1000));
	return {
		'svix-id': id,
		'svix-timestamp': timestamp,
		'svix-signature': `v1,${hmac(Buffer.from(key, 'base64'), `${id}.${timestamp}.${body}`, 'base64')}`
	};
};
const open = Effect.promise(() =>
	resend.connect(settings, {
		fetch,
		webhook_url: 'https://hook.test/',
		receive: () => Promise.resolve()
	})
);

describe('Resend', () => {
	it.live('stores a signed email before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(resend, settings),
				body = event();
			expect(h.status).toMatchObject({ state: 'connected', account: 'desk@acme.test' });
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toMatchObject([
				{
					kind: 'messages',
					messages: [
						{
							id: 'e1',
							thread: 't1',
							sent_at: '2026-11-05T10:00:00.123Z',
							from: { handle: 'ada@example.com', name: 'Ada Lovelace' },
							text: 'Hello',
							group: false,
							invocation: 'direct',
							title: 'Invoice'
						}
					]
				}
			]);
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(resend, settings),
				body = event();
			const refused = yield* required(h.link.webhook)(
				webhook(body, { ...signature(body), 'svix-signature': 'v1,forged' })
			);
			expect(refused.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(resend, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = event();
			expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('ignores other inboxes, other events and its own mail', () =>
		Effect.gen(function* () {
			yield* platformApi(answer([email({ from: 'Desk <desk@acme.test>' })]));
			const h = yield* connected(resend, settings);
			for (const body of [
				event({ inbox_id: 'in2' }),
				JSON.stringify({ type: 'email.sent', created_at: 'x', data: {} }),
				event()
			])
				expect((yield* required(h.link.webhook)(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('reads a group, its mention, an HTML body and a file by its name', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answer([
					email({
						to: ['bob@example.com'],
						cc: ['Desk <desk@acme.test>'],
						text: null,
						html: '<p>Hi <b>all</b></p>',
						attachments: [{ id: 'a1', filename: 'a.pdf', size: 3 }]
					})
				])
			);
			const h = yield* connected(resend, settings),
				body = event();
			yield* required(h.link.webhook)(webhook(body, signature(body)));
			expect(h.events).toMatchObject([
				{
					messages: [
						{
							text: 'Hi all',
							group: true,
							invocation: 'ambient',
							attachments: [{ name: 'a.pdf', mime: 'application/octet-stream', bytes: 3 }]
						}
					]
				}
			]);
		})
	);
	it.live('replies to the last inbound email, with its idempotency key', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(
				answer([email(), email({ id: 'e0', direction: 'outbound', from: 'desk@acme.test' })])
			);
			const h = yield* connected(resend, settings);
			const sent = yield* required(h.link.send)({ id: 'r1', to: 't1', text: 'Paid' }, [
				{
					id: 'f1',
					name: 'a.txt',
					mime: 'text/plain',
					bytes: new TextEncoder().encode('receipt'),
					url: () => Promise.reject(new Error('no link'))
				}
			]);
			expect(sent).toMatchObject({ provider_id: 'out1' });
			const call = api.calls.at(-1);
			expect(new URL(call?.url ?? '').pathname).toBe(`${thread}/e1/reply`);
			expect(call?.headers.get('idempotency-key')).toBe('r1');
			expect(JSON.parse(call?.body ?? '')).toMatchObject({
				text: 'Paid',
				attachments: [
					{
						filename: 'a.txt',
						content_type: 'text/plain',
						content: Buffer.from('receipt').toString('base64')
					}
				]
			});
		})
	);
	it.live('an address starts a new email, with its idempotency key', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			const h = yield* connected(resend, settings);
			yield* required(h.link.send)({ id: 'r2', to: 'ada@example.com', text: 'Hello\nmore' }, []);
			const call = api.calls.at(-1);
			expect(new URL(call?.url ?? '').pathname).toBe('/emails');
			expect(call?.headers.get('idempotency-key')).toBe('r2');
			expect(JSON.parse(call?.body ?? '')).toMatchObject({
				from: 'desk@acme.test',
				to: 'ada@example.com',
				subject: 'Hello',
				text: 'Hello\nmore'
			});
		})
	);
	it.live('a thread with no email cannot be answered, and that is final', () =>
		Effect.gen(function* () {
			yield* platformApi(answer([]));
			const h = yield* connected(resend, settings);
			const refused = yield* Effect.flip(required(h.link.send)({ id: 'r3', to: 't1', text: 'Paid' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
		})
	);
	it.live('history is the whole window of a thread, without its own mail', () =>
		Effect.gen(function* () {
			const pages = [
				{
					object: 'list',
					has_more: true,
					data: [email({ id: 'old', received_at: '2026-11-01T00:00:00.000Z' })]
				},
				{
					object: 'list',
					has_more: false,
					data: [email(), email({ id: 'e2', direction: 'outbound', from: 'desk@acme.test' })]
				}
			];
			const api = yield* platformApi((call) =>
				new URL(call.url).pathname === thread
					? json(pages[new URL(call.url).searchParams.has('after') ? 1 : 0])
					: answer()(call)
			);
			const connection = yield* open;
			expect(resend.consistency).toBe('history');
			const read = yield* Effect.promise(
				async () => await connection.history?.('t1', '2026-11-05T00:00:00.000Z')
			);
			expect(read?.complete).toBe(true);
			expect(read?.messages.map((message) => message.id)).toEqual(['e1']);
			expect(new URL(api.calls.at(-1)?.url ?? '').searchParams.get('after')).toBe('old');
		})
	);
	it.live('a thread Resend no longer has is an empty window', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				new URL(call.url).pathname === thread
					? json({ statusCode: 404, name: 'not_found', message: 'Thread not found' }, 404)
					: answer()(call)
			);
			const connection = yield* open;
			const read = yield* Effect.promise(
				async () => await connection.history?.('t1', '2026-11-05T00:00:00.000Z')
			);
			expect(read).toEqual({ messages: [], complete: true });
		})
	);
	it.live('a key Resend refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() =>
				json({ statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' }, 401)
			);
			const h = yield* host(chatProvider(resend), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
