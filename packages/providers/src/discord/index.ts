// Discord gateway events and heartbeat live in the link's scope.
import {
	Clock,
	Effect,
	FiberHandle,
	Option,
	Queue,
	Schedule,
	Schema,
	Predicate,
	Stream
} from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import type { DriverOpen, Json, LinkStatus, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, ProviderUnavailable } from '../errors.ts';
import { blobOf, field, hostCall, str, storedCredential, withFetch, type Obj } from '../util.ts';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
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
const Message = Schema.Struct({ to: Schema.NonEmptyString, text: Schema.String });
class GatewayClosed extends Schema.TaggedError<GatewayClosed>()('GatewayClosed', {
	code: Schema.optionalKey(Schema.Number),
	message: Schema.String
}) {}
type GatewayEvent =
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
			let sequence: number | null = null;
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
								: yield* HttpClientResponse.schemaBodyJson(ObjectBody)(response).pipe(
										Effect.mapError(
											() => new ProviderUnavailable({ message: 'Discord response is malformed' })
										)
									);
						if (response.status >= 400)
							return yield* Effect.fail(
								answerFailure(
									`Discord ${method} ${path.replace(/\d{5,}/g, '…')}: ${response.status} ${String(value['message'] ?? '')}`.trim(),
									response.status,
									value['code'] === undefined ? undefined : String(value['code'])
								)
							);
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
					let socket: GatewaySocket | null = null;
					const events = Stream.callback<GatewayEvent, ProviderUnavailable>((queue) =>
						Effect.gen(function* () {
							const opened = yield* Effect.acquireRelease(
								Effect.try({
									try: () => socketOf(GATEWAY),
									catch: () =>
										new ProviderUnavailable({ message: 'Discord gateway could not open' })
								}),
								(opened) => Effect.sync(() => opened.close(1000))
							);
							socket = opened;
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
								if (event.kind === 'close')
									return yield* Effect.fail(
										new GatewayClosed({
											...(event.code === undefined ? {} : { code: event.code }),
											message: `gateway closed (${event.code ?? 'no code'})`
										})
									);
								const payload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload))(
									String(event.data)
								);
								if (Option.isNone(payload)) return;
								const frame = payload.value,
									data = Option.getOrElse(
										Schema.decodeUnknownOption(ObjectBody)(frame.d),
										(): Obj => ({})
									);
								if (typeof frame.s === 'number') sequence = frame.s;
								const current = socket;
								if (current === null) return;
								const send = (packet: Json) =>
									Effect.try({
										try: () => current.send(JSON.stringify(packet)),
										catch: () => new ProviderUnavailable({ message: 'Discord gateway send failed' })
									});
								if (frame.op === 10) {
									const interval =
										typeof data['heartbeat_interval'] === 'number'
											? data['heartbeat_interval']
											: 41250;
									yield* FiberHandle.run(
										heartbeat,
										Effect.suspend(() => send({ op: 1, d: sequence })).pipe(
											Effect.repeat(Schedule.spaced(interval)),
											Effect.asVoid
										)
									);
									yield* send({
										op: 2,
										d: {
											token: value.botToken,
											intents: INTENTS,
											properties: { os: 'linux', browser: 'norbital', device: 'norbital' }
										}
									});
								} else if (frame.op === 1) yield* send({ op: 1, d: sequence });
								else if (frame.op === 7 || frame.op === 9) current.close(4000);
								else if (frame.t === 'READY') {
									for (const guild of Array.isArray(data['guilds']) ? data['guilds'] : [])
										if (Predicate.isObject(guild) && typeof guild['id'] === 'string')
											guilds.add(guild['id']);
									yield* set('connected');
								} else if (frame.t === 'GUILD_CREATE' && typeof data['id'] === 'string') {
									guilds.add(data['id']);
									yield* report();
								} else if (frame.t === 'GUILD_DELETE' && typeof data['id'] === 'string') {
									guilds.delete(data['id']);
									yield* report();
								} else if (frame.t === 'MESSAGE_CREATE') {
									const message = discordMessage(data, value.botId, yield* Clock.currentTimeMillis);
									if (message !== null)
										yield* hostCall('store Discord message', () =>
											ctx.emit({ kind: 'messages', messages: [message] })
										).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
								}
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
								error._tag !== 'GatewayClosed' || (error.code !== 4004 && error.code !== 4014)
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
							return yield* Effect.fail(
								new ProviderUnavailable({ message: 'the Discord bot is not connected' })
							);
						const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
							Effect.mapError(() => answerFailure('a Discord message needs `to` and `text`', 400))
						);
						let body: Json | FormData = { content: m.text };
						if (files.length > 0) {
							const form = new FormData();
							form.set(
								'payload_json',
								JSON.stringify({
									content: m.text,
									attachments: files.map((file, id) => ({ id, filename: file.name }))
								})
							);
							files.forEach((file, index) => form.set(`files[${index}]`, blobOf(file), file.name));
							body = form;
						}
						return {
							providerId: (yield* rest(
								Sent,
								'POST',
								`/channels/${encodeURIComponent(m.to)}/messages`,
								body
							)).id
						};
					}),
				typing: (to: string) =>
					cred === null
						? Effect.void
						: rest(Schema.Unknown, 'POST', `/channels/${encodeURIComponent(to)}/typing`).pipe(
								Effect.asVoid
							)
			};
		})
	};
}

/** One MESSAGE_CREATE → the wire message, or `null` for a bot's (ours included) or an empty one. */
export function discordMessage(d: Obj, botId: string, now: number): Obj | null {
	const author = Predicate.isObject(d['author']) ? d['author'] : null,
		id = str(d['id']),
		thread = str(d['channel_id']);
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
		sentAt: str(d['timestamp']) ?? new Date(now).toISOString(),
		text: typeof d['content'] === 'string' ? d['content'] : '',
		group,
		mentions,
		from: {
			handle: String(author['id']),
			name: str(author['global_name']) ?? str(author['username'])
		},
		replyTo: Predicate.isObject(d['message_reference'])
			? str(d['message_reference']['message_id'])
			: null,
		invocation: !group
			? 'direct'
			: mentions.includes(botId)
				? 'mention'
				: ref === botId
					? 'reply'
					: 'ambient',
		attachments
	};
}
