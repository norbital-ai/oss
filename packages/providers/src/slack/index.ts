import { createHmac } from 'node:crypto';
import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, ProviderUnavailable } from '../errors.ts';
import { storedCredential } from '../link.ts';
import { field, hostCall, same, str, withFetch, type Obj } from '../util.ts';

const API = 'https://slack.com/api';
const TRANSIENT = new Set([
	'ratelimited',
	'internal_error',
	'fatal_error',
	'service_unavailable',
	'request_timeout'
]);
const SKEW_S = 300;
const Credential = Schema.Struct({
	botToken: Schema.NonEmptyString,
	signingSecret: Schema.NonEmptyString,
	botUser: Schema.String,
	team: Schema.String,
	teamId: Schema.String,
	botName: Schema.String
});
const Answer = Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) });
const Auth = Schema.Struct({
	user_id: Schema.String,
	team: Schema.String,
	team_id: Schema.String,
	user: Schema.String
});
const Sent = Schema.Struct({ channel: Schema.String, ts: Schema.String });
const Upload = Schema.Struct({ upload_url: Schema.String, file_id: Schema.String });
const Message = Schema.Struct({ to: Schema.NonEmptyString, text: Schema.String });
const Payload = Schema.Record(Schema.String, Schema.Json);
type Cred = typeof Credential.Type;

