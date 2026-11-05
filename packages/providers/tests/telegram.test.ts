import { Effect } from 'effect';
// Telegram: the Bot API update codec, pairing (getMe + setWebhook on this instance's URL, again on each open), the
// secret-token refusal, inbound with media, and the sendMessage shape.
import { describe, expect, it } from '@effect/vitest';
import { telegram, telegramUpdate } from '../src/telegram/index.ts';
import { fakeFetch, file, HOOK, host, json, signal } from './kit.ts';

const bot = { id: 42, username: 'DeskBot' };
const tg = (message: object, edited = false) => ({
	update_id: 1,
	[edited ? 'edited_message' : 'message']: {
		message_id: 7,
		date: 1_790_000_000,
		from: { id: 5, first_name: 'Ana' },
		...message
	}
});

describe('Telegram updates', () => {
	it('a DM is direct; the chat is part of the provider id', () => {
		const got = telegramUpdate(tg({ chat: { id: 5, type: 'private' }, text: 'hello' }), bot)!;
		expect(got.message).toMatchObject({
			id: '5:7',
			thread: '5',
			group: false,
			invocation: 'direct',
			text: 'hello',
			from: { handle: '5', name: 'Ana' }
		});
	});
	it('a group names itself by its chat title, and the name reaches the decoded message', () => {
		const got = telegramUpdate(
			tg({ chat: { id: -9, type: 'supergroup', title: 'Site crew' }, text: 'hi' }),
			bot
		)!;
		expect(got.message).toMatchObject({ group: true, title: 'Site crew' });
		expect(
			telegramUpdate(tg({ chat: { id: 5, type: 'private' }, text: 'hi' }), bot)!.message
		).not.toHaveProperty('title');
	});
	it('in a group: an @mention, a bot command for us, a reply to our message address the bot; anything else is ambient', () => {
		const group = { chat: { id: -9, type: 'supergroup' } };
		expect(
			telegramUpdate(
				tg({
					...group,
					text: 'hey @deskbot status?',
					entities: [{ type: 'mention', offset: 4, length: 8 }]
				}),
				bot
			)!.message['invocation']
		).toBe('mention');
		expect(
			telegramUpdate(
				tg({
					...group,
					text: '/status@DeskBot',
					entities: [{ type: 'bot_command', offset: 0, length: 15 }]
				}),
				bot
			)!.message['invocation']
		).toBe('mention');
		expect(
			telegramUpdate(
				tg({ ...group, text: 'yes', reply_to_message: { message_id: 3, from: { id: 42 } } }),
				bot
			)!.message['invocation']
		).toBe('reply');
		expect(
			telegramUpdate(
				tg({ ...group, text: 'yes', reply_to_message: { message_id: 3, from: { id: 8 } } }),
				bot
			)!.message['invocation']
		).toBe('ambient');
		expect(
			telegramUpdate(
				tg({ ...group, text: 'hey @other', entities: [{ type: 'mention', offset: 4, length: 6 }] }),
				bot
			)!.message['invocation']
		).toBe('ambient');
	});
	it('an edit carries its edit time as the version; a topic is its own conversation; media is named for the adapter to fetch', () => {
		const got = telegramUpdate(
			tg(
				{
					chat: { id: -9, type: 'supergroup' },
					is_topic_message: true,
					message_thread_id: 3,
					caption: 'site photo',
					edit_date: 1_790_000_060,
					photo: [{ file_id: 'small' }, { file_id: 'big' }]
				},
				true
			),
			bot
		)!;
		expect(got.message).toMatchObject({
			thread: '-9:thread:3',
			text: 'site photo',
			version: new Date(1_790_000_060_000).toISOString()
		});
		expect(got.media).toEqual({ fileId: 'big', name: 'photo-big.jpg', mime: 'image/jpeg' });
		expect(telegramUpdate({ update_id: 1, callback_query: {} }, bot)).toBeNull();
	});
});

