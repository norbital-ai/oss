// Discord gateway events and heartbeat live in the link's scope. The gateway has no per-message acknowledgement: the only
// redelivery is a RESUME, which replays what followed the sequence it names. So the sequence moves only once a dispatch
// is stored, and a refused store drops the socket with a code that keeps the session. Replay lasts as long as the session
// (a few minutes, in memory, so not across a restart): past it, `reconcile` reads back what REST still holds.
import { createHash } from 'node:crypto';
import {
	Clock,
	Effect,
	Exit,
	FiberHandle,
	Option,
	Queue,
	Schedule,
	Schema,
	Predicate,
	Stream
} from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { DriverOpen, Json, LinkStatus, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, notConnected, ProviderUnavailable } from '../errors.ts';
import { blobOf, field, hostCall, str, storedCredential, withFetch, type Obj } from '../util.ts';

const API = 'https://discord.com/api/v10';
const QUERY = '?v=10&encoding=json';
const GATEWAY = `wss://gateway.discord.gg/${QUERY}`;
/** Discord's epoch: a snowflake's timestamp counts from here, in its bits above 22. */
const EPOCH = 1420070400000n;
const PAGE = 100;
const PAGES = 5;
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const PERMISSIONS = 101376;
export type GatewaySocket = {
	send(data: string): void;
	close(code?: number): void;
	addEventListener(
		type: 'message' | 'close',
		listener: (event: { data?: unknown; code?: number }) => void
	): void;
};
export type DiscordOptions = { readonly socket?: (url: string) => GatewaySocket };
const platformSocket = (url: string): GatewaySocket => {
	const socket = new WebSocket(url);
	return {
		send: (data) => socket.send(data),
		close: (code) => socket.close(code),
		addEventListener: (type, listener) => {
			if (type === 'message')
				socket.addEventListener('message', (event) => listener({ data: event.data }));
			else socket.addEventListener('close', (event) => listener({ code: event.code }));
		}
	};
};
const Credential = Schema.Struct({
	botToken: Schema.NonEmptyString,
	botId: Schema.NonEmptyString,
	botName: Schema.String
});
const Payload = Schema.Struct({
	op: Schema.Number,
	s: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	t: Schema.optionalKey(Schema.NullOr(Schema.String)),
	d: Schema.optionalKey(Schema.Json)
});
const ObjectBody = Schema.Record(Schema.String, Schema.Json);
const Me = Schema.Struct({ id: Schema.NonEmptyString, username: Schema.String });
const Sent = Schema.Struct({ id: Schema.NonEmptyString });
const Opened = Schema.Struct({ id: Schema.NonEmptyString });
const Message = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	to: Schema.NonEmptyString,
	text: Schema.String
});
const Channel = Schema.Struct({ guild_id: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const History = Schema.Array(ObjectBody);
class GatewayClosed extends Schema.TaggedError<GatewayClosed>()('GatewayClosed', {
	code: Schema.optionalKey(Schema.Number),
	message: Schema.String
}) {}
type GatewayEvent =
	| { readonly kind: 'beat' }
	| { readonly kind: 'message'; readonly data: unknown }
	| { readonly kind: 'close'; readonly code?: number };
type Cred = typeof Credential.Type;

export function discord(options: DiscordOptions = {}): ProviderDef {
	const socketOf = options.socket ?? platformSocket;
	return {
		_tag: 'ProviderDef',
		driver: 'discord',
		id: 'bot',
		label: { en: 'Discord bot', zh: 'Discord 机器人' },
		setup: {
			kind: 'form',
			steps: [
				{
					text: {
						en: 'Create an application in the Discord Developer Portal, then open Bot and reset the token to copy it.',
						zh: '在 Discord 开发者门户创建应用，然后打开 Bot 页面并重置令牌以复制它。'
					},
					href: 'https://discord.com/developers/applications'
				},
				{
					text: {
						en: 'On the same Bot page, turn on the Message Content Intent.',
						zh: '在同一 Bot 页面开启 Message Content Intent。'
					}
				},
				{
					text: {
						en: 'Paste the token below, then add the bot to your server with the invite link shown once it connects.',
						zh: '在下方粘贴令牌，连接后使用显示的邀请链接将机器人加入您的服务器。'
					}
				}
			],
			fields: [{ name: 'botToken', label: { en: 'Bot token', zh: '机器人令牌' }, secret: true }]
		},
		test: {
			to: {
				name: 'to',
				label: { en: 'Channel id', zh: '频道 ID' },
				hint: { en: 'Copy it with Developer Mode on', zh: '开启开发者模式后复制' }
			}
		},
		open: Effect.fn('Discord.open')(function* (ctx: DriverOpen) {
			let cred: Cred | null = Option.getOrNull(yield* storedCredential(ctx, Credential));
			let state: 'connecting' | 'connected' | 'reconnecting' | 'error' = 'connecting',
				detail = '';
			let sequence: number | null = null,
				session: { readonly id: string; readonly url: string } | null = null;
			const forget = () => {
				session = null;
				sequence = null;
			};
			const guilds = new Set<string>(),
				supervisor = yield* FiberHandle.make<void>();
			const report = () => {
				if (cred === null) return Effect.void;
				const value = cred,
					about = {
						botName: value.botName,
						guilds: guilds.size,
						inviteUrl: `https://discord.com/oauth2/authorize?client_id=${value.botId}&scope=bot&permissions=${PERMISSIONS}`
					};
				const status: LinkStatus =
					state === 'error'
						? { state, error: detail, about }
						: { state, account: value.botName, about, ...(detail === '' ? {} : { detail }) };
				return hostCall('report Discord status', () => ctx.status(status));
			};
			const set = (next: typeof state, message = '') =>
				Effect.suspend(() => {
					state = next;
					detail = message;
					return report();
				});
			const rest = <A>(
				schema: Schema.Decoder<A>,
				method: 'GET' | 'POST',
				path: string,
				body?: Json | FormData,
				token = cred?.botToken
			) =>
				withFetch(
					ctx,
					Effect.gen(function* () {
						const request = HttpClientRequest.make(method)(`${API}${path}`, {
							headers: { authorization: `Bot ${token ?? ''}` }
						});
						const response = yield* HttpClient.execute(
							body === undefined
								? request
								: body instanceof FormData
									? request.pipe(HttpClientRequest.bodyFormData(body))
									: request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
						).pipe(
							Effect.mapError(() => new ProviderUnavailable({ message: 'Discord request failed' }))
						);
						const value =
							response.status === 204
								? {}
								: yield* HttpClientResponse.schemaBodyJson(Schema.Json)(response).pipe(
										Effect.mapError(
											() => new ProviderUnavailable({ message: 'Discord response is malformed' })
										)
									);
						if (response.status >= 400) {
							const refusal = Predicate.isObject(value) ? value : {};
							return yield* Effect.fail(
								answerFailure(
									`Discord ${method} ${path.replace(/\d{5,}/g, '…')}: ${response.status} ${String(refusal['message'] ?? '')}`.trim(),
									response.status,
									refusal['code'] === undefined ? undefined : String(refusal['code'])
								)
							);
						}
						return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: 'Discord result failed validation' })
							)
						);
					})
				);
			const gateway = Effect.scoped(
				Effect.gen(function* () {
					if (cred === null) return;
					const value = cred,
						heartbeat = yield* FiberHandle.make<void>();
					let socket: GatewaySocket | null = null,
						greeted = false,
						acked = true,
						beat = () => {};
					const events = Stream.callback<GatewayEvent, ProviderUnavailable>((queue) =>
						Effect.gen(function* () {
							const opened = yield* Effect.acquireRelease(
								Effect.try({
									try: () => socketOf(session === null ? GATEWAY : `${session.url}${QUERY}`),
									catch: () =>
										new ProviderUnavailable({ message: 'Discord gateway could not open' })
								}),
								// 1000 ends the session: only a link that closes for good may say so
								(opened, exit) =>
									Effect.sync(() => opened.close(Exit.hasInterrupts(exit) ? 1000 : 4000))
							);
							socket = opened;
							beat = () => {
								Queue.offerUnsafe(queue, { kind: 'beat' });
							};
							opened.addEventListener('message', (event) =>
								Queue.offerUnsafe(queue, { kind: 'message', data: event.data })
							);
							opened.addEventListener('close', (event) => {
								Queue.offerUnsafe(queue, {
									kind: 'close',
									...(event.code === undefined ? {} : { code: event.code })
								});
								Queue.endUnsafe(queue);
							});
						})
					);
					yield* events.pipe(
						Stream.runForEach((event) =>
							Effect.gen(function* () {
								// in line with the frames: a store that holds this loop is not a silent gateway
								if (event.kind === 'beat') {
									if (!acked)
										return yield* Effect.fail(
											new GatewayClosed({ message: 'gateway stopped acknowledging heartbeats' })
										);
									acked = false;
									return;
								}
								if (event.kind === 'close') {
									// no HELLO: the resume URL is gone. 4007, 4009: the session is.
									if (!greeted || event.code === 4007 || event.code === 4009) forget();
									return yield* Effect.fail(
										new GatewayClosed({
											...(event.code === undefined ? {} : { code: event.code }),
											message: `gateway closed (${event.code ?? 'no code'})`
										})
									);
								}
								const payload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload))(
									String(event.data)
								);
								if (Option.isNone(payload)) return;
								const frame = payload.value,
									data = Option.getOrElse(
										Schema.decodeUnknownOption(ObjectBody)(frame.d),
										(): Obj => ({})
									);
								const current = socket;
								if (current === null) return;
								const send = (packet: Json) =>
									Effect.try({
										try: () => current.send(JSON.stringify(packet)),
										catch: () => new ProviderUnavailable({ message: 'Discord gateway send failed' })
									});
								if (frame.op === 10) {
									greeted = true;
									const interval =
										typeof data['heartbeat_interval'] === 'number'
											? data['heartbeat_interval']
											: 41250;
									yield* FiberHandle.run(
										heartbeat,
										Effect.suspend(() => {
											beat();
											return send({ op: 1, d: sequence });
										}).pipe(Effect.repeat(Schedule.spaced(interval)), Effect.asVoid)
									);
									yield* send(
										session === null
											? {
													op: 2,
													d: {
														token: value.botToken,
														intents: INTENTS,
														properties: { os: 'linux', browser: 'norbital', device: 'norbital' }
													}
												}
											: {
													op: 6,
													d: { token: value.botToken, session_id: session.id, seq: sequence }
												}
									);
								} else if (frame.op === 1) yield* send({ op: 1, d: sequence });
								else if (frame.op === 11) acked = true;
								else if (frame.op === 7 || frame.op === 9) {
									if (frame.op === 9 && frame.d !== true) forget();
									current.close(4000);
								} else if (frame.t === 'READY') {
									for (const guild of Array.isArray(data['guilds']) ? data['guilds'] : [])
										if (Predicate.isObject(guild) && typeof guild['id'] === 'string')
											guilds.add(guild['id']);
									yield* set('connected');
									const id = str(data['session_id']),
										url = str(data['resume_gateway_url']);
									if (id !== null && url !== null) session = { id, url };
								} else if (frame.t === 'RESUMED') yield* set('connected');
								else if (frame.t === 'GUILD_CREATE' && typeof data['id'] === 'string') {
									guilds.add(data['id']);
									yield* report();
								} else if (frame.t === 'GUILD_DELETE' && typeof data['id'] === 'string') {
									guilds.delete(data['id']);
									yield* report();
								} else {
									const messages = discordDispatch(
										frame.t,
										data,
										value.botId,
										yield* Clock.currentTimeMillis
									);
									if (messages.length > 0)
										yield* hostCall('store Discord message', () =>
											ctx.emit({ kind: 'messages', messages })
										);
								}
								// after the store: a refused one fails above, and the RESUME names the sequence before it
								if (typeof frame.s === 'number') sequence = frame.s;
							})
						)
					);
				})
			);
			const start = () =>
				FiberHandle.run(
					supervisor,
					gateway.pipe(
						Effect.tapError((error) =>
							error._tag === 'GatewayClosed' && (error.code === 4004 || error.code === 4014)
								? set(
										'error',
										error.code === 4004
											? 'Discord refused the bot token; pair again with a new one'
											: 'Turn on the Message Content Intent on the bot page of the Developer Portal, then reconnect'
									)
								: set('reconnecting', error.message)
						),
						Effect.retry({
							schedule: Schedule.min([
								Schedule.exponential('1 second'),
								Schedule.spaced('60 seconds')
							]),
							while: (error) =>
								error._tag !== 'Fenced' &&
								(error._tag !== 'GatewayClosed' || (error.code !== 4004 && error.code !== 4014))
						}),
						Effect.tapCause(Effect.logWarning),
						Effect.ignore
					)
				).pipe(Effect.asVoid);
			if (cred !== null) {
				yield* set('connecting');
				yield* start();
			}
			return {
				pair: (input: Json) =>
					Effect.gen(function* () {
						const botToken = yield* field(input, 'botToken', 'The bot token');
						const account = yield* rest(Me, 'GET', '/users/@me', undefined, botToken);
						const next = { botToken, botId: account.id, botName: account.username };
						yield* hostCall('store Discord credential', () =>
							ctx.credentials.write(new Map([['credential', next]]))
						);
						yield* FiberHandle.clear(supervisor);
						cred = next;
						forget();
						guilds.clear();
						yield* set('connecting');
						yield* start();
					}),
				unpair: () =>
					FiberHandle.clear(supervisor).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								cred = null;
							})
						)
					),
				close: FiberHandle.clear(supervisor),
				send: (message: Json, files: readonly OutboundAttachment[] = []) =>
					Effect.gen(function* () {
						if (cred === null)
							return yield* Effect.fail(notConnected('the Discord bot'));
						const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
							Effect.mapError(() => answerFailure('a Discord message needs `to` and `text`', 400))
						);
						// a nonce holds 25 characters, a message id more. Discord remembers it "in the past few minutes",
						// short of the engine's 10-minute lease, so this narrows duplicates and is no `idempotent_sends`
						const once =
							m.id === undefined
								? {}
								: {
										nonce: createHash('sha256').update(m.id).digest('hex').slice(0, 25),
										enforce_nonce: true
									};
						let body: Json | FormData = { content: m.text, ...once };
						if (files.length > 0) {
							const form = new FormData();
							form.set(
								'payload_json',
								JSON.stringify({
									content: m.text,
									...once,
									attachments: files.map((file, id) => ({ id, filename: file.name }))
								})
							);
							files.forEach((file, index) => form.set(`files[${index}]`, blobOf(file), file.name));
							body = form;
						}
						// `@<user id>`: a direct message, in the DM channel Discord opens (or reopens) with that person
						const channel = m.to.startsWith('@')
							? (yield* rest(Opened, 'POST', '/users/@me/channels', { recipient_id: m.to.slice(1) })).id
							: m.to;
						return {
							provider_id: (yield* rest(
								Sent,
								'POST',
								`/channels/${encodeURIComponent(channel)}/messages`,
								body
							)).id
						};
					}),
				reconcile: (thread: string, since: string) =>
					Effect.gen(function* () {
						if (cred === null)
							return yield* Effect.fail(notConnected('the Discord bot'));
						const { botId } = cred,
							path = `/channels/${encodeURIComponent(thread)}`,
							now = yield* Clock.currentTimeMillis;
						// a REST message names no guild: only its channel says whether it was a group
						const { guild_id = null } = yield* rest(Channel, 'GET', path);
						const messages: Obj[] = [];
						// `after` is a key, not an offset: a delete between pages moves nothing. Minus one: it excludes itself.
						let after = String(((BigInt(Date.parse(since)) - EPOCH) << 22n) - 1n);
						// ponytail: 500 messages per window, oldest first; past that it repairs those and deletes nothing, so walk `before` from the newest if busy channels need it
						for (let page = 0; page < PAGES; page++) {
							const got = yield* rest(
								History,
								'GET',
								`${path}/messages?limit=${PAGE}&after=${after}`
							);
							const newest = got[0]?.['id'];
							// without READ_MESSAGE_HISTORY the answer is empty, not refused: nothing read proves nothing gone
							if (newest === undefined) return { messages, complete: page > 0 };
							after = String(newest);
							messages.push(
								...got
									.toReversed()
									.flatMap((message) =>
										discordDispatch('MESSAGE_CREATE', { ...message, guild_id }, botId, now)
									)
							);
						}
						return { messages, complete: false };
					}).pipe(
						// the engine ends its pass on a refusal: a channel the bot cannot read costs only that thread
						Effect.catchTag('ProviderRefused', () =>
							Effect.succeed({ messages: [], complete: false })
						)
					),
				// the typing indicator lapses by itself (10 s) or with the next message: nothing stops it early
				typing: (to: string, on: boolean) =>
					cred === null || !on || to.startsWith('@')
						? Effect.void
						: rest(Schema.Unknown, 'POST', `/channels/${encodeURIComponent(to)}/typing`).pipe(
								Effect.asVoid
							)
			};
		})
	};
}

