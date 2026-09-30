// Telegram: the Bot API update codec, pairing (getMe + setWebhook on this channel's URL), the secret-token refusal,
// inbound with media, and the sendMessage shape.
import { describe, expect, it } from 'vitest';
import { telegram, telegramUpdate } from '../src/telegram/index.ts';
import { fakeFetch, file, host, json, signal } from './kit.ts';


const bot = { id: 42, username: 'DeskBot' };
const tg = (message: object, edited = false) => ({ update_id: 1, [edited ? 'edited_message' : 'message']: { message_id: 7, date: 1_790_000_000, from: { id: 5, first_name: 'Ana' }, ...message } });

describe('Telegram updates', () => {
	it('a DM is direct; the chat is part of the provider id', () => {
		const got = telegramUpdate(tg({ chat: { id: 5, type: 'private' }, text: 'hello' }), bot)!;
		expect(got.message).toMatchObject({ id: '5:7', thread: '5', group: false, invocation: 'direct', text: 'hello', from: { handle: '5', name: 'Ana' } });
	});
	it('a group names itself by its chat title, and the name reaches the decoded message', () => {
		const got = telegramUpdate(tg({ chat: { id: -9, type: 'supergroup', title: 'Site crew' }, text: 'hi' }), bot)!;
		expect(got.message).toMatchObject({ group: true, title: 'Site crew' });
		expect(telegramUpdate(tg({ chat: { id: 5, type: 'private' }, text: 'hi' }), bot)!.message).not.toHaveProperty('title');
	});
	it('in a group: an @mention, a bot command for us, a reply to our message address the bot; anything else is ambient', () => {
		const group = { chat: { id: -9, type: 'supergroup' } };
		expect(telegramUpdate(tg({ ...group, text: 'hey @deskbot status?', entities: [{ type: 'mention', offset: 4, length: 8 }] }), bot)!.message['invocation']).toBe('mention');
		expect(telegramUpdate(tg({ ...group, text: '/status@DeskBot', entities: [{ type: 'bot_command', offset: 0, length: 15 }] }), bot)!.message['invocation']).toBe('mention');
		expect(telegramUpdate(tg({ ...group, text: 'yes', reply_to_message: { message_id: 3, from: { id: 42 } } }), bot)!.message['invocation']).toBe('reply');
		expect(telegramUpdate(tg({ ...group, text: 'yes', reply_to_message: { message_id: 3, from: { id: 8 } } }), bot)!.message['invocation']).toBe('ambient');
		expect(telegramUpdate(tg({ ...group, text: 'hey @other', entities: [{ type: 'mention', offset: 4, length: 6 }] }), bot)!.message['invocation']).toBe('ambient');
	});
	it('an edit carries its edit time as the version; a topic is its own conversation; media is named for the adapter to fetch', () => {
		const got = telegramUpdate(tg({ chat: { id: -9, type: 'supergroup' }, is_topic_message: true, message_thread_id: 3, caption: 'site photo', edit_date: 1_790_000_060,
			photo: [{ file_id: 'small' }, { file_id: 'big' }] }, true), bot)!;
		expect(got.message).toMatchObject({ thread: '-9:thread:3', text: 'site photo', version: new Date(1_790_000_060_000).toISOString() });
		expect(got.media).toEqual({ fileId: 'big', fileName: 'photo-big.jpg', mimeType: 'image/jpeg' });
		expect(telegramUpdate({ update_id: 1, callback_query: {} }, bot)).toBeNull();
	});
});