describe('Telegram kinds', () => {
	const of = (message: object) =>
		telegramUpdate(tg({ chat: { id: 5, type: 'private' }, ...message }), bot)!;
	it('every file a bot receives is named for the link to fetch, with what it says of itself', () => {
		expect(of({ voice: { file_id: 'v', duration: 2, file_size: 900 } }).media).toEqual({
			fileId: 'v',
			name: 'file-v.ogg',
			mime: 'audio/ogg',
			bytes: 900
		});
		expect(of({ video_note: { file_id: 'n', length: 240, duration: 3 } }).media).toEqual({
			fileId: 'n',
			name: 'file-n.mp4',
			mime: 'video/mp4'
		});
		expect(
			of({
				live_photo: { file_id: 'l', width: 1, height: 1, duration: 1, mime_type: 'video/quicktime' }
			}).media
		).toEqual({ fileId: 'l', name: 'file-l.mp4', mime: 'video/quicktime' });
		expect(
			of({ animation: { file_id: 'a', file_name: 'a.mp4', mime_type: 'video/mp4' } }).media
		).toMatchObject({ fileId: 'a', name: 'a.mp4' });
		const sticker = { file_id: 's', width: 1, height: 1, emoji: '👍' };
		expect(of({ sticker: { ...sticker, is_animated: false, is_video: false } })).toMatchObject({
			media: { name: 'file-s.webp', mime: 'image/webp' },
			message: { text: '👍' }
		});
		expect(of({ sticker: { ...sticker, is_animated: true, is_video: false } }).media).toMatchObject(
			{ name: 'file-s.tgs', mime: 'application/x-tgsticker' }
		);
		expect(of({ sticker: { ...sticker, is_animated: false, is_video: true } }).media).toMatchObject(
			{ name: 'file-s.webm', mime: 'video/webm' }
		);
	});
	it('a kind with no file and no text says what it holds', () => {
		const text = (message: object) => of(message).message['text'];
		expect(text({ contact: { phone_number: '+65', first_name: 'Ana', last_name: 'Tan' } })).toBe(
			'Ana Tan +65'
		);
		expect(text({ location: { latitude: 1.29, longitude: 103.85 } })).toBe('1.29, 103.85');
		expect(
			text({
				venue: { title: 'Office', address: '1 Road', location: {} },
				location: { latitude: 1, longitude: 2 }
			})
		).toBe('Office, 1 Road');
		expect(text({ poll: { question: 'Lunch?', options: [{ text: 'Yes' }, { text: 'No' }] } })).toBe(
			'Lunch?\n- Yes\n- No'
		);
		expect(text({ dice: { emoji: '🎲', value: 4 } })).toBe('🎲 4');
		expect(text({ game: { title: 'Snake', description: 'x', photo: [] } })).toBe('Snake');
		expect(text({ invoice: { title: 'Order 9', description: 'x' } })).toBe('Order 9');
		expect(text({ checklist: { title: 'Open up', tasks: [] } })).toBe('Open up');
		expect(text({ story: { chat: {}, id: 1 } })).toBe('[story]');
		expect(text({ paid_media: { star_count: 1, paid_media: [] } })).toBe('[paid media]');
		expect(text({ rich_message: { blocks: [] } })).toBe('[rich message]');
		expect(text({ caption: 'mine', location: { latitude: 1, longitude: 2 } })).toBe('mine');
	});
	it.effect('claims no history: the link has no reconcile', () =>
		Effect.gen(function* () {
			expect((yield* host(telegram(), fakeFetch([]))).link.reconcile).toBeUndefined();
		})
	);
});

