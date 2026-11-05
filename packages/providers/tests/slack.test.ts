import { TestClock } from 'effect/testing';
import { Effect } from 'effect';
// Slack: setup validation with auth.test, the signing-secret refusal (and the replay window), url_verification, the
// event decode, edits, deletes and files, reconcile, and chat.postMessage.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { slack } from '../src/slack/index.ts';
import { fakeFetch, file, host, json, messagesOf, signal } from './kit.ts';

const NOW = 1_790_000_000_000,
	SECRET = '8f742231b10e8888abcd99yyyzzz85a5'.replace(/[^0-9a-f]/g, 'a');
const api = () =>
	fakeFetch([
		(c) =>
			c.url.endsWith('/auth.test')
				? c.headers['authorization'] === 'Bearer xoxb-good'
					? json({ ok: true, user_id: 'UBOT', user: 'deskbot', team: 'Acme', team_id: 'T1' })
					: json({ ok: false, error: 'invalid_auth' })
				: undefined,
		(c) =>
			c.url.endsWith('/chat.postMessage')
				? json({ ok: true, channel: 'C1', ts: '1790000001.000200' })
				: undefined,
		(c) =>
			c.url.endsWith('/files.getUploadURLExternal')
				? json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F1' })
				: undefined,
		(c) => (c.url === 'https://files.slack.com/upload/v1/abc' ? new Response('OK - 6') : undefined),
		(c) =>
			c.url.endsWith('/files.completeUploadExternal')
				? json({ ok: true, files: [{ id: 'F1' }] })
				: undefined
	]);
const paired = () =>
	Effect.gen(function* () {
		const f = api(),
			h = yield* host(slack(), f);
		yield* h.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
		return { f, h };
	});
const signed = (body: object, ts = String(NOW / 1000), secret = SECRET) => {
	const raw = JSON.stringify(body);
	return new Request('https://internal/hook', {
		method: 'POST',
		body: raw,
		headers: {
			'x-slack-request-timestamp': ts,
			'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`
		}
	});
};
const event = (e: object) => ({
	type: 'event_callback',
	event: {
		type: 'message',
		channel: 'C1',
		user: 'U7',
		ts: '1790000000.000100',
		text: 'hi',
		channel_type: 'channel',
		...e
	}
});

