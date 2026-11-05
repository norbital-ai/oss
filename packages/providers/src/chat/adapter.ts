// A chat platform as an adapter, in the shape of Chat SDK's: each platform is one folder that says how to connect,
// verify and parse a delivery, send, and read history, using the platform's own SDK where it publishes one. Everything
// between an adapter and the engine is `chatProvider`, so every platform stores before it acknowledges, dedupes and
// recovers the same way. An adapter holds no unbounded state.
import { Effect, Predicate, Schedule, Schema, Semaphore } from 'effect';
import type { DriverOpen, Json, OutboundAttachment } from '@norbital-ai/bolt/engine';
import type { LinkDef, ProviderDef, ProviderText } from '../abi.ts';
import { answerFailure, PairingInvalid, ProviderUnavailable } from '../errors.ts';
import { inbound, type ChatMessage } from '../inbound.ts';
import { hostCall, storedCredential } from '../util.ts';

const MEDIA_MAX = 20 * 1024 * 1024;

/** A file a message carries; its bytes are fetched once the message is on its way to the store. */
export type IncomingFile = {
	readonly name: string;
	readonly mime: string;
	readonly bytes?: number;
	readonly fetch?: () => Promise<Uint8Array>;
};
/** One message in a platform's delivery, parsed by its adapter. `id` is the platform's and deduplicates. */
export type Incoming = Pick<ChatMessage, 'id' | 'thread' | 'sentAt' | 'from' | 'text'> &
	Partial<
		Pick<
			ChatMessage,
			'group' | 'mentioned' | 'repliedTo' | 'replyTo' | 'title' | 'version' | 'deleted'
		>
	> & { readonly files?: readonly IncomingFile[] };
/**
 * What a delivery came to: its messages, a response when the platform expects a particular answer, and `about`, facts the
 * connection's page then shows a person, for a value the platform hands over only here.
 */
export type Delivery = {
	readonly messages: readonly Incoming[];
	readonly response?: Response;
	readonly about?: Readonly<Record<string, string>>;
};
/** A verified delivery that carries nothing to store: a handshake, or an event no message came from. */
export const nothing = (response?: Response): Delivery => ({
	messages: [],
	...(response === undefined ? {} : { response })
});
/**
 * What the newest of `limit` keys last held: the most an adapter may keep per thread, such as the message a reply must
 * name. It lives for the connection, so a restart forgets it.
 */
export const recent = <V>(limit = 1000) => {
	const held = new Map<string, V>();
	return {
		get: (key: string) => held.get(key),
		set(key: string, value: V) {
			held.delete(key);
			held.set(key, value);
			if (held.size > limit) held.delete(held.keys().next().value as string);
		}
	};
};