describe('the Telegram link', () => {
	const api = (calls: { url: string }[]) => calls.map((c) => c.url.replace(/bot[^/]+/, 'bot…'));
	const bot = () => fakeFetch([
		(c) => c.url.endsWith('/getMe') ? json({ ok: true, result: { id: 42, username: 'DeskBot' } }) : undefined,
		(c) => c.url.endsWith('/setWebhook') || c.url.endsWith('/deleteWebhook') ? json({ ok: true, result: true }) : undefined,
		(c) => c.url.endsWith('/sendMessage') ? json({ ok: true, result: { message_id: 9 } }) : undefined,
		(c) => c.url.endsWith('/sendDocument') ? json({ ok: true, result: { message_id: 10 } }) : undefined,
		(c) => c.url.endsWith('/getFile') ? json({ ok: true, result: { file_path: 'photos/a.jpg' } }) : undefined,
		(c) => c.url.includes('/file/bot') ? new Response(new Uint8Array([1, 2, 3])) : undefined,
	]);
	it('refuses a malformed token before calling Telegram; pairs with getMe and registers this channel\'s webhook', async () => {
		const f = bot(), h = await host(telegram(), f);
		expect(h.link.connection().state).toBe('unpaired');
		await expect(h.link.pair({ token: 'nope' })).rejects.toThrow(/bot token does not look right/);
		expect(f.calls).toEqual([]);
		await h.link.pair({ token: '123:abc' });
		expect(api(f.calls)).toEqual(['https://api.telegram.org/bot…/getMe', 'https://api.telegram.org/bot…/setWebhook']);
		expect(JSON.parse(f.calls[1]!.body)).toMatchObject({ url: 'https://ws.example/hooks/bolt.x/desk', allowed_updates: ['message', 'edited_message'] });
		expect(h.saved).toEqual([{ token: '123:abc' }]);
		expect(h.link.connection()).toMatchObject({ state: 'connected', pairedAs: '@DeskBot', about: { botName: '@DeskBot' } });
	});
	it('a refused token keeps nothing', async () => {
		const f = fakeFetch([() => json({ ok: false, description: 'Unauthorized' }, 401)]), h = await host(telegram(), f);
		await expect(h.link.pair({ token: '123:abc' })).rejects.toThrow(/Telegram getMe: Unauthorized/);
		expect(h.saved).toEqual([]);
	});
	it('refuses an update without the secret token; a verified one lands with its media bytes', async () => {
		const f = bot(), h = await host(telegram(), f, { token: '123:abc' });
		const secret = JSON.parse(f.calls[1]!.body).secret_token as string;
		const update = { update_id: 1, message: { message_id: 7, date: 1_790_000_000, chat: { id: 5, type: 'private' }, from: { id: 5 }, caption: 'look', photo: [{ file_id: 'p' }] } };
		const post = (s: string) => new Request('https://internal/hook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': s }, body: JSON.stringify(update) });
		expect((await h.link.webhook!(post('wrong'))).status).toBe(401);
		expect(h.events).toEqual([]);
		expect((await h.link.webhook!(post(secret))).status).toBe(200);
		expect(h.events).toMatchObject([{ kind: 'inbound', channel: 'desk', message: { id: '5:7', text: 'look', attachments: [{ fileName: 'photo-p.jpg', byteLength: 3, bin: 0 }] } }]);
	});
	it('sends to the chat, a topic by its thread id', async () => {
		const f = bot(), h = await host(telegram(), f, { token: '123:abc' });
		expect(await h.link.send('desk', { to: '-9:thread:3', text: 'hi' }, signal())).toEqual({ providerId: '-9:9' });
		expect(JSON.parse(f.calls.at(-1)!.body)).toEqual({ chat_id: '-9', text: 'hi', message_thread_id: 3 });
	});
	it('each attachment follows the text as a document in the same topic, with its name and type', async () => {
		const f = bot(), h = await host(telegram(), f, { token: '123:abc' });
		expect(await h.link.send('desk', { to: '-9:thread:3', text: 'hi' }, signal(), [file('report.pdf', 'application/pdf', '%PDF r')])).toEqual({ providerId: '-9:9' });
		expect(api(f.calls).slice(-2)).toEqual(['https://api.telegram.org/bot…/sendMessage', 'https://api.telegram.org/bot…/sendDocument']);
		const form = f.calls.at(-1)!.form!, doc = form.get('document') as File;
		expect([form.get('chat_id'), form.get('message_thread_id'), doc.name, doc.type, await doc.text()]).toEqual(['-9', '3', 'report.pdf', 'application/pdf', '%PDF r']);
	});
	it('a stored token Telegram now refuses is an error naming its recovery, not a silent connected', async () => {
		const h = await host(telegram(), fakeFetch([() => json({ ok: false, description: 'Unauthorized' }, 401)]), { token: '123:abc' });
		expect(h.link.connection()).toMatchObject({ state: 'error', error: expect.stringContaining('pair again') });
	});
});