describe('Slack', () => {
	it.effect(
		'a Slack error on send is a permanent refusal, its own transient errors are retried',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW);
				const answer = (error: string) =>
					fakeFetch([
						(c) =>
							c.url.endsWith('/auth.test')
								? json({ ok: true, user_id: 'UBOT', user: 'deskbot', team: 'Acme', team_id: 'T1' })
								: undefined,
						(c) => (c.url.endsWith('/chat.postMessage') ? json({ ok: false, error }) : undefined)
					]);
				const gone = yield* host(slack(), answer('channel_not_found'));
				yield* gone.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
				expect(
					yield* Effect.flip(gone.link.send!({ to: 'C1', text: 'x' }, undefined))
				).toMatchObject({ _tag: 'ProviderRefused', code: 'channel_not_found' });
				const busy = yield* host(slack(), answer('internal_error'));
				yield* busy.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
				expect(
					yield* Effect.flip(busy.link.send!({ to: 'C1', text: 'x' }, undefined))
				).toMatchObject({ _tag: 'ProviderUnavailable' });
			})
	);
	it.effect('validates the setup: both fields, the token shape, and auth.test', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const f = api(),
				h = yield* host(slack(), f);
			expect((yield* Effect.flip(h.link.pair!({ botToken: 'xoxb-good' }))).message).toMatch(
				/signing secret is required/
			);
			expect(
				(yield* Effect.flip(h.link.pair!({ botToken: 'xoxp-user', signingSecret: SECRET }))).message
			).toMatch(/bot token does not look right/);
			expect(
				(yield* Effect.flip(h.link.pair!({ botToken: 'xoxb-bad', signingSecret: SECRET }))).message
			).toMatch(/invalid_auth/);
			expect(h.writes).toEqual([]);
			yield* h.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
			expect(h.status).toEqual({
				state: 'connected',
				account: 'deskbot',
				about: { workspace: 'Acme', team: 'T1', botName: 'deskbot' }
			});
			expect(Object.fromEntries(h.values)).toEqual({
				credential: {
					botToken: 'xoxb-good',
					signingSecret: SECRET,
					botUser: 'UBOT',
					team: 'Acme',
					teamId: 'T1',
					botName: 'deskbot'
				}
			});
		})
	);
	it.effect(
		"refuses a bad signature, another secret's, and a stale timestamp; answers url_verification",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW);
				const { h } = yield* paired();
				const bad = signed(event({}));
				bad.headers.set('x-slack-signature', 'v0=00');
				expect((yield* h.link.webhook!(bad)).status).toBe(401);
				expect((yield* h.link.webhook!(signed(event({}), undefined, 'b'.repeat(32)))).status).toBe(
					401
				);
				expect((yield* h.link.webhook!(signed(event({}), String(NOW / 1000 - 600)))).status).toBe(
					401
				);
				expect(h.events).toEqual([]);
				expect(
					yield* h.link.webhook!(signed({ type: 'url_verification', challenge: 'c-1' })).pipe(
						Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
					)
				).toEqual({ challenge: 'c-1' });
			})
	);
	it.effect(
		"decodes messages: a mention of the bot, a thread reply, a DM; its own and other bots' are dropped",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW);
				const { h } = yield* paired();
				yield* h.link.webhook!(signed(event({ text: 'hey <@UBOT> status?' })));
				yield* h.link.webhook!(
					signed(
						event({
							ts: '1790000000.000300',
							thread_ts: '1790000000.000100',
							parent_user_id: 'UBOT',
							text: 'ok'
						})
					)
				);
				yield* h.link.webhook!(
					signed(event({ channel: 'D9', channel_type: 'im', ts: '1790000000.000400' }))
				);
				yield* h.link.webhook!(signed(event({ bot_id: 'B1' })));
				yield* h.link.webhook!(signed(event({ user: 'UBOT' })));
				yield* h.link.webhook!(signed(event({ subtype: 'message_changed' })));
				expect(messagesOf(h.events)).toMatchObject([
					{
						id: 'C1:1790000000.000100',
						thread: 'C1',
						group: true,
						invocation: 'mention',
						from: { handle: 'U7' },
						sentAt: '2026-09-21T14:13:20.000Z'
					},
					{
						id: 'C1:1790000000.000300',
						thread: 'C1:1790000000.000100',
						invocation: 'reply',
						replyTo: 'C1:1790000000.000100'
					},
					{ id: 'D9:1790000000.000400', thread: 'D9', group: false, invocation: 'direct' }
				]);
			})
	);
	it.effect(
		'an edit carries its version, a delete tombstones; a change that is no edit is nothing',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW);
				const { h } = yield* paired();
				const changed = (message: object) =>
					signed(
						event({
							subtype: 'message_changed',
							hidden: true,
							ts: '1790000900.000900',
							user: undefined,
							text: undefined,
							message
						})
					);
				const original = { type: 'message', user: 'U7', ts: '1790000000.000100' };
				yield* h.link.webhook!(
					changed({
						...original,
						text: 'fixed',
						thread_ts: '1789999999.000050',
						edited: { user: 'U7', ts: '1790000060.000000' }
					})
				);
				yield* h.link.webhook!(
					changed({ ...original, text: 'hi', attachments: [{ title: 'unfurl' }] })
				);
				yield* h.link.webhook!(
					changed({ ...original, bot_id: 'B1', edited: { user: 'U7', ts: '1790000061.000000' } })
				);
				yield* h.link.webhook!(
					signed(
						event({
							channel: 'D9',
							channel_type: undefined,
							subtype: 'message_changed',
							user: undefined,
							message: { ...original, text: 'dm', edited: { user: 'U7', ts: '1790000062.000000' } }
						})
					)
				);
				yield* h.link.webhook!(
					signed(
						event({
							subtype: 'message_deleted',
							hidden: true,
							ts: '1790000901.000100',
							deleted_ts: '1790000000.000300',
							user: undefined,
							text: undefined
						})
					)
				);
				// a thread parent deleted under its replies is no `message_deleted`: it turns into a tombstone
				yield* h.link.webhook!(
					changed({
						type: 'message',
						subtype: 'tombstone',
						hidden: true,
						user: 'USLACKBOT',
						ts: '1790000000.000400',
						text: 'This message was deleted.'
					})
				);
				expect(messagesOf(h.events)).toEqual([
					expect.objectContaining({
						id: 'C1:1790000000.000100',
						thread: 'C1:1789999999.000050',
						text: 'fixed',
						sentAt: '2026-09-21T14:13:20.000Z',
						version: '2026-09-21T14:14:20.000Z'
					}),
					expect.objectContaining({
						id: 'D9:1790000000.000100',
						group: false,
						invocation: 'direct'
					}),
					{ id: 'C1:1790000000.000300', deleted: true },
					{ id: 'C1:1790000000.000400', deleted: true }
				]);
			})
	);
	it.effect("carries a file's bytes, read with the bot token and from Slack alone", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const slackFile = 'https://files.slack.com/files-pri/T1-F1/report.pdf',
				signIn = 'https://files.slack.com/files-pri/T1-F2/page.pdf',
				gone = 'https://files.slack.com/files-pri/T1-F3/gone.pdf',
				big = 'https://files.slack.com/files-pri/T1-F4/big.bin',
				remote = 'https://attacker.example/files.slack.com/report.pdf';
			const f = fakeFetch([
				(c) =>
					c.url.endsWith('/auth.test')
						? json({ ok: true, user_id: 'UBOT', user: 'deskbot', team: 'Acme', team_id: 'T1' })
						: undefined,
				(c) => (c.url === slackFile ? new Response('%PDF r') : undefined),
				(c) => (c.url === signIn ? new Response('<html>sign in</html>') : undefined),
				(c) => (c.url === gone ? new Response('gone!!', { status: 404 }) : undefined)
			]);
			const h = yield* host(slack(), f);
			yield* h.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
			const pdf = { mimetype: 'application/pdf', size: 6, mode: 'hosted' };
			yield* h.link.webhook!(
				signed(
					event({
						subtype: 'file_share',
						text: 'the report',
						files: [
							{ id: 'F1', name: 'report.pdf', url_private: slackFile, ...pdf },
							{ id: 'F2', name: 'page.pdf', url_private: signIn, ...pdf },
							{ id: 'F3', name: 'gone.pdf', url_private: gone, ...pdf },
							{ id: 'F4', name: 'big.bin', url_private: big, ...pdf, size: 21 * 1024 * 1024 },
							{ id: 'F5', name: 'remote.pdf', url_private: remote, ...pdf, mode: 'external' },
							{ id: 'F6', file_access: 'check_file_info' }
						]
					})
				)
			);
			const [stored] = h.events;
			if (stored?.kind !== 'messages') throw new Error('The message was not stored.');
			expect(stored.bins?.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['%PDF r']);
			expect(stored.messages).toEqual([
				expect.objectContaining({
					text: 'the report',
					attachments: [
						{ name: 'report.pdf', mime: 'application/pdf', bytes: 6, bin: 0 },
						{ name: 'page.pdf', mime: 'application/pdf', bytes: 6 },
						{ name: 'gone.pdf', mime: 'application/pdf', bytes: 6 },
						{ name: 'big.bin', mime: 'application/pdf', bytes: 21 * 1024 * 1024 },
						{ name: 'remote.pdf', mime: 'application/pdf', bytes: 6 },
						{ name: 'file-F6', mime: 'application/octet-stream', bytes: 0 }
					]
				})
			]);
			expect(f.calls.find((c) => c.url === slackFile)?.headers['authorization']).toBe(
				'Bearer xoxb-good'
			);
			expect(f.calls.some((c) => c.url === remote || c.url === big)).toBe(false);
		})
	);
	it.effect('reconciles a channel from one read, oldest first, and walks threads that moved', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const since = '2026-09-14T00:00:00.000Z',
				oldest = String(Date.parse(since) / 1000),
				user = { type: 'message', user: 'U7' };
			const f = fakeFetch([
				(c) =>
					c.url.endsWith('/auth.test')
						? json({ ok: true, user_id: 'UBOT', user: 'deskbot', team: 'Acme', team_id: 'T1' })
						: undefined,
				(c) =>
					c.url.endsWith('/conversations.history')
						? json({
								ok: true,
								has_more: false,
								messages: [
									{ ...user, ts: '1790000300.000000', text: 'bot', bot_id: 'B1' },
									{
										...user,
										subtype: 'tombstone',
										ts: '1790000200.000000',
										text: 'This message was deleted.'
									},
									{
										...user,
										ts: '1790000100.000000',
										text: 'a file',
										edited: { user: 'U7', ts: '1790000150.000000' },
										files: [
											{
												id: 'F1',
												name: 'r.pdf',
												mimetype: 'application/pdf',
												size: 6,
												url_private: 'https://files.slack.com/files-pri/T1-F1/r.pdf'
											}
										]
									},
									{
										...user,
										ts: '1790000000.000000',
										text: 'parent',
										thread_ts: '1790000000.000000',
										reply_count: 1,
										latest_reply: '1790000010.000000'
									},
									{
										...user,
										ts: '1789000000.000000',
										text: 'quiet parent',
										thread_ts: '1789000000.000000',
										reply_count: 1,
										latest_reply: '1789000010.000000'
									}
								]
							})
						: undefined,
				(c) =>
					c.url.endsWith('/conversations.replies')
						? json({
								ok: true,
								has_more: false,
								messages: [
									{
										...user,
										ts: '1790000000.000000',
										text: 'parent',
										thread_ts: '1790000000.000000'
									},
									{
										...user,
										ts: '1790000010.000000',
										text: 'a first reply',
										thread_ts: '1790000000.000000'
									}
								]
							})
						: undefined
			]);
			const h = yield* host(slack(), f);
			yield* h.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
			const page = yield* h.link.reconcile!('C1', since);
			expect(page.complete).toBe(true);
			expect(page.bins).toBeUndefined();
			expect(page.messages).toEqual([
				expect.objectContaining({ id: 'C1:1789000000.000000', thread: 'C1' }),
				expect.objectContaining({ id: 'C1:1790000000.000000', thread: 'C1' }),
				expect.objectContaining({
					id: 'C1:1790000100.000000',
					group: true,
					version: new Date(1790000150_000).toISOString(),
					attachments: [{ name: 'r.pdf', mime: 'application/pdf', bytes: 6 }]
				}),
				{ id: 'C1:1790000200.000000', deleted: true },
				expect.objectContaining({
					id: 'C1:1790000010.000000',
					thread: 'C1:1790000000.000000'
				})
			]);
			const [history, replies, ...rest] = f.calls.slice(-2 - 0);
			expect(rest).toEqual([]);
			expect(Object.fromEntries(new URLSearchParams(history!.body))).toEqual({
				channel: 'C1',
				oldest,
				inclusive: 'true',
				limit: '999'
			});
			expect(Object.fromEntries(new URLSearchParams(replies!.body))).toMatchObject({
				channel: 'C1',
				ts: '1790000000.000000'
			});
			expect(f.calls.some((c) => c.url.includes('files.slack.com'))).toBe(false);
		})
	);
	it.effect(
		'reconciles a thread without its parent, a DM as direct; a read that stopped is partial',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW);
				const since = '2026-09-14T00:00:00.000Z',
					parent = '1790000000.000000',
					reply = { type: 'message', user: 'U7', thread_ts: parent, parent_user_id: 'UBOT' };
				const answering = (route: (method: string) => unknown) =>
					fakeFetch([
						(c) =>
							c.url.endsWith('/auth.test')
								? json({ ok: true, user_id: 'UBOT', user: 'deskbot', team: 'Acme', team_id: 'T1' })
								: json(route(c.url.slice(c.url.lastIndexOf('/') + 1)))
					]);
				const open = (f: ReturnType<typeof fakeFetch>) =>
					Effect.gen(function* () {
						const h = yield* host(slack(), f);
						yield* h.link.pair!({ botToken: 'xoxb-good', signingSecret: SECRET });
						return h;
					});
				const messages = [
					{ ...reply, ts: parent, text: 'parent' },
					{ ...reply, ts: '1790000010.000000', text: 'ok' }
				];
				const thread = answering(() => ({ ok: true, has_more: false, messages }));
				const whole = yield* (yield* open(thread)).link.reconcile!(`C1:${parent}`, since);
				expect(whole).toMatchObject({
					complete: true,
					messages: [
						{
							id: 'C1:1790000010.000000',
							thread: `C1:${parent}`,
							invocation: 'reply',
							replyTo: `C1:${parent}`
						}
					]
				});
				expect(whole.messages).toHaveLength(1);
				expect(Object.fromEntries(new URLSearchParams(thread.calls.at(-1)!.body))).toMatchObject({
					channel: 'C1',
					ts: parent
				});
				const dm = yield* (yield* open(
					answering(() => ({ ok: true, messages: [{ type: 'message', user: 'U7', ts: parent }] }))
				)).link.reconcile!('D9', since);
				expect(dm.messages).toEqual([
					expect.objectContaining({ group: false, invocation: 'direct' })
				]);
				for (const more of [
					{ has_more: true },
					{ has_more: false, response_metadata: { next_cursor: 'bmV4dA==' } }
				]) {
					const partial = yield* (yield* open(answering(() => ({ ok: true, messages, ...more }))))
						.link.reconcile!(`C1:${parent}`, since);
					expect(partial.complete).toBe(false);
					expect(partial.messages).toHaveLength(1);
				}
				// a channel the bot left skips that thread: the engine would end its pass on a refusal
				const left = answering(() => ({ ok: false, error: 'not_in_channel' }));
				expect(yield* (yield* open(left)).link.reconcile!('C1', since)).toEqual({
					messages: [],
					complete: false
				});
				const busy = answering(() => ({ ok: false, error: 'internal_error' }));
				expect(yield* Effect.flip((yield* open(busy)).link.reconcile!('C1', since))).toMatchObject({
					_tag: 'ProviderUnavailable'
				});
			})
	);
	it.effect('uploads each attachment with files upload v2 and shares it into the same thread', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const { f, h } = yield* paired();
			yield* h.link.send!({ to: 'C1:1790000000.000100', text: 'report' }, [
				file('report.pdf', 'application/pdf', '%PDF r')
			]);
			const [url, bytes, done] = f.calls.slice(-3);
			expect(Object.fromEntries(new URLSearchParams(url!.body))).toEqual({
				filename: 'report.pdf',
				length: '6'
			});
			expect([bytes!.url, bytes!.headers['content-type'], bytes!.body]).toEqual([
				'https://files.slack.com/upload/v1/abc',
				'application/pdf',
				'%PDF r'
			]);
			expect(Object.fromEntries(new URLSearchParams(done!.body))).toEqual({
				files: '[{"id":"F1","title":"report.pdf"}]',
				channel_id: 'C1',
				thread_ts: '1790000000.000100'
			});
		})
	);
	it.effect('sends with chat.postMessage, a thread by its ts', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW);
			const { f, h } = yield* paired();
			expect(yield* h.link.send!({ to: 'C1:1790000000.000100', text: 'on it' }, undefined)).toEqual(
				{ providerId: 'C1:1790000001.000200' }
			);
			const call = f.calls.at(-1)!;
			expect(call.headers['authorization']).toBe('Bearer xoxb-good');
			expect(JSON.parse(call.body)).toEqual({
				channel: 'C1',
				text: 'on it',
				thread_ts: '1790000000.000100'
			});
			yield* h.link.unpair!();
			expect(
				(yield* Effect.flip(h.link.send!({ to: 'C1', text: 'x' }, undefined))).message
			).toMatch(/not connected/);
		})
	);
});
