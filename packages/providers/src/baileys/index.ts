// WhatsApp's patched receipt waits for a durable emit; SDK callbacks run in the link-owned FiberSet.
import {
	Cache,
	Cause,
	Clock,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberHandle,
	FiberSet,
	Option,
	Queue,
	Random,
	Result,
	Schedule,
	Schema,
	Semaphore,
	Predicate,
	Stream
} from 'effect';
import type {
	DriverEvent,
	DriverOpen,
	Json,
	LinkStatus,
	OutboundAttachment
} from '@norbital-ai/bolt/engine';
import type { GroupMetadata } from '@whiskeysockets/baileys';
import { FirstSyncs, ProviderRuntime, type ProviderDef } from '../abi.ts';
import { LinkClosed, PairingInvalid, ProviderUnavailable } from '../errors.ts';
import { hostCall, str, type Obj } from '../util.ts';

/** The part of a Baileys socket this adapter uses, read structurally. */
export type WaSocket = {
	// SDK event payloads enter as unknown and are decoded by the handler's actual schema.
	ev: { on(event: string, listener: (arg: unknown) => void): void };
	user?: { id: string; lid?: string } | undefined;
	/** The account's LID↔phone map. A group mention names our LID, and `user.lid` is optional and often absent. */
	signalRepository?:
		| {
				getLIDForPN?(pn: string): Promise<string | null>;
				lidMapping?: {
					getLIDForPN(pn: string): Promise<string | null>;
					getPNForLID(lid: string): Promise<string | null>;
				};
		  }
		| undefined;
	sendMessage(
		jid: string,
		content:
			| { text: string }
			| { image: Buffer; mimetype: string }
			| { document: Buffer; mimetype: string; fileName: string }
	): Promise<{ key?: { id?: string | null }; message?: unknown } | undefined>;
	sendPresenceUpdate?(type: 'composing' | 'paused', jid: string): Promise<void>;
	requestPairingCode(phone: string): Promise<string>;
	groupMetadata?(jid: string): Promise<GroupMetadata>;
	logout(): Promise<void>;
	end(error: Error | undefined): void | Promise<void>;
};
/** The instance's keys as Baileys' `auth` reads them: Json values (its Buffers encoded), written through. */
export type WaStore = {
	/** The paired creds, or `null` for a new pairing. */
	readonly creds: Json | null;
	get(type: string, ids: readonly string[]): { [id: string]: Json };
	/** One Baileys `keys.set` (`null` deletes): one statement once paired. */
	set(data: { readonly [type: string]: { readonly [id: string]: Json | null } }): Promise<void>;
	/** The whole creds after a `creds.update`. */
	update(creds: Json): Promise<void>;
};
/** Baileys' `CacheStore`. */
export type WaCache = {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	del(key: string): Promise<void>;
	flushAll(): Promise<void>;
};
/** What a link hands its socket. */
export type WaConfig = {
	store: WaStore;
	/** A personal account (full history, the desktop companion); a workspace one skips the full history. */
	personal: boolean;
	/** The patch's hook: resolves once the message is stored; a rejection withholds the receipt and ends the socket. */
	beforeReceipt(message: unknown, type: 'notify' | 'append'): Promise<void>;
	/** A message we sent, for a recipient's retry receipt (kept across reconnects). */
	getMessage(key: { id?: string | null }): Promise<unknown>;
	cachedGroupMetadata(jid: string): Promise<GroupMetadata | undefined>;
	msgRetryCounterCache: WaCache;
	/** SDK version lookup shares the link's Effect cache. */
	version(
		load: (signal: AbortSignal) => Promise<{ version: number[]; isLatest: boolean }>
	): Promise<number[]>;
};
/** A message's media: its name, type and size (`bytes`), and its `data` when it was downloaded (`null`: too large, or not fetched). */
export type WaMedia = { name: string; mime: string; bytes: number; data: Uint8Array | null };
export type WaOpen = (c: WaConfig) => Promise<{
	socket: WaSocket;
	media(message: unknown, download: boolean): Promise<WaMedia | null>;
}>;
const CREDS = 'creds';
const MEDIA_MAX = 32 * 1024 * 1024;
export type BaileysOptions = {
	open?: WaOpen;
	/** How long a closing link waits for messages in flight to land (default 10 s). */
	graceMs?: number;
	/** How long an emit is retried in place before the socket ends unreceipted (default 30 s). */
	retryMs?: number;
	/** How long opening a socket may take (default 60 s). */
	openMs?: number;
};

export function baileys(o: BaileysOptions = {}): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'whatsapp',
		personal: true,
		id: 'baileys',
		name: 'WhatsApp',
		icon: 'simple-icons:whatsapp',
		description: { en: 'Sync messages from your phone', zh: '同步手机中的消息' },
		label: { en: 'Unofficial (WhatsApp Web)', zh: '非官方（WhatsApp 网页版）' },
		setup: {
			kind: 'qr',
			steps: [
				{
					text: {
						en: 'Use a WhatsApp account for this integration only: linking it here is how WhatsApp Web works, and WhatsApp may restrict accounts it sees automating.',
						zh: '请为此集成单独使用一个 WhatsApp 账号：在此关联即 WhatsApp 网页版的工作方式，WhatsApp 可能限制其判定为自动化的账号。'
					}
				},
				{
					text: {
						en: 'On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR shown here.',
						zh: '在手机上：WhatsApp → 设置 → 已关联的设备 → 关联新设备，然后扫描此处显示的二维码。'
					}
				}
			],
			fields: [
				{
					name: 'phone',
					label: { en: 'Phone number', zh: '手机号码' },
					optional: true,
					hint: {
						en: 'Digits, country code first — to pair with a code instead of the QR',
						zh: '仅数字，国家代码在前——用代码代替二维码配对'
					}
				}
			]
		},
		// a message to the connected account itself: "Message yourself" on the phone
		test: {},
		open: (ctx) => link(ctx, o)
	};
}

