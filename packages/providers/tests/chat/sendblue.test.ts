// Sendblue: its real SDK, the shared secret it sends as a header, and its API faked behind `fetch`.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { sendblue } from '../../src/chat/sendblue/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const line = '+16292925296',
	contact = '+15551234567',
	settings = { apiKey: 'key', apiSecret: 'secret', fromNumber: line, webhookSecret: 'hook' };
const answer = (call: Call) => {
	if (call.url.endsWith('/api/v2/lines/state'))
		return json({ data: [], snapshot_at: '2026-01-01T00:00:00Z', status: 'OK' });
	if (call.url.endsWith('/api/send-message'))
		return json({ message_handle: 'out1', status: 'QUEUED' });
	if (call.url.endsWith('/api/send-group-message'))
		return json({ message_handle: 'out2', status: 'QUEUED' });
	if (call.url.endsWith('/api/v2/messages/m0')) return json({ data: { is_outbound: true } });
	if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([1, 2, 3]));
	return json({});
};
const text = (extra: object = {}) =>
	JSON.stringify({
		content: 'Hello',
		is_outbound: false,
		status: 'RECEIVED',
		message_handle: 'm1',
		date_sent: '2026-01-02T03:04:05.000Z',
		from_number: contact,
		number: contact,
		to_number: line,
		sendblue_number: line,
		media_url: '',
		message_type: 'message',
		group_id: '',
		participants: [],
		service: 'iMessage',
		group_display_name: null,
		...extra
	});
const signature = { 'sb-signing-secret': 'hook' };
const direct = () =>
	Effect.promise(() =>
		sendblue.connect(settings, {
			fetch,
			webhookUrl: 'https://hook.test/',
			receive: () => Promise.resolve()
		})
	);