/** One dispatch → the wire messages it carries: a create, an edit, or bare revokes (a bulk delete is several). */
function discordDispatch(
	t: string | null | undefined,
	d: Obj,
	botId: string,
	now: number
): readonly Obj[] {
	if (t === 'MESSAGE_DELETE' || t === 'MESSAGE_DELETE_BULK')
		return (t === 'MESSAGE_DELETE' ? [d['id']] : Array.isArray(d['ids']) ? d['ids'] : []).flatMap(
			(id) => (typeof id === 'string' ? [{ id, deleted: true }] : [])
		);
	// an update with no `edited_timestamp` is an unfurl or a pin: the text did not change
	if (t !== 'MESSAGE_CREATE' && (t !== 'MESSAGE_UPDATE' || str(d['edited_timestamp']) === null))
		return [];
	const message = discordMessage(d, botId, now);
	return message === null ? [] : [message];
}

/** One message object → the wire message, or `null` for a bot's (ours included) or an empty one. */
export function discordMessage(d: Obj, botId: string, now: number): Obj | null {
	const author = Predicate.isObject(d['author']) ? d['author'] : null,
		id = str(d['id']),
		thread = str(d['channel_id']),
		edited = str(d['edited_timestamp']);
	if (author === null || author['bot'] === true || id === null || thread === null) return null;
	const group = d['guild_id'] !== undefined && d['guild_id'] !== null;
	const mentions = (Array.isArray(d['mentions']) ? d['mentions'] : []).flatMap((m) =>
		Predicate.isObject(m) && typeof m['id'] === 'string' ? [m['id']] : []
	);
	const ref =
		Predicate.isObject(d['referenced_message']) &&
		Predicate.isObject(d['referenced_message']['author'])
			? d['referenced_message']['author']['id']
			: null;
	const attachments = (Array.isArray(d['attachments']) ? d['attachments'] : []).flatMap((a) =>
		Predicate.isObject(a) && typeof a['filename'] === 'string'
			? [
					{
						name: a['filename'],
						mime: str(a['content_type']) ?? 'application/octet-stream',
						bytes: Number(a['size'] ?? 0)
					}
				]
			: []
	);
	return {
		id,
		thread,
		sent_at: str(d['timestamp']) ?? new Date(now).toISOString(),
		text: typeof d['content'] === 'string' ? d['content'] : '',
		group,
		mentions,
		from: {
			handle: String(author['id']),
			name: str(author['global_name']) ?? str(author['username'])
		},
		reply_to: Predicate.isObject(d['message_reference'])
			? str(d['message_reference']['message_id'])
			: null,
		invocation: !group
			? 'direct'
			: mentions.includes(botId)
				? 'mention'
				: ref === botId
					? 'reply'
					: 'ambient',
		...(edited === null ? {} : { version: edited }),
		attachments
	};
}