const digits = (jid: string | undefined) => jid?.split(':')[0]?.split('@')[0] ?? null;
const jidOf = (to: string) => (to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`);
const paired = (creds: Json | null) =>
	Predicate.isObject(creds) && creds['account'] !== undefined && creds['account'] !== null;
const synced = (creds: Json | null) =>
	Predicate.isObject(creds) && Number(creds['accountSyncCounter'] ?? 0) > 0;
type Supervisor = Data.TaggedEnum<{
	Idle: {};
	Pairing: {};
	Connecting: {};
	CatchingUp: {};
	Connected: {};
	Backoff: {};
	Terminal: { readonly code: string; readonly error: string };
}>;
const Supervisor = Data.taggedEnum<Supervisor>();
const TRANSITIONS: { readonly [Phase in Supervisor['_tag']]: readonly Supervisor['_tag'][] } = {
	Idle: ['Idle', 'Connecting', 'Pairing', 'Terminal'],
	Pairing: ['Pairing', 'Connecting', 'CatchingUp', 'Backoff', 'Terminal', 'Idle'],
	Connecting: ['Pairing', 'CatchingUp', 'Backoff', 'Terminal', 'Idle', 'Connecting'],
	CatchingUp: ['Connected', 'Backoff', 'Terminal', 'Connecting', 'Idle'],
	Connected: ['Backoff', 'Terminal', 'Connecting', 'Idle'],
	Backoff: ['Connecting', 'Terminal', 'Idle'],
	Terminal: ['Idle', 'Terminal']
};
type Classified =
	| { kind: 'terminal'; code: string; error: string; clear?: true }
	| { kind: 'restart' }
	| { kind: 'backoff'; floor?: number; cap?: number };
const loggedOut = (): Classified => ({
	kind: 'terminal',
	code: 'loggedOut',
	error: 'WhatsApp logged this device out. Pair again.',
	clear: true
});
const CLASSIFIERS: Readonly<Record<number, (wasPaired: boolean) => Classified>> = {
	401: loggedOut,
	419: loggedOut,
	403: () => ({
		kind: 'terminal',
		code: 'forbidden',
		error:
			'WhatsApp refused this account; it may be restricted. Check it on the phone before pairing again.'
	}),
	411: () => ({
		kind: 'terminal',
		code: 'unsupported',
		error:
			'This account cannot link a device this way. Update WhatsApp on the phone, then pair again.'
	}),
	440: () => ({
		kind: 'terminal',
		code: 'replaced',
		error:
			'Another session opened this account, so this one stopped. Pair it again here to take it back.'
	}),
	515: () => ({ kind: 'restart' }),
	503: () => ({ kind: 'backoff', floor: 30000, cap: 600000 }),
	408: (wasPaired) =>
		wasPaired
			? { kind: 'backoff' }
			: {
					kind: 'terminal',
					code: 'pairingExpired',
					error: 'The pairing expired before the phone linked. Pair again.'
				},
	428: () => ({ kind: 'backoff' }),
	500: () => ({ kind: 'backoff' })
};
export const classify = (code: number | undefined, wasPaired: boolean): Classified =>
	code === undefined
		? { kind: 'backoff' }
		: (CLASSIFIERS[code]?.(wasPaired) ??
			(code >= 400 && code < 500
				? {
						kind: 'terminal',
						code: `failure:${code}`,
						error: `WhatsApp refused the connection (${code}). Pair again.`
					}
				: { kind: 'backoff' }));
class Disconnected extends Schema.TaggedError<Disconnected>()('WhatsAppDisconnected', {
	code: Schema.optionalKey(Schema.Number),
	message: Schema.String,
	lastDisconnect: Schema.Json
}) {}
const Connection = Schema.Struct({
	connection: Schema.optionalKey(Schema.String),
	qr: Schema.optionalKey(Schema.String),
	receivedPendingNotifications: Schema.optionalKey(Schema.Boolean),
	lastDisconnect: Schema.optionalKey(
		Schema.Struct({
			error: Schema.optionalKey(
				Schema.Struct({
					output: Schema.optionalKey(
						Schema.Struct({ statusCode: Schema.optionalKey(Schema.Number) })
					),
					message: Schema.optionalKey(Schema.String)
				})
			)
		})
	)
});
const Imported = Schema.Struct({
	messages: Schema.Array(Schema.Unknown),
	requestId: Schema.optionalKey(Schema.String)
});
const Group = Schema.Struct({
	id: Schema.String,
	owner: Schema.UndefinedOr(Schema.String),
	subject: Schema.String,
	participants: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			phoneNumber: Schema.optionalKey(Schema.String),
			name: Schema.optionalKey(Schema.String),
			notify: Schema.optionalKey(Schema.String)
		})
	),
	addressingMode: Schema.optionalKey(Schema.Literals(['lid', 'pn'])),
	ephemeralDuration: Schema.optionalKey(Schema.Number)
});
const Outbound = Schema.Struct({ to: Schema.NonEmptyString, text: Schema.String });
export const InboundMessage = Schema.Struct({
	id: Schema.String,
	thread: Schema.String,
	sentAt: Schema.String,
	from: Schema.Struct({ handle: Schema.String, name: Schema.NullOr(Schema.String) }),
	text: Schema.String,
	group: Schema.Boolean,
	attachments: Schema.Array(Schema.JsonObject),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
	mentions: Schema.optionalKey(Schema.Array(Schema.String)),
	title: Schema.optionalKey(Schema.String),
	participants: Schema.optionalKey(
		Schema.Array(Schema.Struct({ handle: Schema.String, name: Schema.NullOr(Schema.String) }))
	),
	direction: Schema.optionalKey(Schema.Literals(['inbound', 'outbound'])),
	version: Schema.optionalKey(Schema.String),
	deleted: Schema.optionalKey(Schema.Boolean)
});

const keyStore = Effect.fn('WhatsApp.keyStore')(function* (
	ctx: DriverOpen,
	loaded: ReadonlyMap<string, Json>,
	onFence: Effect.Effect<void>
) {
	const keys = new Map<string, Json>();
	let creds: Json | null = null,
		dirty = false,
		first = false;
	for (const [key, value] of loaded)
		if (key === CREDS) creds = value;
		else keys.set(key, value);
	let held = paired(creds);
	const writes = yield* Semaphore.make(1);
	const seal = (changes: ReadonlyMap<string, Json | null>) =>
		Effect.uninterruptible(
			hostCall('store WhatsApp credentials', () => ctx.credentials.write(changes))
		).pipe(
			Effect.catchTag('Fenced', (error) =>
				onFence.pipe(Effect.andThen(Effect.fail(new LinkClosed({ message: error.message }))))
			)
		);
	const flush = writes.withPermit(
		Effect.suspend(() => {
			if (!held || !dirty) return Effect.void;
			const changes = new Map<string, Json | null>([[CREDS, creds], ...(first ? keys : [])]);
			const initial = first;
			first = false;
			dirty = false;
			return seal(changes).pipe(
				Effect.tapError(() =>
					Effect.sync(() => {
						dirty = true;
						first = initial;
					})
				)
			);
		})
	);
	return {
		get creds() {
			return creds;
		},
		get paired() {
			return held;
		},
		get(type: string, ids: readonly string[]): Record<string, Json> {
			const out: Record<string, Json> = {};
			for (const id of ids) {
				const value = keys.get(`${type}:${id}`);
				if (value !== undefined) out[id] = value;
			}
			return out;
		},
		set: (data: { readonly [type: string]: { readonly [id: string]: Json | null } }) =>
			Effect.suspend(() => {
				const changes = new Map<string, Json | null>();
				for (const [type, byId] of Object.entries(data))
					for (const [id, value] of Object.entries(byId)) {
						const key = `${type}:${id}`;
						if (value === null) keys.delete(key);
						else keys.set(key, value);
						changes.set(key, value);
					}
				return held && changes.size > 0 ? writes.withPermit(seal(changes)) : Effect.void;
			}),
		update: (next: Json) =>
			Effect.suspend(() => {
				creds = next;
				dirty = true;
				if (!held && paired(next)) {
					held = true;
					first = true;
				}
				return held ? flush : Effect.void;
			}),
		flush,
		settled: writes.withPermit(Effect.void),
		clear: writes.withPermit(
			Effect.suspend(() => {
				const names = [...keys.keys(), ...(creds === null ? [] : [CREDS])];
				keys.clear();
				creds = null;
				held = false;
				dirty = false;
				first = false;
				return names.length === 0 ? Effect.void : seal(new Map(names.map((name) => [name, null])));
			})
		)
	};
});

const link = Effect.fn('WhatsApp.open')(function* (ctx: DriverOpen, options: BaileysOptions) {
	type Opened = Awaited<ReturnType<WaOpen>>;
	const open = options.open ?? baileysSocket,
		firstSyncs = yield* FirstSyncs,
		callbackRun = yield* ProviderRuntime;
	const callbacks = yield* FiberSet.make(),
		histories = yield* FiberSet.make(),
		supervisor = yield* FiberHandle.make<void>();
	// External SDK Promise callbacks run only here and are interrupted with this link's scope.
	const sdk = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
		callbackRun(
			Effect.gen(function* () {
				const fiber = yield* FiberSet.run(callbacks, effect);
				return yield* Fiber.join(fiber);
			})
		);
	let current: Opened | undefined,
		phase: Supervisor = Supervisor.Idle(),
		closing = false,
		account: string | null = null,
		lid: string | undefined,
		attempt = 0,
		openedAt = 0,
		restartingAfterPairing = false;
	const status = (value: LinkStatus) => hostCall('report WhatsApp status', () => ctx.status(value));
	const transition = (next: Supervisor) =>
		Effect.suspend(() =>
			TRANSITIONS[phase._tag].includes(next._tag)
				? Effect.sync(() => {
						phase = next;
					})
				: Effect.die(`invalid WhatsApp supervisor transition ${phase._tag} → ${next._tag}`)
		);
	const terminal = (code: string, error: string, lastDisconnect?: Json) =>
		Effect.gen(function* () {
			yield* transition(Supervisor.Terminal({ code, error }));
			yield* status({
				state: 'error',
				code,
				error,
				...(lastDisconnect === undefined ? {} : { lastDisconnect })
			});
			const socket = current?.socket;
			if (socket !== undefined)
				yield* hostCall('end terminal WhatsApp socket', () =>
					Promise.resolve(socket.end(undefined))
				).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		});
	const store = yield* keyStore(
		ctx,
		yield* hostCall('read WhatsApp credentials', () => ctx.credentials.load()),
		Effect.suspend(() => terminal('replaced', 'the link was replaced')).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.ignore
		)
	);
	const sent = yield* Cache.make({
		capacity: 2000,
		lookup: (_key: string) => Effect.succeed<unknown>(undefined),
		timeToLive: '24 hours'
	});
	const retries = yield* Cache.make({
		capacity: 2000,
		lookup: (_key: string) => Effect.succeed<unknown>(undefined),
		timeToLive: '1 hour'
	});
	let loadVersion:
		((signal: AbortSignal) => Promise<{ version: number[]; isLatest: boolean }>) | undefined;
	const versions = yield* Cache.makeWith(
		(_key: undefined) =>
			Effect.suspend(() => {
				const load = loadVersion;
				return load === undefined
					? Effect.fail(
							new ProviderUnavailable({ message: 'WhatsApp version source is unavailable' })
						)
					: hostCall('read WhatsApp version', load).pipe(
							Effect.timeoutOrElse({
								duration: '5 seconds',
								orElse: () =>
									Effect.fail(
										new ProviderUnavailable({ message: 'WhatsApp version lookup timed out' })
									)
							})
						);
			}),
		{
			capacity: 1,
			timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value.isLatest ? '1 hour' : 0)
		}
	);
	const groups = yield* Cache.makeWith(
		(jid: string) =>
			Effect.gen(function* () {
				const socket = current?.socket;
				if (socket?.groupMetadata === undefined) return undefined;
				const load = socket.groupMetadata;
				const value = yield* hostCall('read WhatsApp group', () => load.call(socket, jid));
				yield* Schema.decodeUnknownEffect(Group)(value).pipe(
					Effect.mapError(
						() => new ProviderUnavailable({ message: 'WhatsApp group metadata is malformed' })
					)
				);
				// Keep SDK metadata, including its addressing mode and expiration, intact after validation.
				return value;
			}),
		{
			capacity: 2000,
			timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== undefined ? Infinity : 0)
		}
	);
	const historySerial = yield* Semaphore.make(1);
	const emitting = (event: DriverEvent) =>
		hostCall('store WhatsApp message', () => ctx.emit(event)).pipe(
			Effect.tapError((error) =>
				error._tag === 'Fenced' ? terminal('replaced', error.message) : Effect.logWarning(error)
			),
			Effect.retry({
				schedule: Schedule.max([
					Schedule.min([Schedule.exponential('250 millis'), Schedule.spaced('5 seconds')]),
					Schedule.during(options.retryMs ?? 30000)
				]),
				while: (error) => error._tag !== 'Fenced' && !ctx.signal.aborted
			})
		);
	const groupOf = (jid: string) =>
		Cache.get(groups, jid).pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.orElseSucceed(() => undefined)
		);
	const resolvePhone = (socket: WaSocket, jid: string) => {
		const mapping = socket.signalRepository?.lidMapping;
		return mapping === undefined
			? Effect.succeed(jid)
			: hostCall('resolve WhatsApp phone', () => mapping.getPNForLID(jid)).pipe(
					Effect.orElseSucceed(() => null)
				);
	};
	const wire = (got: Opened, raw: unknown, live: boolean) =>
		Effect.gen(function* () {
			const found = whatsappMessage(raw, got.socket.user?.id, {
				includeSent: ctx.personal,
				...(lid === undefined ? {} : { lid })
			});
			if (found === null) return null;
			const group = found['group'] === true ? yield* groupOf(String(found['thread'])) : undefined;
			const participants =
				group?.participants === undefined || !ctx.personal
					? undefined
					: yield* Effect.forEach(
							group.participants,
							(participant) =>
								Effect.gen(function* () {
									const handle =
										participant.phoneNumber ??
										(participant.id.endsWith('@lid')
											? ((yield* resolvePhone(got.socket, participant.id)) ?? participant.id)
											: participant.id);
									return { handle, name: participant.name ?? participant.notify ?? null };
								}),
							{ concurrency: 'unbounded' }
						);
			const sender = Predicate.isObject(found['from']) ? str(found['from']['handle']) : null;
			const phone = sender?.endsWith('@lid') ? yield* resolvePhone(got.socket, sender) : sender;
			const media = yield* hostCall('read WhatsApp media', () => got.media(raw, live));
			if (found['text'] === '' && media === null && found['deleted'] !== true) return null;
			const message = yield* Schema.decodeUnknownEffect(InboundMessage)({
				...found,
				...(phone?.endsWith('@s.whatsapp.net') && Predicate.isObject(found['from'])
					? {
							from: { ...found['from'], handle: phone },
							...(found['group'] === true
								? {}
								: { thread: phone.replace(/:\d+(?=@s\.whatsapp\.net$)/, '') })
						}
					: {}),
				...(group?.subject ? { title: group.subject } : {}),
				...(participants === undefined ? {} : { participants }),
				...(media === null
					? {}
					: {
							attachments: [
								{
									name: media.name,
									mime: media.mime,
									bytes: media.bytes,
									...(media.data === null ? {} : { bin: 0 })
								}
							]
						})
			}).pipe(
				Effect.mapError(
					() => new ProviderUnavailable({ message: 'WhatsApp message failed validation' })
				)
			);
			return { message, ...(media?.data ? { bins: [media.data] } : {}) };
		});
	const imported = (got: Opened, raws: readonly unknown[], backfill: boolean) =>
		FiberSet.run(
			histories,
			historySerial
				.withPermit(
					Effect.gen(function* () {
						const messages: Json[] = [];
						for (const raw of raws) {
							const found = yield* wire(got, raw, !backfill);
							if (found === null) continue;
							if (found.bins === undefined) messages.push(found.message);
							else
								yield* emitting({
									kind: 'messages',
									messages: [found.message],
									bins: found.bins,
									...(backfill ? { history: true } : {})
								});
						}
						if (messages.length > 0)
							yield* emitting({
								kind: 'messages',
								messages,
								...(backfill ? { history: true } : {})
							});
					})
				)
				.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		).pipe(Effect.asVoid);
	// WhatsApp has acknowledged history before this event reaches us. Enqueue it synchronously so close drains even
	// an event the stream consumer has not handled yet; the FiberSet owns every resulting durable import.
	const acknowledged = yield* Queue.unbounded<
		{ got: Opened; messages: readonly unknown[]; history: boolean },
		Cause.Done
	>();
	const historyWorker = yield* Stream.fromQueue(acknowledged).pipe(
		Stream.runForEach((chunk) => imported(chunk.got, chunk.messages, chunk.history)),
		Effect.forkScoped
	);

	const session = (phone?: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* transition(Supervisor.Connecting());
				yield* status({
					state: 'connecting',
					detail: restartingAfterPairing
						? 'restarting after pairing'
						: `opening the socket (attempt ${attempt + 1})`,
					...(account === null ? {} : { account })
				});
				restartingAfterPairing = false;
				const syncedGate = yield* Deferred.make<void>(),
					held = yield* FiberHandle.make<void>(),
					catchUp = yield* FiberHandle.make<void>();
				if (store.paired && !synced(store.creds)) {
					const acquired = yield* Deferred.make<void>();
					yield* FiberHandle.run(
						held,
						firstSyncs.withPermit(
							Deferred.succeed(acquired, undefined).pipe(
								Effect.andThen(Deferred.await(syncedGate)),
								Effect.timeoutOption('2 minutes'),
								Effect.asVoid
							)
						)
					);
					yield* Deferred.await(acquired);
				}
				const config: WaConfig = {
					store: {
						get creds() {
							return store.creds;
						},
						get: store.get,
						set: (data) => sdk(store.set(data)),
						update: (creds) => sdk(store.update(creds))
					},
					personal: ctx.personal,
					beforeReceipt: (raw) =>
						sdk(
							Effect.gen(function* () {
								const got = current;
								if (closing || got === undefined || phase._tag === 'Terminal')
									return yield* Effect.fail(
										new LinkClosed({ message: 'the WhatsApp link is closing' })
									);
								const found = yield* wire(got, raw, true);
								if (found !== null)
									yield* emitting({
										kind: 'messages',
										messages: [found.message],
										...(found.bins === undefined ? {} : { bins: found.bins })
									});
							})
						),
					getMessage: (key) => sdk(Cache.get(sent, key.id ?? '')),
					cachedGroupMetadata: (jid) => sdk(groupOf(jid)),
					msgRetryCounterCache: {
						get: (key) => sdk(Cache.get(retries, key)),
						set: (key, value) => sdk(Cache.set(retries, key, value)),
						del: (key) => sdk(Cache.invalidate(retries, key)),
						flushAll: () => sdk(Cache.invalidateAll(retries))
					},
					version: (load) => {
						loadVersion = load;
						return sdk(Cache.get(versions, undefined).pipe(Effect.map((value) => value.version)));
					}
				};
				const got = yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: (signal) => {
							const pending = open(config);
							void pending.then(
								(late) =>
									signal.aborted
										? Promise.resolve(late.socket.end(undefined)).catch((error) =>
												console.warn('[providers] late WhatsApp socket did not end', error)
											)
										: undefined,
								() => undefined
							);
							return pending;
						},
						catch: (error) =>
							new ProviderUnavailable({
								message: `the socket did not open: ${error instanceof Error ? error.message : 'SDK refused'}`
							})
					}).pipe(
						Effect.timeoutOrElse({
							duration: options.openMs ?? 60000,
							orElse: () =>
								Effect.fail(
									new ProviderUnavailable({
										message: 'the socket did not open within its deadline'
									})
								)
						})
					),
					(got) =>
						hostCall('end WhatsApp socket', () => Promise.resolve(got.socket.end(undefined))).pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.ignore,
							Effect.tap(() =>
								Effect.sync(() => {
									if (current === got) current = undefined;
								})
							)
						)
				);
				current = got;
				let codeAsked = false;
				const connected = () =>
					Effect.gen(function* () {
						if (current !== got || phase._tag !== 'CatchingUp') return;
						yield* transition(Supervisor.Connected());
						yield* status({
							state: 'connected',
							account,
							about: account === null ? {} : { account }
						});
					});
				const events = Stream.callback<{ type: string; value: unknown }>((queue) =>
					Effect.sync(() => {
						for (const type of [
							'connection.update',
							'creds.update',
							'group-participants.update',
							'groups.update',
							'messaging-history.set',
							'messages.upsert',
							'messages.update',
							'message-receipt.update'
						])
							got.socket.ev.on(type, (value: unknown) => {
								if (current !== got || closing) return;
								// The scoped SDK runner starts synchronous invalidation before the next receipt callback.
								if (type === 'group-participants.update') {
									const decoded = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(
										value
									);
									if (Option.isSome(decoded)) void sdk(Cache.invalidate(groups, decoded.value.id));
									return;
								}
								if (type === 'groups.update') {
									const decoded = Schema.decodeUnknownOption(
										Schema.Array(Schema.Struct({ id: Schema.optionalKey(Schema.String) }))
									)(value);
									if (Option.isSome(decoded))
										for (const group of decoded.value)
											if (group.id !== undefined) void sdk(Cache.invalidate(groups, group.id));
									return;
								}
								if (type === 'messaging-history.set' || type === 'messages.upsert') {
									const decoded = Schema.decodeUnknownOption(Imported)(value);
									if (
										Option.isSome(decoded) &&
										(type === 'messaging-history.set' || decoded.value.requestId !== undefined)
									)
										Queue.offerUnsafe(acknowledged, {
											got,
											messages: decoded.value.messages,
											history: type === 'messaging-history.set'
										});
								} else Queue.offerUnsafe(queue, { type, value });
							});
					})
				);
				yield* events.pipe(
					Stream.runForEach(({ type, value }) =>
						Effect.gen(function* () {
							if (type === 'connection.update') {
								const decoded = Schema.decodeUnknownOption(Connection)(value);
								if (Option.isNone(decoded)) return;
								const update = decoded.value;
								if (update.qr !== undefined) {
									const qr = update.qr;
									if (phone === undefined || codeAsked) {
										yield* transition(Supervisor.Pairing());
										yield* Effect.sync(() => ctx.pairing({ kind: 'qr', value: qr }));
										yield* status({ state: 'pairing' });
									} else {
										codeAsked = true;
										const code = yield* hostCall('request WhatsApp pairing code', () =>
											got.socket.requestPairingCode(phone)
										).pipe(Effect.orElseSucceed(() => qr));
										yield* transition(Supervisor.Pairing());
										yield* Effect.sync(() =>
											ctx.pairing({ kind: code === qr ? 'qr' : 'code', value: code })
										);
										yield* status({ state: 'pairing' });
									}
								}
								if (update.connection === 'open') {
									account = digits(got.socket.user?.id);
									openedAt = yield* Clock.currentTimeMillis;
									yield* transition(Supervisor.CatchingUp());
									const repository = got.socket.signalRepository;
									const mapped = yield* hostCall(
										'read WhatsApp LID',
										() =>
											repository?.lidMapping?.getLIDForPN(got.socket.user?.id ?? '') ??
											repository?.getLIDForPN?.(got.socket.user?.id ?? '') ??
											Promise.resolve(null)
									).pipe(Effect.orElseSucceed(() => null));
									lid = got.socket.user?.lid ?? mapped ?? undefined;
									yield* status({
										state: 'connecting',
										detail: 'catching up on missed messages',
										...(account === null ? {} : { account })
									});
									yield* FiberHandle.run(catchUp, connected().pipe(Effect.delay('30 seconds')));
								}
								if (update.receivedPendingNotifications) {
									yield* FiberHandle.clear(catchUp);
									yield* connected();
								}
								if (update.connection === 'close') {
									const code = update.lastDisconnect?.error?.output?.statusCode,
										message = update.lastDisconnect?.error?.message ?? 'closed';
									return yield* Effect.fail(
										new Disconnected({
											...(code === undefined ? {} : { code }),
											message,
											lastDisconnect: {
												code: code ?? null,
												message,
												at: new Date(yield* Clock.currentTimeMillis).toISOString()
											}
										})
									);
								}
							} else if (type === 'creds.update') {
								if (synced(store.creds)) yield* Deferred.succeed(syncedGate, undefined);
							} else if (type === 'messages.update' || type === 'message-receipt.update') {
								const decoded = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(value);
								if (Option.isSome(decoded)) {
									const now = yield* Clock.currentTimeMillis;
									for (const item of decoded.value) {
										const receipt =
											type === 'messages.update'
												? baileysReceipt(item, now)
												: baileysGroupReceipt(item, now);
										if (receipt !== null)
											yield* hostCall('store WhatsApp receipt', () =>
												ctx.emit({ kind: 'delivery', ...receipt })
											).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
									}
								}
							}
						})
					)
				);
			})
		);
	const backoff = Schedule.spaced('2 seconds').pipe(
		Schedule.modifyDelay(({ input }) =>
			Effect.gen(function* () {
				const action: Classified =
					input instanceof Disconnected ? classify(input.code, store.paired) : { kind: 'backoff' };
				if (action.kind === 'restart') return 0;
				if (openedAt > 0 && (yield* Clock.currentTimeMillis) - openedAt >= 60000) attempt = 0;
				const floor = action.kind === 'backoff' ? (action.floor ?? 0) : 0,
					cap = action.kind === 'backoff' ? (action.cap ?? 120000) : 120000;
				const ceiling = Math.min(cap, Math.max(2000, floor) * 2 ** attempt++);
				return Math.max(floor, (yield* Random.next) * ceiling);
			})
		)
	);
	const start = (phone?: string) =>
		FiberHandle.run(
			supervisor,
			session(phone).pipe(
				Effect.tapError((error) =>
					Effect.gen(function* () {
						if (phase._tag === 'Terminal' || closing) return;
						const action: Classified =
							error._tag === 'WhatsAppDisconnected'
								? classify(error.code, store.paired)
								: { kind: 'backoff' };
						if (action.kind === 'terminal') {
							if (action.clear) yield* store.clear;
							yield* terminal(
								action.code,
								action.error,
								error._tag === 'WhatsAppDisconnected' ? error.lastDisconnect : undefined
							);
						} else if (action.kind === 'restart') {
							yield* store.flush;
							restartingAfterPairing = true;
						} else {
							yield* transition(Supervisor.Backoff());
							yield* status({
								state: 'reconnecting',
								detail: error.message,
								lastDisconnect:
									error._tag === 'WhatsAppDisconnected'
										? error.lastDisconnect
										: {
												code: null,
												message: error.message,
												at: new Date(yield* Clock.currentTimeMillis).toISOString()
											}
							});
						}
					})
				),
				Effect.retry({ schedule: backoff, while: () => !closing && phase._tag !== 'Terminal' }),
				Effect.tapCause(Effect.logWarning),
				Effect.ignore
			)
		).pipe(Effect.asVoid);
	if (store.paired) yield* start();
	else yield* status({ state: 'unpaired' });
	return {
		pair: (input: Json) =>
			Effect.gen(function* () {
				const phone = Predicate.isObject(input)
					? str(input['phone'])?.replace(/\D/g, '')
					: undefined;
				if (phone !== undefined && phone !== null && !/^\d{6,15}$/.test(phone))
					return yield* Effect.fail(
						new PairingInvalid({ message: 'a pairing phone is digits, country code first' })
					);
				yield* FiberHandle.clear(supervisor);
				yield* store.clear;
				closing = false;
				attempt = 0;
				restartingAfterPairing = false;
				account = null;
				yield* transition(Supervisor.Idle());
				yield* start(phone ?? undefined);
			}),
		unpair: () =>
			Effect.gen(function* () {
				closing = true;
				const socket = current?.socket;
				if (socket !== undefined)
					yield* hostCall('log out WhatsApp', () => socket.logout()).pipe(
						Effect.tapCause(Effect.logWarning),
						Effect.ignore
					);
				yield* FiberHandle.clear(supervisor);
				yield* FiberSet.awaitEmpty(callbacks);
				yield* store.settled;
			}),
		close: Effect.gen(function* () {
			closing = true;
			yield* FiberSet.awaitEmpty(callbacks).pipe(Effect.timeoutOption(options.graceMs ?? 10000));
			yield* FiberHandle.clear(supervisor);
			yield* Queue.end(acknowledged);
			yield* Fiber.join(historyWorker);
			yield* FiberSet.awaitEmpty(histories);
			yield* FiberSet.clear(callbacks);
			yield* store.flush.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		}),
		send: (message: Json, files: readonly OutboundAttachment[] = []) =>
			Effect.gen(function* () {
				const socket = current?.socket;
				if (socket === undefined || (phase._tag !== 'Connected' && phase._tag !== 'CatchingUp'))
					return yield* Effect.fail(
						new ProviderUnavailable({ message: 'the WhatsApp session is not open' })
					);
				const outbound = yield* Schema.decodeUnknownEffect(Outbound)(message).pipe(
					Effect.mapError(
						() => new PairingInvalid({ message: 'a WhatsApp message needs `to` and `text`' })
					)
				);
				const remember = (result: Awaited<ReturnType<WaSocket['sendMessage']>>) =>
					Effect.gen(function* () {
						const id = result?.key?.id;
						if (typeof id === 'string' && result?.message !== undefined && result.message !== null)
							yield* Cache.set(sent, id, result.message);
						return id;
					});
				const jid = jidOf(outbound.to),
					id = yield* remember(
						yield* hostCall('send WhatsApp message', () =>
							socket.sendMessage(jid, { text: outbound.text })
						)
					);
				for (const file of files)
					yield* remember(
						yield* hostCall('send WhatsApp attachment', () =>
							socket.sendMessage(
								jid,
								file.mime.startsWith('image/')
									? { image: Buffer.from(file.bytes), mimetype: file.mime }
									: { document: Buffer.from(file.bytes), mimetype: file.mime, fileName: file.name }
							)
						)
					);
				if (typeof id !== 'string')
					return yield* Effect.fail(
						new ProviderUnavailable({ message: 'WhatsApp returned no message id' })
					);
				return { providerId: id };
			}),
		typing: (to: string) =>
			Effect.suspend(() => {
				const socket = current?.socket;
				return socket !== undefined &&
					socket.sendPresenceUpdate !== undefined &&
					phase._tag === 'Connected'
					? hostCall(
							'WhatsApp typing',
							() => socket.sendPresenceUpdate?.('composing', jidOf(to)) ?? Promise.resolve()
						)
					: Effect.void;
			})
	};
});

type Report = Extract<DriverEvent, { kind: 'delivery' }>['report'];
/** WhatsApp's `WebMessageInfo.Status`: ERROR, PENDING, SERVER_ACK, DELIVERY_ACK, READ, PLAYED. */
const RECEIPT: { readonly [status: number]: Report['kind'] } = {
	0: 'failed',
	2: 'sent',
	3: 'delivered',
	4: 'read',
	5: 'read'
};
/** One `messages.update` entry on a message we sent → its delivery report, or `null` (someone else's message, no status change). */
export function baileysReceipt(
	u: unknown,
	now: number
): { providerId: string; report: Report } | null {
	if (
		!Predicate.isObject(u) ||
		!Predicate.isObject(u['key']) ||
		u['key']['fromMe'] !== true ||
		!Predicate.isObject(u['update'])
	)
		return null;
	const id = str(u['key']['id']),
		status = u['update']['status'];
	const kind = typeof status === 'number' ? RECEIPT[status] : undefined;
	if (id === null || kind === undefined) return null;
	return {
		providerId: id,
		report: {
			kind,
			at: new Date(now).toISOString(),
			provider: 'baileys',
			...(kind === 'failed' ? { reason: 'WhatsApp reported an error' } : {})
		}
	};
}
/** One `message-receipt.update` entry (a group member's receipt on a message we sent) → its delivery report, or `null`. */
export function baileysGroupReceipt(
	u: unknown,
	now: number
): { providerId: string; report: Report } | null {
	if (
		!Predicate.isObject(u) ||
		!Predicate.isObject(u['key']) ||
		u['key']['fromMe'] !== true ||
		!Predicate.isObject(u['receipt'])
	)
		return null;
	const id = str(u['key']['id']),
		r = u['receipt'];
	const set = (k: string) => r[k] !== undefined && r[k] !== null;
	const kind =
		set('readTimestamp') || set('playedTimestamp')
			? 'read'
			: set('receiptTimestamp')
				? 'delivered'
				: undefined;
	return id === null || kind === undefined
		? null
		: { providerId: id, report: { kind, at: new Date(now).toISOString(), provider: 'baileys' } };
}

/** One Baileys `WAMessage` (read structurally) → the wire message, or `null` (our own echo, a receipt, an empty message). */
export function whatsappMessage(
	msg: unknown,
	self: string | undefined,
	options: { lid?: string; includeSent?: boolean } = {}
): Obj | null {
	if (
		!Predicate.isObject(msg) ||
		!Predicate.isObject(msg['key']) ||
		(msg['key']['fromMe'] === true && options.includeSent !== true)
	)
		return null;
	const key = msg['key'],
		jid = str(key['remoteJid']),
		id = str(key['id']),
		content = msg['message'];
	const ts = Number(msg['messageTimestamp']);
	if (jid === null || id === null || !Predicate.isObject(content) || !Number.isFinite(ts))
		return null;
	const group = jid.endsWith('@g.us');
	const sentAt = new Date(ts * 1000).toISOString();
	const alternate = str(key['remoteJidAlt']);
	const from = {
		handle: group
			? (str(key['participantPn']) ?? str(key['participant']) ?? jid)
			: alternate?.endsWith('@s.whatsapp.net')
				? alternate
				: jid,
		name: str(msg['pushName'])?.trim() ?? null
	};
	const base = {
		thread:
			!group && from.handle.endsWith('@s.whatsapp.net')
				? from.handle.replace(/:\d+(?=@s\.whatsapp\.net$)/, '')
				: jid,
		sentAt,
		from,
		group,
		attachments: [],
		...(options.includeSent === true
			? { direction: key['fromMe'] === true ? 'outbound' : 'inbound' }
			: {})
	};
	// a sender's revoke tombstones the message; an edit converges its text (the target id is the edited message's)
	const protocol = content['protocolMessage'];
	if (Predicate.isObject(protocol)) {
		const target = Predicate.isObject(protocol['key']) ? str(protocol['key']['id']) : null;
		if (target === null) return null;
		if (Number(protocol['type']) === 0)
			return { ...base, id: target, text: '', deleted: true, invocation: 'ambient' };
		if (Number(protocol['type']) !== 14 || !Predicate.isObject(protocol['editedMessage']))
			return null;
		return {
			...base,
			id: target,
			text: whatsappText(protocol['editedMessage']),
			version: sentAt,
			invocation: 'ambient'
		};
	}
	const text =
		whatsappText(content) ||
		(options.includeSent === true ? whatsappMediaDescription(content) : '');
	const context = [
		content['extendedTextMessage'],
		content['imageMessage'],
		content['documentMessage'],
		content['videoMessage']
	].find(
		(x): x is Record<string, unknown> =>
			Predicate.isObject(x) && Predicate.isObject(x['contextInfo'])
	);
	const info = Predicate.isObject(context?.['contextInfo']) ? context['contextInfo'] : undefined;
	// Both of our identities: WhatsApp addresses a linked device by LID in `mentionedJid`, so matching only the phone
	// JID the number prints as reads every real mention as ambient. Either form, with or without a device suffix.
	const ours = [self, options.lid].flatMap((x) => {
		const bare = x?.split(':')[0]?.split('@')[0];
		return bare === undefined || bare === '' ? [] : [bare];
	});
	const isOurs = (j: string): boolean => ours.some((b) => j.startsWith(b));
	// every JID the message mentions, as the engine's `mentions` (a row nobody answered is diagnosed from them)
	const mentions = Array.isArray(info?.['mentionedJid'])
		? info['mentionedJid'].filter((j): j is string => typeof j === 'string')
		: [];
	// a reply to anybody is not a reply to us: only a quote of our own message counts, which `participant` names
	const repliedToUs = typeof info?.['participant'] === 'string' && isOurs(info['participant']);
	return {
		...base,
		id,
		text,
		replyTo: str(info?.['stanzaId']),
		mentions,
		invocation: !group
			? 'direct'
			: mentions.some(isOurs)
				? 'mention'
				: repliedToUs
					? 'reply'
					: 'ambient'
	};
}
function whatsappMediaDescription(content: Readonly<Record<string, unknown>>): string {
	for (const [kind, label] of [
		['documentMessage', 'Document'],
		['imageMessage', 'Image'],
		['videoMessage', 'Video'],
		['audioMessage', 'Audio']
	] as const) {
		if (Predicate.isObject(content[kind]))
			return `[${label}${str(content[kind]['fileName']) === null ? '' : `: ${str(content[kind]['fileName'])}`}]`;
	}
	return '';
}

function whatsappText(content: Readonly<Record<string, unknown>>): string {
	for (const [k, f] of [
		['conversation', null],
		['extendedTextMessage', 'text'],
		['imageMessage', 'caption'],
		['videoMessage', 'caption'],
		['documentMessage', 'caption']
	] as const) {
		const v = f === null ? content[k] : Predicate.isObject(content[k]) ? content[k][f] : undefined;
		if (typeof v === 'string') return v;
	}
	return '';
}

type Baileys = {
	default: (o: object) => WaSocket;
	initAuthCreds(): object;
	BufferJSON: { replacer(k: string, v: unknown): unknown; reviver(k: string, v: unknown): unknown };
	proto: { Message: { AppStateSyncKeyData: { fromObject(o: object): unknown } } };
	fetchLatestWaWebVersion(o: {
		signal?: AbortSignal;
	}): Promise<{ version: number[]; isLatest: boolean }>;
	Browsers: { ubuntu(n: string): unknown; macOS(n: string): unknown };
	downloadMediaMessage(m: unknown, t: 'buffer', o: object): Promise<Buffer>;
};
const BaileysModule = Schema.declare<Baileys>((value): value is Baileys => {
	if (typeof value !== 'object' || value === null) return false;
	return (
		'default' in value &&
		typeof value.default === 'function' &&
		'initAuthCreds' in value &&
		typeof value.initAuthCreds === 'function' &&
		'fetchLatestWaWebVersion' in value &&
		typeof value.fetchLatestWaWebVersion === 'function' &&
		'downloadMediaMessage' in value &&
		typeof value.downloadMediaMessage === 'function' &&
		'BufferJSON' in value &&
		typeof value.BufferJSON === 'object' &&
		value.BufferJSON !== null &&
		'replacer' in value.BufferJSON &&
		typeof value.BufferJSON.replacer === 'function' &&
		'reviver' in value.BufferJSON &&
		typeof value.BufferJSON.reviver === 'function' &&
		'proto' in value &&
		typeof value.proto === 'object' &&
		value.proto !== null &&
		'Message' in value.proto &&
		(typeof value.proto.Message === 'object' || typeof value.proto.Message === 'function') &&
		value.proto.Message !== null &&
		'AppStateSyncKeyData' in value.proto.Message &&
		typeof value.proto.Message.AppStateSyncKeyData === 'function' &&
		'fromObject' in value.proto.Message.AppStateSyncKeyData &&
		typeof value.proto.Message.AppStateSyncKeyData.fromObject === 'function' &&
		'Browsers' in value &&
		typeof value.Browsers === 'object' &&
		value.Browsers !== null &&
		'macOS' in value.Browsers &&
		typeof value.Browsers.macOS === 'function' &&
		'ubuntu' in value.Browsers &&
		typeof value.Browsers.ubuntu === 'function'
	);
});
const MediaData = Schema.NullOr(
	Schema.Struct({
		mimetype: Schema.optionalKey(Schema.String),
		fileName: Schema.optionalKey(Schema.String),
		fileLength: Schema.optionalKey(Schema.Unknown)
	})
);
const MediaEnvelope = Schema.Struct({
	message: Schema.optionalKey(
		Schema.Struct({
			imageMessage: Schema.optionalKey(MediaData),
			documentMessage: Schema.optionalKey(MediaData),
			videoMessage: Schema.optionalKey(MediaData),
			audioMessage: Schema.optionalKey(MediaData)
		})
	)
});

/** The real socket. Baileys is an optional dependency, so it is imported by name at first use. */
export const baileysSocket: WaOpen = async (c) => {
	const name = '@whiskeysockets/baileys';
	const b = Schema.decodeUnknownSync(BaileysModule)(await import(name));
	const encode = (value: unknown): Json =>
		Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
			JSON.stringify(value, b.BufferJSON.replacer)
		);
	const revive = (j: Json): unknown => JSON.parse(JSON.stringify(j), b.BufferJSON.reviver);
	const creds = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
		c.store.creds === null ? b.initAuthCreds() : revive(c.store.creds)
	);
	const keys = {
		get: async (type: string, ids: string[]) => {
			const out: { [id: string]: unknown } = {};
			for (const [id, v] of Object.entries(c.store.get(type, ids))) {
				const x = revive(v);
				out[id] =
					type === 'app-state-sync-key' && Predicate.isObject(x)
						? b.proto.Message.AppStateSyncKeyData.fromObject(x)
						: x;
			}
			return out;
		},
		set: (data: { [type: string]: { [id: string]: unknown } }) =>
			c.store.set(
				Object.fromEntries(
					Object.entries(data).map(([type, byId]) => [
						type,
						Object.fromEntries(
							Object.entries(byId).map(([id, v]) => [
								id,
								v === null || v === undefined ? null : encode(v)
							])
						)
					])
				)
			)
	};
	const quiet = {
		level: 'silent',
		child: () => quiet,
		trace() {},
		debug() {},
		info() {},
		warn() {},
		error: (m: unknown) => console.error('[baileys]', m)
	};
	const socket = b.default({
		version: await c.version((signal) => b.fetchLatestWaWebVersion({ signal })),
		auth: { creds, keys },
		logger: quiet,
		markOnlineOnConnect: false,
		beforeReceipt: c.beforeReceipt,
		getMessage: c.getMessage,
		cachedGroupMetadata: c.cachedGroupMetadata,
		msgRetryCounterCache: c.msgRetryCounterCache,
		// a personal account imports its whole history as a desktop companion; a workspace one keeps Baileys' default history filter
		...(c.personal
			? {
					// WhatsApp terminates a 'Desktop' companion before the QR (2026-10); 'Chrome' still syncs full history
					browser: b.Browsers.macOS('Chrome'),
					syncFullHistory: true,
					shouldSyncHistoryMessage: () => true
				}
			: { browser: b.Browsers.ubuntu('Bolt'), syncFullHistory: false })
	});
	// Baileys merges each update into `creds` first; the whole creds goes to the store
	socket.ev.on('creds.update', () => {
		void c.store
			.update(encode(creds))
			.catch((error) => console.warn('[providers] WhatsApp creds not persisted', error));
	});
	return {
		socket,
		async media(message, download) {
			const decoded = Schema.decodeUnknownOption(MediaEnvelope)(message);
			if (Option.isNone(decoded)) return null;
			const content = decoded.value.message ?? {};
			const kind = (
				['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'] as const
			).find((k) => content[k] !== undefined && content[k] !== null);
			if (kind === undefined) return null;
			const m = content[kind];
			if (m === undefined || m === null) return null;
			const mime = m.mimetype ?? 'application/octet-stream',
				declared = Number(m.fileLength ?? 0);
			let data: Uint8Array | null = null;
			if (download && declared <= MEDIA_MAX) {
				const downloaded = await Result.match(
					Result.try(() => b.downloadMediaMessage(message, 'buffer', {})),
					{
						onFailure: (error) => Promise.resolve(Result.fail(error)),
						onSuccess: (pending) =>
							pending.then(
								(got) =>
									Result.try(() => (got.byteLength <= MEDIA_MAX ? new Uint8Array(got) : null)),
								(error: unknown) => Result.fail(error)
							)
					}
				);
				if (Result.isSuccess(downloaded)) data = downloaded.success;
				else {
					console.warn(
						'[providers] WhatsApp media download failed; retaining its descriptor',
						downloaded.failure
					);
				}
			}
			return {
				name: m.fileName ?? `whatsapp.${mime.split('/')[1] ?? 'bin'}`,
				mime,
				bytes: data?.byteLength ?? declared,
				data
			};
		}
	};
};