describe('Sendblue', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: line });
			expect((yield* h.link.webhook!(webhook(text(), signature))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'm1',
						thread: contact,
						sentAt: '2026-01-02T03:04:05.000Z',
						text: 'Hello',
						from: { handle: contact, name: null },
						replyTo: null,
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('refuses a wrong secret and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			const refused = yield* h.link.webhook!(webhook(text(), { 'sb-signing-secret': 'forged' }));
			expect(refused.status).toBe(401);
			expect((yield* h.link.webhook!(webhook(text(), {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(sendblue, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* h.link.webhook!(webhook(text(), signature))).status).toBe(500);
		})
	);
	it.live('stores neither its own sends, reactions, typing, nor another line', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			for (const body of [
				text({ is_outbound: true, status: 'DELIVERED' }),
				text({ is_reaction: true }),
				text({ sendblue_number: '+16290000000' }),
				JSON.stringify({ number: contact, is_typing: true, from_number: line })
			])
				expect((yield* h.link.webhook!(webhook(body, signature))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a group reply to our message invokes, and its thread sends to the group', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			const body = text({
				group_id: 'g1',
				group_display_name: 'Crew',
				message_type: 'group',
				reply_to: { message_handle: 'm0' }
			});
			yield* h.link.webhook!(webhook(body, signature));
			expect(h.events[0]).toMatchObject({
				messages: [
					{ thread: 'group:g1', group: true, title: 'Crew', replyTo: 'm0', invocation: 'reply' }
				]
			});
			const sent = yield* h.link.send!({ id: 'r1', to: 'group:g1', text: 'Hi all' }, []);
			expect(sent).toMatchObject({ providerId: 'out2' });
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({
				from_number: line,
				group_id: 'g1',
				content: 'Hi all'
			});
		})
	);
	it.live('a group message nobody answers of ours stays ambient', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			yield* h.link.webhook!(webhook(text({ group_id: 'g1', message_type: 'group' }), signature));
			expect(h.events[0]).toMatchObject({ messages: [{ invocation: 'ambient' }] });
		})
	);
	it.live('fetches an inbound file, by its link or from a data URL', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			yield* h.link.webhook!(
				webhook(text({ media_url: 'https://cdn.test/a/photo.JPG?sig=1' }), signature)
			);
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [{ attachments: [{ name: 'photo.JPG', mime: 'image/jpeg', bytes: 3, bin: 0 }] }]
			});
			yield* h.link.webhook!(
				webhook(text({ message_handle: 'm2', media_url: 'data:image/png;base64,AQID' }), signature)
			);
			expect(h.events[1]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [{ attachments: [{ name: 'attachment', mime: 'image/png', bytes: 3, bin: 0 }] }]
			});
		})
	);
	it.live('sends from its line, and claims no dedupe it does not have', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(sendblue, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: contact, text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toMatch(/\/api\/send-message$/);
			expect(call?.headers.get('sb-api-key-id')).toBe('key');
			expect(call?.headers.get('sb-api-secret-key')).toBe('secret');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				from_number: line,
				number: contact,
				content: 'Hello'
			});
			const connection = yield* direct();
			const plain = yield* Effect.promise(() => connection.send(contact, 'Hello', 'r1', []));
			expect(plain).toEqual({ id: 'out1' });
		})
	);
	it.live('a refused send fails for good, an ERROR answer too, and the SDK retries nothing', () =>
		Effect.gen(function* () {
			let answerSend = () => json({ status: 'ERROR', error_message: 'no' }, 400),
				sends = 0;
			yield* platformApi((call) => {
				if (!call.url.endsWith('/api/send-message')) return answer(call);
				sends += 1;
				return answerSend();
			});
			const h = yield* connected(sendblue, settings);
			const refused = yield* Effect.flip(h.link.send!({ to: contact, text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			expect(sends).toBe(1);
			answerSend = () => json({ status: 'ERROR', error_message: 'declined' });
			const declined = yield* Effect.flip(h.link.send!({ to: contact, text: 'Hello' }, []));
			expect(declined).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			answerSend = () => json({}, 503);
			const down = yield* Effect.flip(h.link.send!({ to: contact, text: 'Hello' }, []));
			expect(down).toMatchObject({ _tag: 'ProviderUnavailable', status: 503 });
			expect(sends).toBe(3);
		})
	);
	it.live('shows typing to a person, never to a group', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const connection = yield* direct();
			yield* Effect.promise(async () => {
				await connection.typing?.(contact, false);
				await connection.typing?.('group:g1', true);
			});
			const typed = api.calls.filter((call) => call.url.endsWith('/api/send-typing-indicator'));
			expect(typed.map((call) => JSON.parse(call.body))).toEqual([
				{ from_number: line, number: contact, state: 'stop' }
			]);
		})
	);
	it.live('reads a thread back page by page, its window whole only at the end', () =>
		Effect.gen(function* () {
			let more = true;
			const api = yield* platformApi((call) => {
				if (!call.url.includes('/api/v2/messages?')) return answer(call);
				const offset = Number(new URL(call.url).searchParams.get('offset'));
				return json({
					data: [JSON.parse(text({ message_handle: `h${offset}` }))],
					pagination: { hasMore: more || offset === 0 }
				});
			});
			const connection = yield* direct();
			more = false;
			const read = yield* Effect.promise(async () =>
				connection.history?.(contact, '2026-01-01T00:00:00.000Z')
			);
			expect(read?.complete).toBe(true);
			expect(read?.messages.map((message) => message.id)).toEqual(['h0', 'h1']);
			const query = new URL(api.calls.at(-1)?.url ?? '').searchParams;
			expect(Object.fromEntries(query)).toMatchObject({
				number: contact,
				sendblue_number: line,
				is_outbound: 'false',
				sent_at_gte: '2026-01-01T00:00:00.000Z',
				message_type: 'message',
				offset: '1'
			});
			more = true;
			const cut = yield* Effect.promise(async () =>
				connection.history?.(contact, '2026-01-01T00:00:00.000Z')
			);
			expect(cut?.complete).toBe(false);
		})
	);
	it.live('a key Sendblue refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'Unauthorized' }, 401));
			const h = yield* host(chatProvider(sendblue), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