/** The platform's refusal of a call: its status decides whether a send retries. */
export class PlatformError extends Error {
	readonly status: number;
	readonly retryAfterMs: number | undefined;
	constructor(message: string, status: number, retryAfterMs?: number) {
		super(message);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}
/** A delivery that fails its signature. */
export class Unverified extends Error {}

/** One account of a platform, connected. Every member but `account`, `deliver` and `send` is what the platform offers. */
export type ChatConnection = {
	readonly account: string | null;
	/** Verifies a delivery (else throws `Unverified`) and parses it. `body` is the raw text the signature covers. */
	deliver(request: Request, body: string): Promise<Delivery>;
	/**
	 * Sends into `thread`. `key` is stable across retries of one message: pass it to a platform that dedupes on one, and
	 * declare `idempotent` then, so an unknown outcome may be resent.
	 */
	send(
		thread: string,
		text: string,
		key: string,
		files: readonly OutboundAttachment[]
	): Promise<{ readonly id: string }>;
	typing?(thread: string, on: boolean): Promise<void>;
	/** The thread a person can be written to first, for a test message. */
	openDirect?(user: string): Promise<string>;
	/** The platform's current view of a thread since an instant: what repairs missed and deleted messages. */
	history?(
		thread: string,
		since: string
	): Promise<{ readonly messages: readonly Incoming[]; readonly complete: boolean }>;
	/**
	 * The platform's own change log: what changed since `cursor`, deletes included, and the cursor to keep. `null` asks for
	 * a starting cursor. A platform with one needs no `history`.
	 */
	changes?(
		cursor: string | null
	): Promise<{
		readonly messages: readonly Incoming[];
		readonly cursor: string;
		/** The platform no longer holds `cursor`: catching up restarted, and what happened between is lost. */
		readonly gap?: boolean;
	}>;
	close?(): Promise<void>;
};
/**
 * How far a platform can be repaired. `changes`: it keeps a change log, so we catch up from a cursor and nothing is lost
 * while it holds that log. `history`: its threads can be read back, so a missed or deleted message is found by comparing
 * a recent window. `webhook`: it offers neither, so what falls outside its own retries is lost.
 */
export type Consistency = 'changes' | 'history' | 'webhook';
export type ChatField = {
	readonly name: string;
	readonly label: ProviderText;
	readonly secret?: true;
	readonly optional?: true;
};
export type ChatPlatform = {
	readonly id: string;
	readonly driver?: 'chat' | 'whatsapp';
	readonly name: ProviderText;
	readonly description: ProviderText;
	/** How it reaches the platform: its official API, or a named third-party gateway. */
	readonly via: ProviderText;
	/** Must match what the connection implements: a test holds every platform to it. */
	readonly consistency: Consistency;
	/** The platform dedupes `send` on its `key`, so a send that timed out is sent again rather than given up. */
	readonly idempotent?: true;
	readonly guide: string;
	readonly icon?: string;
	readonly fields: readonly ChatField[];
	/** Connects with the settings a person entered: a call the platform answers proves them. */
	connect(
		settings: Readonly<Record<string, string>>,
		host: ChatHost
	): Promise<ChatConnection>;
};
/** What a connection gets from its host. `receive` is for a platform that pushes over a socket or a long poll: it stores
 * before it resolves, and a rejection means the platform's message must not be acknowledged. */
export type ChatHost = Pick<DriverOpen, 'fetch' | 'webhookUrl'> & {
	receive(messages: readonly Incoming[]): Promise<void>;
};

const Settings = Schema.Record(Schema.String, Schema.String);
const Message = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	to: Schema.NonEmptyString,
	text: Schema.String
});
const failure = (name: string, error: unknown) => {
	const message = `${name}: ${error instanceof Error ? error.message : 'failed'}`;
	return error instanceof PlatformError
		? answerFailure(message, error.status, undefined, error.retryAfterMs)
		: new ProviderUnavailable({ message });
};

/** What a person is told at connecting: how far this platform's state can be trusted to match ours. */
const KEEPING: Readonly<Record<Consistency, ProviderText>> = {
	changes: {
		en: 'Norbital reads this platform’s change log, so missed messages and deletes are recovered.',
		zh: 'Norbital 读取此平台的变更日志，遗漏的消息和删除都能恢复。'
	},
	history: {
		en: 'Norbital compares recent conversations with this platform each day and repairs what it missed.',
		zh: 'Norbital 每天与此平台核对近期会话，并修复遗漏的内容。'
	},
	webhook: {
		en: 'This platform keeps no record Norbital can read back, so a message it fails to deliver is lost.',
		zh: '此平台没有可供 Norbital 回读的记录，投递失败的消息将会丢失。'
	}
};

/**
 * A message in the engine's shape, its files' bytes beside it. A file that cannot be fetched keeps its descriptor.
 * ponytail: `fetched` is false on a repair, which keeps name and size only: it cannot yet tell which messages are missing
 * before reading, so bytes would download every window. Add a second read for the missing ones if repaired files matter.
 */
const stored = async (message: Incoming, fetched = true) => {
	const bins: Uint8Array[] = [],
		attachments = [];
	for (const file of message.files ?? []) {
		const bytes = fetched ? await file.fetch?.().catch(() => undefined) : undefined;
		const kept = bytes !== undefined && bytes.byteLength <= MEDIA_MAX;
		if (kept) bins.push(bytes);
		attachments.push({
			name: file.name,
			mime: file.mime,
			bytes: bytes?.byteLength ?? file.bytes ?? 0,
			...(kept ? { bin: bins.length - 1 } : {})
		});
	}
	const { files: _files, group, mentioned, repliedTo, replyTo, ...rest } = message;
	return {
		bins,
		wire: inbound({
			...rest,
			group: group ?? false,
			mentioned: mentioned ?? false,
			repliedTo: repliedTo ?? false,
			replyTo: replyTo ?? null,
			attachments
		})
	};
};

