import { TestClock } from 'effect/testing';
import { Effect } from 'effect';
// Slack: setup validation with auth.test, the signing-secret refusal (and the replay window), url_verification, the
// event decode, and chat.postMessage.
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