export function slack(): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'slack',
		id: 'slack',
		label: { en: 'Slack app', zh: 'Slack 应用' },
		setup: {
			kind: 'form',
			webhook: true,
			steps: [
				{
					text: {
						en: 'Create a Slack app for your workspace ("From scratch").',
						zh: '为您的 Slack 工作区创建一个应用（“From scratch”）。'
					},
					href: 'https://api.slack.com/apps'
				},
				{
					text: {
						en: 'OAuth & Permissions → Bot Token Scopes: add chat:write, files:write, channels:history, groups:history, im:history, mpim:history, users:read. Install the app to the workspace.',
						zh: 'OAuth & Permissions → Bot Token Scopes：添加 chat:write、files:write、channels:history、groups:history、im:history、mpim:history、users:read，然后将应用安装到工作区。'
					}
				},
				{
					text: {
						en: 'Event Subscriptions: turn them on and paste this Request URL; subscribe to the bot events message.channels, message.groups, message.im and message.mpim.',
						zh: 'Event Subscriptions：开启后粘贴此 Request URL；订阅机器人事件 message.channels、message.groups、message.im 和 message.mpim。'
					},
					copy: 'webhookUrl'
				},
				{
					text: {
						en: 'Paste the Bot User OAuth Token (xoxb-…) and, from Basic Information, the Signing Secret below. Invite the bot to a channel with /invite.',
						zh: '在下方粘贴 Bot User OAuth Token（xoxb-…）以及 Basic Information 中的 Signing Secret。用 /invite 将机器人邀请到频道。'
					}
				}
			],
			fields: [
				{
					name: 'botToken',
					label: { en: 'Bot User OAuth Token', zh: 'Bot User OAuth 令牌' },
					secret: true,
					hint: 'xoxb-…'
				},
				{ name: 'signingSecret', label: { en: 'Signing Secret', zh: '签名密钥' }, secret: true }
			]
		},
		test: {
			to: {
				name: 'to',
				label: { en: 'Channel id', zh: '频道 ID' },
				hint: { en: 'C… — a channel the bot is in', zh: 'C…——机器人所在的频道' }
			}
		},
		open: Effect.fn('Slack.open')(function* (ctx: DriverOpen) {
			const stored = yield* storedCredential(ctx, Credential);
			let cred: Cred | null = Option.getOrNull(stored);
			const connected = (value: Cred) =>
				hostCall('report Slack status', () =>
					ctx.status({
						state: 'connected',
						account: value.botName,
						about: { workspace: value.team, team: value.teamId, botName: value.botName }
					})
				);
			const call = <A>(
				schema: Schema.Decoder<A>,
				token: string,
				method: string,
				body: Json | URLSearchParams
			) =>
				withFetch(
					ctx,
					Effect.gen(function* () {
						const request = HttpClientRequest.post(`${API}/${method}`, {
							headers: { authorization: `Bearer ${token}` }
						});
						const response = yield* HttpClient.execute(
							body instanceof URLSearchParams
								? request.pipe(HttpClientRequest.bodyUrlParams(body))
								: request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
						).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Slack ${method}: request failed` })
							)
						);
						const payload = yield* response.json.pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Slack ${method}: response was not JSON` })
							)
						);
						const answer = yield* Schema.decodeUnknownEffect(Answer)(payload).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Slack ${method}: malformed answer` })
							)
						);
						if (!answer.ok)
							return yield* Effect.fail(
								answerFailure(
									`Slack ${method}: ${answer.error ?? response.status}`,
									response.status >= 400
										? response.status
										: TRANSIENT.has(answer.error ?? '')
											? 503
											: 400,
									answer.error
								)
							);
						return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: `Slack ${method}: malformed result` })
							)
						);
					})
				);
			if (cred !== null) yield* connected(cred);
			return {
				pair: Effect.fn('Slack.pair')(function* (input: Json) {
					const botToken = yield* field(input, 'botToken', 'The bot token', /^xoxb-/);
					const signingSecret = yield* field(
						input,
						'signingSecret',
						'The signing secret',
						/^[0-9a-f]{16,}$/i
					);
					const account = yield* call(Auth, botToken, 'auth.test', {});
					const next = {
						botToken,
						signingSecret,
						botUser: account.user_id,
						team: account.team,
						teamId: account.team_id,
						botName: account.user
					};
					yield* hostCall('store Slack credential', () =>
						ctx.credentials.write(new Map([['credential', next]]))
					);
					cred = next;
					yield* connected(next);
				}),
				unpair: () =>
					Effect.sync(() => {
						cred = null;
					}),
				close: Effect.void,
				send: Effect.fn('Slack.send')(function* (
					message: Json,
					files: readonly OutboundAttachment[] = []
				) {
					if (cred === null)
						return yield* Effect.fail(
							new ProviderUnavailable({ message: 'the Slack app is not connected' })
						);
					const value = cred;
					const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
						Effect.mapError(() => answerFailure('a Slack message needs `to` and `text`', 400))
					);
					const [channel = '', thread] = m.to.split(':');
					const sent = yield* call(Sent, value.botToken, 'chat.postMessage', {
						channel,
						text: m.text,
						...(thread === undefined ? {} : { thread_ts: thread })
					});
					const uploaded: { id: string; title: string }[] = [];
					for (const file of files) {
						const got = yield* call(
							Upload,
							value.botToken,
							'files.getUploadURLExternal',
							new URLSearchParams({ filename: file.name, length: String(file.bytes.byteLength) })
						);
						const response = yield* withFetch(
							ctx,
							HttpClient.execute(
								HttpClientRequest.post(got.upload_url).pipe(
									HttpClientRequest.bodyUint8Array(file.bytes, file.mime)
								)
							)
						).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: 'Slack file upload: request failed' })
							)
						);
						if (response.status >= 400)
							return yield* Effect.fail(
								answerFailure(`Slack file upload: ${response.status}`, response.status)
							);
						uploaded.push({ id: got.file_id, title: file.name });
					}
					if (uploaded.length > 0)
						yield* call(
							Schema.Unknown,
							value.botToken,
							'files.completeUploadExternal',
							new URLSearchParams({
								files: JSON.stringify(uploaded),
								channel_id: channel,
								...(thread === undefined ? {} : { thread_ts: thread })
							})
						);
					return { providerId: `${sent.channel}:${sent.ts}` };
				}),
				webhook: Effect.fn('Slack.webhook')(function* (request: Request) {
					const body = yield* hostCall('read Slack body', () => request.text());
					if (
						cred === null ||
						!slackVerified(
							request.headers,
							body,
							cred.signingSecret,
							yield* Clock.currentTimeMillis
						)
					)
						return new Response(null, { status: 401 });
					const payload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload))(body);
					if (Option.isNone(payload)) return new Response(null, { status: 400 });
					if (payload.value['type'] === 'url_verification')
						return Response.json({ challenge: payload.value['challenge'] });
					const message = slackEvent(payload.value, cred.botUser);
					if (message !== null)
						yield* hostCall('store Slack event', () =>
							ctx.emit({ kind: 'messages', messages: [message] })
						);
					return new Response(null, { status: 200 });
				})
			};
		})
	};
}

/** `X-Slack-Signature` over `v0:<timestamp>:<raw body>`; a timestamp more than five minutes off is a replay. */
export function slackVerified(
	headers: Headers,
	body: string,
	secret: string,
	nowMs: number
): boolean {
	const ts = headers.get('x-slack-request-timestamp') ?? '',
		sig = headers.get('x-slack-signature') ?? '';
	if (!/^\d+$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > SKEW_S) return false;
	return same(sig, `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`);
}

/** One Events API callback → the wire message, or `null` (a bot's own message, an edit notice, anything not a message). */
export function slackEvent(payload: unknown, botUser: string): Obj | null {
	if (
		!Predicate.isObject(payload) ||
		payload['type'] !== 'event_callback' ||
		!Predicate.isObject(payload['event'])
	)
		return null;
	const e = payload['event'];
	if (
		e['type'] !== 'message' ||
		(e['subtype'] !== undefined && e['subtype'] !== 'file_share') ||
		e['bot_id'] !== undefined ||
		e['user'] === botUser
	)
		return null;
	const channel = str(e['channel']),
		ts = str(e['ts']),
		user = str(e['user']);
	if (channel === null || ts === null || user === null) return null;
	const text = typeof e['text'] === 'string' ? e['text'] : '',
		thread = str(e['thread_ts']);
	const group = e['channel_type'] !== 'im';
	const invocation = !group
		? 'direct'
		: botUser !== '' && text.includes(`<@${botUser}>`)
			? 'mention'
			: e['parent_user_id'] === botUser
				? 'reply'
				: 'ambient';
	return {
		id: `${channel}:${ts}`,
		thread: thread === null || thread === ts ? channel : `${channel}:${thread}`,
		sentAt: new Date(Number(ts) * 1000).toISOString(),
		from: { handle: user, name: null },
		text,
		group,
		invocation,
		replyTo: thread === null || thread === ts ? null : `${channel}:${thread}`,
		attachments: []
	};
}