/** A chat platform as a provider of its driver: a form of its settings, and the webhook URL to paste into it. */
export const chatProvider = (platform: ChatPlatform): ProviderDef => ({
	_tag: 'ProviderDef',
	driver: platform.driver ?? 'chat',
	id: platform.id,
	name: platform.name,
	label: platform.via,
	description: platform.description,
	...(platform.idempotent === undefined ? {} : { idempotentSends: true }),
	...(platform.icon === undefined ? {} : { icon: platform.icon }),
	setup: {
		kind: 'form',
		webhook: true,
		steps: [
			{ text: { en: 'Setup guide', zh: '设置指南' }, href: platform.guide },
			{ text: KEEPING[platform.consistency] }
		],
		fields: platform.fields.map(({ name, label, secret, optional }) => ({
			name,
			label,
			...(secret === undefined ? {} : { secret }),
			...(optional === undefined ? {} : { optional })
		}))
	},
	test: { to: { name: 'to', label: { en: 'Send to', zh: '发送至' } } },
	open: Effect.fn(`${platform.id}.open`)(function* (ctx: DriverOpen) {
		const name = platform.name.en;
		let live: ChatConnection | null = null;
		const call = <A>(what: string, work: () => Promise<A>) =>
			Effect.tryPromise({ try: work, catch: (error) => failure(`${name} ${what}`, error) });
		const report = (status: Parameters<DriverOpen['status']>[0]) =>
			hostCall(`report ${name} status`, () => ctx.status(status));
		let about: Readonly<Record<string, string>> = {};
		const connected = (connection: ChatConnection) =>
			report({ state: 'connected', account: connection.account ?? name, about });
		const store = async (messages: readonly Incoming[]) => {
			for (const message of messages) {
				const { wire, bins } = await stored(message);
				await ctx.emit({
					kind: 'messages',
					messages: [wire],
					...(bins.length === 0 ? {} : { bins })
				});
			}
		};
		const connect = (settings: Readonly<Record<string, string>>) =>
			call('connect', async () => {
				const made = await platform.connect(settings, {
					fetch: ctx.fetch,
					webhookUrl: ctx.webhookUrl,
					receive: store
				});
				const level = made.changes ? 'changes' : made.history ? 'history' : 'webhook';
				if (level !== platform.consistency) {
					await made.close?.();
					throw new Error(`declares ${platform.consistency} consistency but offers ${level}`);
				}
				return made;
			});
		const need = Effect.suspend(() =>
			live === null
				? Effect.fail(new ProviderUnavailable({ message: `${name} is not connected` }))
				: Effect.succeed(live)
		);
		const settings = yield* storedCredential(ctx, Settings);
		if (settings._tag === 'Some')
			live = yield* connect(settings.value).pipe(
				Effect.tap(connected),
				Effect.catch((error) =>
					report({ state: 'error', error: error.message }).pipe(Effect.as(null))
				)
			);
		else yield* report({ state: 'unpaired' });
		const close = (connection: ChatConnection | null) =>
			Effect.promise(async () => connection?.close?.()).pipe(Effect.ignore);
		// the cursor moves only once what it covers is stored, so a failure repeats the same catch-up
		const held = yield* hostCall(`read ${name} cursor`, () => ctx.credentials.load());
		const kept = held.get('cursor');
		let cursor: string | null = typeof kept === 'string' ? kept : null;
		const gate = yield* Semaphore.make(1);
		const catchUp = gate.withPermits(1)(
			Effect.gen(function* () {
				const connection = live;
				if (connection?.changes === undefined) return;
				const answer = yield* call('changes', () => connection.changes!(cursor));
				yield* hostCall(`store ${name} changes`, () => store(answer.messages));
				if (answer.cursor !== cursor) {
					yield* hostCall(`keep ${name} cursor`, () =>
						ctx.credentials.write(new Map([['cursor', answer.cursor]]))
					);
					cursor = answer.cursor;
				}
				if (answer.gap === true)
					yield* report({
						state: 'connected',
						account: connection.account ?? name,
						detail: `${name} no longer held its place in the change log, so messages from the gap may be missing.`,
						about
					});
			})
		);
		yield* catchUp.pipe(
			Effect.tapCause(Effect.logWarning),
			Effect.ignore,
			Effect.repeat(Schedule.jittered(Schedule.spaced('1 day'))),
			Effect.forkScoped
		);
		const def: LinkDef = {
			pair: Effect.fn(`${platform.id}.pair`)(function* (input: Json) {
				const values = yield* Schema.decodeUnknownEffect(Settings)(input).pipe(
					Effect.mapError(() => new PairingInvalid({ message: 'settings must be text' }))
				);
				for (const field of platform.fields)
					if (field.optional !== true && !values[field.name]?.trim())
						return yield* Effect.fail(
							new PairingInvalid({ message: `${field.label.en} is required` })
						);
				const made = yield* connect(values).pipe(
					Effect.mapError((error) => new PairingInvalid({ message: error.message }))
				);
				yield* hostCall(`store ${name} credential`, () =>
					ctx.credentials.write(
						new Map<string, Json | null>([
							['credential', values],
							['cursor', null]
						])
					)
				).pipe(Effect.onError(() => close(made)));
				yield* close(live);
				live = made;
				cursor = null;
				yield* connected(made);
				yield* catchUp.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
			}),
			unpair: () =>
				Effect.suspend(() => {
					const was = live;
					live = null;
					return close(was);
				}),
			close: Effect.suspend(() => close(live)),
			// stored before acknowledged, whatever the platform expects: a refused store answers 500 and it redelivers
			webhook: (request) =>
				Effect.gen(function* () {
					const connection = yield* need;
					const body = yield* call('webhook', () => request.text());
					const delivery = yield* Effect.tryPromise({
						try: () => connection.deliver(request, body),
						catch: (error) => error
					}).pipe(Effect.result);
					if (delivery._tag === 'Failure')
						return delivery.failure instanceof Unverified
							? new Response(null, { status: 401 })
							: yield* Effect.fail(failure(`${name} webhook`, delivery.failure));
					const saved = yield* hostCall(`store ${name} message`, () =>
						store(delivery.success.messages)
					).pipe(Effect.result);
					if (delivery.success.about !== undefined) {
						about = { ...about, ...delivery.success.about };
						yield* connected(connection);
					}
					if (saved._tag === 'Failure') return new Response(null, { status: 500 });
					// a push that only says something changed: the change log is the message
					if (delivery.success.messages.length === 0) {
						const caught = yield* catchUp.pipe(Effect.result);
						if (caught._tag === 'Failure') return new Response(null, { status: 500 });
					}
					return delivery.success.response ?? new Response(null, { status: 200 });
				}),
			send: Effect.fn(`${platform.id}.send`)(function* (
				message: Json,
				files: readonly OutboundAttachment[] = []
			) {
				const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
					Effect.mapError(() => answerFailure(`a ${name} message needs to and text`, 400))
				);
				const connection = yield* need;
				const sent = yield* call('send', () =>
					connection.send(m.to, m.text, m.id ?? `${m.to}:${m.text}`, files)
				);
				return { providerId: sent.id };
			}),
			reconcile:
				platform.consistency === 'webhook'
					? undefined
					: (thread, since) =>
							need.pipe(
								Effect.flatMap((connection) =>
									call('history', async () => {
										const page = await connection.history?.(thread, since);
										const messages = await Promise.all(
											(page?.messages ?? []).map((message) => stored(message, false))
										);
										return {
											messages: messages.map(({ wire }) => wire),
											complete: page?.complete ?? false
										};
									})
								)
							),
			typing: (to, on) =>
				need.pipe(
					Effect.flatMap((connection) =>
						call('typing', async () => connection.typing?.(to, on))
					),
					Effect.asVoid
				),
			test: (input) =>
				Effect.gen(function* () {
					const to = Predicate.isObject(input) ? input['to'] : undefined;
					if (typeof to !== 'string' || to === '')
						return yield* Effect.fail(answerFailure('name where the test message goes', 400));
					const connection = yield* need;
					yield* call('test', async () => {
						const thread = (await connection.openDirect?.(to)) ?? to;
						await connection.send(thread, 'Norbital test message', crypto.randomUUID(), []);
					});
				})
		};
		return def;
	})
});