describe('the Telegram link', () => {
	const api = (calls: { url: string }[]) => calls.map((c) => c.url.replace(/bot[^/]+/, 'bot…'));
	const bot = () =>
		fakeFetch([
			(c) =>
				c.url.endsWith('/getMe')
					? json({ ok: true, result: { id: 42, username: 'DeskBot' } })
					: undefined,
			(c) =>
				c.url.endsWith('/setWebhook') || c.url.endsWith('/deleteWebhook')
					? json({ ok: true, result: true })
					: undefined,
			(c) =>
				c.url.endsWith('/sendMessage') ? json({ ok: true, result: { message_id: 9 } }) : undefined,
			(c) =>
				c.url.endsWith('/sendDocument')
					? json({ ok: true, result: { message_id: 10 } })
					: undefined,
			(c) =>
				c.url.endsWith('/getFile')
					? json({ ok: true, result: { file_path: 'photos/a.jpg' } })
					: undefined,
			(c) => (c.url.includes('/file/bot') ? new Response(new Uint8Array([1, 2, 3])) : undefined)
		]);
	it.effect(
		"refuses a malformed token before calling Telegram; pairs with getMe and registers this instance's webhook",
		() =>
			Effect.gen(function* () {
				const f = bot(),
					h = yield* host(telegram(), f);
				expect(h.status).toBeUndefined();
				expect((yield* Effect.flip(h.link.pair!({ token: 'nope' }))).message).toMatch(
					/bot token does not look right/
				);
				expect(f.calls).toEqual([]);
				yield* h.link.pair!({ token: '123:abc' });
				expect(api(f.calls)).toEqual([
					'https://api.telegram.org/bot…/getMe',
					'https://api.telegram.org/bot…/setWebhook'
				]);
				expect(JSON.parse(f.calls[1]!.body)).toMatchObject({
					url: HOOK,
					allowed_updates: ['message', 'edited_message']
				});
				expect(Object.fromEntries(h.values)).toEqual({ credential: { token: '123:abc' } });
				expect(h.status).toEqual({
					state: 'connected',
					account: '@DeskBot',
					about: { botName: '@DeskBot' }
				});
			})
	);
	it.effect('a refused token keeps nothing', () =>
		Effect.gen(function* () {
			const f = fakeFetch([() => json({ ok: false, description: 'Unauthorized' }, 401)]),
				h = yield* host(telegram(), f);
			expect((yield* Effect.flip(h.link.pair!({ token: '123:abc' }))).message).toMatch(
				/Telegram getMe: Unauthorized/
			);
			expect(h.writes).toEqual([]);
		})
	);
	it.effect("a stored token registers the instance's webhook again when the link opens", () =>
		Effect.gen(function* () {
			const f = bot(),
				h = yield* host(telegram(), f, { credential: { token: '123:abc' } });
			expect(api(f.calls)).toEqual([
				'https://api.telegram.org/bot…/getMe',
				'https://api.telegram.org/bot…/setWebhook'
			]);
			expect(JSON.parse(f.calls[1]!.body)).toMatchObject({ url: HOOK });
			expect(h.status).toMatchObject({ state: 'connected', account: '@DeskBot' });
		})
	);
	it.effect(
		'refuses an update without the secret token; a verified one lands with its media bytes',
		() =>
			Effect.gen(function* () {
				const f = bot(),
					h = yield* host(telegram(), f, { credential: { token: '123:abc' } });
				const secret = JSON.parse(f.calls[1]!.body).secret_token as string;
				const update = {
					update_id: 1,
					message: {
						message_id: 7,
						date: 1_790_000_000,
						chat: { id: 5, type: 'private' },
						from: { id: 5 },
						caption: 'look',
						photo: [{ file_id: 'p' }]
					}
				};
				const post = (s: string) =>
					new Request('https://internal/hook', {
						method: 'POST',
						headers: { 'x-telegram-bot-api-secret-token': s },
						body: JSON.stringify(update)
					});
				expect((yield* h.link.webhook!(post('wrong'))).status).toBe(401);
				expect(h.events).toEqual([]);
				expect((yield* h.link.webhook!(post(secret))).status).toBe(200);
				expect(h.events).toMatchObject([
					{
						kind: 'messages',
						messages: [
							{ id: '5:7', text: 'look', attachments: [{ name: 'photo-p.jpg', bytes: 3, bin: 0 }] }
						],
						bins: [new Uint8Array([1, 2, 3])]
					}
				]);
			})
	);
	it.effect('a file Telegram will not hand over stays named on the message with its size', () =>
		Effect.gen(function* () {
			const f = fakeFetch([
				(c) =>
					c.url.endsWith('/getMe')
						? json({ ok: true, result: { id: 42, username: 'DeskBot' } })
						: undefined,
				(c) => (c.url.endsWith('/setWebhook') ? json({ ok: true, result: true }) : undefined),
				(c) =>
					c.url.endsWith('/getFile')
						? json({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }, 400)
						: undefined
			]);
			const h = yield* host(telegram(), f, { credential: { token: '123:abc' } });
			const secret = JSON.parse(f.calls[1]!.body).secret_token as string;
			yield* h.link.webhook!(
				new Request('https://internal/hook', {
					method: 'POST',
					headers: { 'x-telegram-bot-api-secret-token': secret },
					body: JSON.stringify({
						update_id: 1,
						message: {
							message_id: 7,
							date: 1_790_000_000,
							chat: { id: 5, type: 'private' },
							from: { id: 5 },
							video: { file_id: 'big', file_name: 'site.mp4', file_size: 50_000_000 }
						}
					})
				})
			);
			expect(h.events).toMatchObject([
				{ messages: [{ attachments: [{ name: 'site.mp4', bytes: 50_000_000 }] }] }
			]);
			expect(h.events[0]).not.toHaveProperty('bins');
		})
	);
	it.effect('an update the engine did not store is a 500, so Telegram redelivers it', () =>
		Effect.gen(function* () {
			const f = bot(),
				h = yield* host(
					telegram(),
					f,
					{ credential: { token: '123:abc' } },
					{
						emit: async () => {
							throw new Error('busy');
						}
					}
				);
			const secret = JSON.parse(f.calls[1]!.body).secret_token as string;
			const update = {
				update_id: 1,
				message: {
					message_id: 7,
					date: 1_790_000_000,
					chat: { id: 5, type: 'private' },
					from: { id: 5 },
					text: 'hi'
				}
			};
			expect(
				(yield* Effect.flip(
					h.link.webhook!(
						new Request('https://internal/hook', {
							method: 'POST',
							headers: { 'x-telegram-bot-api-secret-token': secret },
							body: JSON.stringify(update)
						})
					)
				)).message
			).toMatch(/busy/);
		})
	);
	it.effect('sends to the chat, a topic by its thread id', () =>
		Effect.gen(function* () {
			const f = bot(),
				h = yield* host(telegram(), f, { credential: { token: '123:abc' } });
			expect(yield* h.link.send!({ to: '-9:thread:3', text: 'hi' }, undefined)).toEqual({
				providerId: '-9:9'
			});
			expect(JSON.parse(f.calls.at(-1)!.body)).toEqual({
				chat_id: '-9',
				text: 'hi',
				message_thread_id: 3
			});
		})
	);
	it.effect(
		'each attachment follows the text as a document in the same topic, with its name and type',
		() =>
			Effect.gen(function* () {
				const f = bot(),
					h = yield* host(telegram(), f, { credential: { token: '123:abc' } });
				expect(
					yield* h.link.send!({ to: '-9:thread:3', text: 'hi' }, [
						file('report.pdf', 'application/pdf', '%PDF r')
					])
				).toEqual({ providerId: '-9:9' });
				expect(api(f.calls).slice(-2)).toEqual([
					'https://api.telegram.org/bot…/sendMessage',
					'https://api.telegram.org/bot…/sendDocument'
				]);
				const form = f.calls.at(-1)!.form!,
					doc = form.get('document') as File;
				expect([
					form.get('chat_id'),
					form.get('message_thread_id'),
					doc.name,
					doc.type,
					yield* Effect.tryPromise(() => doc.text())
				]).toEqual(['-9', '3', 'report.pdf', 'application/pdf', '%PDF r']);
			})
	);
	it.effect(
		'a stored token Telegram now refuses is an error naming its recovery, not a silent connected',
		() =>
			Effect.gen(function* () {
				const h = yield* host(
					telegram(),
					fakeFetch([() => json({ ok: false, description: 'Unauthorized' }, 401)]),
					{ credential: { token: '123:abc' } }
				);
				expect(h.status).toMatchObject({
					state: 'error',
					error: expect.stringContaining('pair again')
				});
			})
	);
});
