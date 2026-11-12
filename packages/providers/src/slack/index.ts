import { createHmac } from 'node:crypto';
import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, ProviderUnavailable } from '../errors.ts';
import { field, hostCall, same, str, storedCredential, withFetch, type Obj } from '../util.ts';

const API = 'https://slack.com/api';
const TRANSIENT = new Set([
	'ratelimited',
	'internal_error',
	'fatal_error',
	'service_unavailable',
	'request_timeout'
]);
const SKEW_S = 300;
const MEDIA_MAX = 20 * 1024 * 1024;
const REPLY_THREADS = 10;
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
const History = Schema.Struct({
	messages: Schema.Array(Payload),
	has_more: Schema.optionalKey(Schema.Boolean),
	response_metadata: Schema.optionalKey(
		Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) })
	)
});
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
						en: 'OAuth & Permissions → Bot Token Scopes: add chat:write, files:read, files:write, channels:history, groups:history, im:history, mpim:history, users:read. Install the app to the workspace.',
						zh: 'OAuth & Permissions → Bot Token Scopes：添加 chat:write、files:read、files:write、channels:history、groups:history、im:history、mpim:history、users:read，然后将应用安装到工作区。'
					}
				},
				{
					text: {
						en: 'Event Subscriptions: turn them on and paste this Request URL; subscribe to the bot events message.channels, message.groups, message.im and message.mpim.',
						zh: 'Event Subscriptions：开启后粘贴此 Request URL；订阅机器人事件 message.channels、message.groups、message.im 和 message.mpim。'
					},
					copy: 'webhook_url'
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
			/** Without `files:read` Slack answers its sign-in page, so only the declared size proves these are the file's bytes. */
			const bytesOf = (url: string, token: string, size: number) =>
				withFetch(
					ctx,
					Effect.gen(function* () {
						const response = yield* HttpClient.execute(
							HttpClientRequest.get(url, { headers: { authorization: `Bearer ${token}` } })
						);
						const bytes = new Uint8Array(yield* response.arrayBuffer);
						return response.status < 400 && bytes.byteLength === size ? bytes : null;
					})
				).pipe(
					Effect.tapCause(Effect.logWarning),
					Effect.orElseSucceed(() => null)
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
					return { provider_id: `${sent.channel}:${sent.ts}` };
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
					const parsed = slackEvent(payload.value, cred.botUser);
					if (parsed !== null) {
						const bins: Uint8Array[] = [],
							attachments: Json[] = [];
						for (const { url, ...file } of parsed.files) {
							const bytes =
								url === null || file.bytes > MEDIA_MAX
									? null
									: yield* bytesOf(url, cred.botToken, file.bytes);
							if (bytes !== null) bins.push(bytes);
							attachments.push(bytes === null ? file : { ...file, bin: bins.length - 1 });
						}
						yield* hostCall('store Slack event', () =>
							ctx.emit({
								kind: 'messages',
								messages: [bins.length === 0 ? parsed.message : { ...parsed.message, attachments }],
								...(bins.length === 0 ? {} : { bins })
							})
						);
					}
					return new Response(null, { status: 200 });
				}),
				reconcile: Effect.fn('Slack.reconcile')(function* (thread: string, since: string) {
					if (cred === null)
						return yield* Effect.fail(
							new ProviderUnavailable({ message: 'the Slack app is not connected' })
						);
					const { botToken, botUser } = cred,
						[channel = '', parent] = thread.split(':'),
						oldest = String(Date.parse(since) / 1000);
					const read = (method: string, more: { readonly [k: string]: string }) =>
						call(
							History,
							botToken,
							method,
							new URLSearchParams({ channel, oldest, inclusive: 'true', ...more })
						);
					const replies = (ts: string) =>
						read('conversations.replies', { ts }).pipe(
							Effect.map((page) => ({
								...page,
								messages: page.messages.filter((message) => message['ts'] !== ts)
							}))
						);
					const wire = (messages: readonly (typeof Payload.Type)[]) =>
						messages.flatMap((m) => slackMessage({ ...m, channel }, botUser)?.message ?? []);
					// one answer per read, with no cursor: a delete cannot move anything under it
					const whole = (page: typeof History.Type) =>
						page.has_more !== true && !page.response_metadata?.next_cursor;
					return yield* Effect.gen(function* () {
						if (parent !== undefined) {
							const page = yield* replies(parent);
							return { messages: wire(page.messages), complete: whole(page) };
						}
						// ponytail: one page of 999, and the newest 10 reply threads; past that it repairs what it shows and deletes nothing
						const page = yield* read('conversations.history', { limit: '999' });
						const messages = wire(page.messages.toReversed());
						// a first reply missed while down opens a thread the engine cannot name yet, so it never asks for it
						for (const started of page.messages
							.filter((message) => Number(message['latest_reply']) >= Number(oldest))
							.slice(0, REPLY_THREADS))
							messages.push(...wire((yield* replies(String(started['ts']))).messages));
						return { messages, complete: whole(page) };
					}).pipe(
						// the engine ends its pass on a refusal: a thread the bot cannot read costs only that thread
						Effect.catchTag('ProviderRefused', () =>
							Effect.succeed({ messages: [], complete: false })
						)
					);
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

/** A file a message carries: the wire's descriptor, and where its bytes are when the bot token may go there. */
type SlackFile = { name: string; mime: string; bytes: number; url: string | null };
type SlackMessage = { message: Obj; files: readonly SlackFile[] };
const instant = (ts: string) => new Date(Number(ts) * 1000).toISOString();
const filesOf = (e: Readonly<Record<string, unknown>>): SlackFile[] =>
	(Array.isArray(e['files']) ? e['files'] : []).flatMap((file) => {
		if (!Predicate.isObject(file) || typeof file['id'] !== 'string') return [];
		const url = str(file['url_private']);
		return [
			{
				name: str(file['name']) ?? str(file['title']) ?? `file-${file['id']}`,
				mime: str(file['mimetype']) ?? 'application/octet-stream',
				bytes: typeof file['size'] === 'number' ? file['size'] : 0,
				// a remote file's `url_private` is someone else's server: the bot token goes to Slack alone
				url: url?.startsWith('https://files.slack.com/') === true ? url : null
			}
		];
	});
/** One Events API callback → the wire message and its files, or `null` (a bot's own message, a change that is no edit, anything not a message). */
export function slackEvent(payload: unknown, botUser: string): SlackMessage | null {
	if (
		!Predicate.isObject(payload) ||
		payload['type'] !== 'event_callback' ||
		!Predicate.isObject(payload['event'])
	)
		return null;
	const e = payload['event'];
	if (e['type'] !== 'message') return null;
	if (e['subtype'] === 'message_deleted') {
		const channel = str(e['channel']),
			ts = str(e['deleted_ts']);
		return channel === null || ts === null
			? null
			: { message: { id: `${channel}:${ts}`, deleted: true }, files: [] };
	}
	if (e['subtype'] !== 'message_changed') return slackMessage(e, botUser);
	const changed = e['message'];
	// an unfurl or a reply count changes a message too: only `edited` or a tombstone changed what it says
	return Predicate.isObject(changed) &&
		(Predicate.isObject(changed['edited']) || changed['subtype'] === 'tombstone')
		? slackMessage({ ...changed, channel: e['channel'], channel_type: e['channel_type'] }, botUser)
		: null;
}

/** One message object, an event's or a history's → the wire message and its files; a deleted thread parent stays as a tombstone. */
function slackMessage(e: Readonly<Record<string, unknown>>, botUser: string): SlackMessage | null {
	const channel = str(e['channel']),
		ts = str(e['ts']),
		user = str(e['user']);
	if (channel !== null && ts !== null && e['subtype'] === 'tombstone')
		return { message: { id: `${channel}:${ts}`, deleted: true }, files: [] };
	if (
		(e['subtype'] !== undefined && e['subtype'] !== 'file_share') ||
		e['bot_id'] !== undefined ||
		e['user'] === botUser ||
		channel === null ||
		ts === null ||
		user === null
	)
		return null;
	const text = typeof e['text'] === 'string' ? e['text'] : '',
		thread = str(e['thread_ts']),
		edited = Predicate.isObject(e['edited']) ? str(e['edited']['ts']) : null,
		files = filesOf(e);
	const group = e['channel_type'] !== 'im' && !channel.startsWith('D');
	const invocation = !group
		? 'direct'
		: botUser !== '' && text.includes(`<@${botUser}>`)
			? 'mention'
			: e['parent_user_id'] === botUser
				? 'reply'
				: 'ambient';
	return {
		message: {
			id: `${channel}:${ts}`,
			thread: thread === null || thread === ts ? channel : `${channel}:${thread}`,
			sent_at: instant(ts),
			from: { handle: user, name: null },
			text,
			group,
			invocation,
			reply_to: thread === null || thread === ts ? null : `${channel}:${thread}`,
			...(edited === null ? {} : { version: instant(edited) }),
			attachments: files.map(({ url: _url, ...file }) => file)
		},
		files
	};
}
