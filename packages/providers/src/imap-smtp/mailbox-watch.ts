import { createStreamsTransport, ImapFlow, type MessageStructureObject } from 'imapflow';
import { Clock, Effect, Queue, Semaphore, Stream } from 'effect';
import type { Json, ReconcilePage } from '@norbital-ai/bolt/engine';
import { ProviderUnavailable, type ProviderFailure } from '../errors.ts';
import type { Named } from './reports.ts';
import {
	mailCall,
	serverFailure,
	streamsSocket,
	type Cursor,
	type Login,
	type Mailbox,
	type MailNet
} from './model.ts';

const DAY = 86_400_000;
/** The most of one message held at once, and messages are read one at a time: a stored file's 20 MiB, base64 encoded. */
const MAIL_MAX = 32 * 1024 * 1024;
/** What a reconcile reads of a message: its text, not its files. */
const PREVIEW_MAX = 64 * 1024;
/** What a new UIDVALIDITY recovers: the engine's reconcile window, and the rows one repair compares. */
const RECOVERY_MS = 7 * DAY,
	RECOVERY_MAX = 1000;
/** A sender this recent may still be waiting (the engine's repair rule), so recovered mail younger than this stays live. */
const REPLY_MS = 3_600_000;
const EMPTY = new Uint8Array(0);

const arrival = (at: Date | string | undefined) => {
	const received = at === undefined ? undefined : new Date(at);
	return received === undefined || Number.isNaN(received.getTime())
		? undefined
		: received.toISOString();
};
/** The files a message's structure names, without reading them. */
const filesOf = (node: MessageStructureObject | undefined): Named[] => {
	if (node === undefined) return [];
	if (node.type.startsWith('multipart/')) return (node.childNodes ?? []).flatMap(filesOf);
	const name = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];
	return name === undefined && node.disposition !== 'attachment' && node.type.startsWith('text/')
		? []
		: [{ name: name ?? `attachment-${node.part ?? 1}`, mime: node.type, bytes: node.size ?? 0 }];
};

export const imap = (box: Mailbox, auth: Login, net: MailNet) =>
	Effect.gen(function* () {
		const plain = net.plain;
		const signal = yield* Effect.abortSignal;
		return yield* Effect.acquireRelease(
			Effect.sync(() => {
				const client = new ImapFlow({
					host: box.imap.host,
					port: box.imap.port,
					transport: createStreamsTransport<ReturnType<typeof streamsSocket>>({
						open: ({ host, port, secure }) =>
							streamsSocket(net.tcp.connect({ host, port, tls: secure }, signal)),
						upgrade: (socket) =>
							streamsSocket(socket.connecting.then((open) => open.start_tls(signal)))
					}),
					auth,
					logger: false,
					// ENABLEd only where the server advertises it (imapflow filters by CAPABILITY): expunges then name their UID
					qresync: true,
					secure: !plain && box.imap.port === 993,
					doSTARTTLS: plain ? false : box.imap.port === 993 ? undefined : true,
					connectionTimeout: 30000,
					greetingTimeout: 30000
				});
				client.on('error', () => undefined);
				return client;
			}),
			(client) =>
				mailCall('close IMAP', () => client.logout()).pipe(
					Effect.timeoutOption('5 seconds'),
					Effect.tapCause(Effect.logWarning),
					Effect.ignore,
					Effect.ensuring(Effect.sync(() => client.close()))
				)
		);
	});

/** What the watch remembers of a message: enough to name it once it has gone. */
export type Seen = { readonly id: string; readonly thread: string };
export type Reconcile = (
	thread: string,
	since: string
) => Effect.Effect<ReconcilePage, ProviderFailure>;
type WatchOptions = {
	readonly box: Mailbox;
	readonly personal: boolean;
	readonly net: MailNet;
	/** A frozen source timestamp boundary; changing it replays the newly requested import scope. */
	readonly after?: string | undefined;
	readonly login: () => Effect.Effect<Login, ProviderFailure>;
	readonly cursor: () => Cursor | null;
	readonly advance: (cursor: Cursor) => Effect.Effect<void, ProviderFailure>;
	/** `history`: recovered mail nobody waits on. `files`: too large to read whole, so named only. */
	readonly deliver: (
		source: Uint8Array,
		fallback: string,
		receivedAt: string | undefined,
		recovered: { readonly history: boolean; readonly files: readonly Named[] | undefined }
	) => Effect.Effect<Seen | void, ProviderFailure>;
	/** A message as a page would carry it, `null` where `deliver` stores nothing. */
	readonly peek: (
		source: Uint8Array,
		fallback: string,
		receivedAt: string | undefined,
		files: readonly Named[]
	) => Effect.Effect<(Seen & { readonly message: Json }) | null>;
	/** A delete the server named. */
	readonly vanished: (id: string) => Effect.Effect<void, ProviderFailure>;
	/** The reconcile this connection serves, `null` once it has gone. */
	readonly serve: (reconcile: Reconcile | null) => Effect.Effect<void>;
	readonly connected: Effect.Effect<void, ProviderFailure>;
};

/** Redrains serialize; a UID moves only after delivery, including the successful prefix on failure. */
export const mailboxWatch = Effect.fn('Mailbox.watch')(function* (options: WatchOptions) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const client = yield* imap(options.box, yield* options.login(), options.net);
			yield* mailCall(`IMAP ${options.box.imap.host}`, () => client.connect()).pipe(
				Effect.onInterrupt(() => Effect.sync(() => client.close()))
			);
			const folder = yield* mailCall('open IMAP folder', () =>
				client.mailboxOpen(options.box.folder, { readOnly: options.personal })
			);
			const validity = String(folder.uidValidity);
			const previous = options.cursor(),
				now = yield* Clock.currentTimeMillis;
			const began =
				previous === null || previous.validity !== validity
					? new Date(now).toISOString()
					: previous.began;
			const scope = {
				...(options.after === undefined ? {} : { after: options.after }),
				...(began === undefined ? {} : { began })
			};
			/** The UIDs arrived since a day, ascending. A refusal is a failure: it must not read as an empty folder. */
			const windowOf = (since: Date) =>
				mailCall('search IMAP window', () => client.search({ since }, { uid: true })).pipe(
					Effect.flatMap((found) =>
						found
							? Effect.succeed([...found].sort((left, right) => left - right))
							: Effect.fail(
									new ProviderUnavailable({ message: 'the mail server refused the window search' })
								)
					)
				);
			// A new UIDVALIDITY voids the old UIDs: the drain restarts below a bounded window, which the engine dedupes by id.
			const recovery = windowOf(new Date(now - RECOVERY_MS)).pipe(
				Effect.map((found) => (found.slice(-RECOVERY_MAX)[0] ?? folder.uidNext) - 1)
			);
			if (previous?.validity !== validity || previous?.after !== options.after)
				yield* options.advance({
					validity,
					uid: options.personal
						? 0
						: previous === null
							? folder.uidNext - 1
							: previous.validity === validity
								? previous.uid
								: yield* recovery,
					...scope
				});
			// IMAP date searches ignore time and timezone. Keep a guard day, then enforce the exact INTERNALDATE instant.
			const day =
				options.after === undefined
					? undefined
					: new Date(Date.parse(`${options.after.slice(0, 10)}T00:00:00Z`) - 86_400_000);
			const search = (uid: string) =>
				client.search({ uid, ...(day === undefined ? {} : { since: day }) }, { uid: true });
			const redrain = yield* Semaphore.make(1);
			let history: number[] = [],
				historyAt = 0,
				historyThrough = 0;
			/** Every message this connection has identified, `null` for what is not stored: the UIDs a delete names. */
			const known = new Map<number, Seen | null>();
			const fallback = (uid: number) => `imap-${validity}-${uid}`;
			const read = (uid: number, maxLength: number) =>
				mailCall('read IMAP message', () =>
					client.fetchOne(
						String(uid),
						{ uid: true, internalDate: true, bodyStructure: true, source: { maxLength } },
						{ uid: true }
					)
				);
			/** One message at a time in UID order, each capped: the cursor moves past each, and memory holds one. */
			const deliver = (ids: readonly number[], accepted: (uid: number) => void) =>
				Effect.forEach(
					ids,
					(uid) =>
						Effect.gen(function* () {
							const message = yield* read(uid, MAIL_MAX);
							if (message === false) return;
							const source = message.source ?? EMPTY,
								receivedAt = arrival(message.internalDate),
								cut = source.byteLength >= MAIL_MAX;
							if (cut) yield* Effect.logWarning(`IMAP message ${uid} is too large to store whole`);
							const seen = yield* options.deliver(source, fallback(uid), receivedAt, {
								history: Date.parse(receivedAt ?? '') < Date.parse(began ?? '') - REPLY_MS,
								files: cut ? filesOf(message.bodyStructure) : undefined
							});
							if (seen !== undefined) known.set(uid, seen);
							accepted(uid);
						}),
					{ discard: true }
				);
			const pull = redrain.withPermit(
				Effect.gen(function* () {
					const from = options.cursor();
					if (from === null) return false;
					const found = yield* mailCall('search IMAP messages', () => search(`${from.uid + 1}:*`));
					const ids = (found || [])
						.filter((uid) => uid > from.uid)
						.sort((left, right) => left - right);
					const recent = options.personal ? ids.slice(-25) : ids.slice(0, 25);
					// A skipped interval remains durable while current mail moves the high watermark forward.
					const backfill =
						from.backfill ??
						(options.personal && ids.length > recent.length ? from.uid : undefined);
					let at = from.uid;
					const moved = () =>
						at === from.uid
							? Effect.void
							: options.advance({
									validity,
									...scope,
									uid: at,
									...(backfill === undefined ? {} : { backfill })
								});
					yield* deliver(recent, (uid) => {
						at = uid;
					}).pipe(Effect.onExit(() => Effect.suspend(moved)));
					const current = options.cursor();
					if (current?.backfill === undefined) return ids.length > recent.length;
					const start = current.backfill;
					if (historyAt >= history.length) {
						const pending = yield* mailCall('search IMAP history', () =>
							search(`${start + 1}:${current.uid}`)
						);
						history = (pending || [])
							.filter((uid) => uid > start && uid <= current.uid)
							.sort((left, right) => left - right);
						historyAt = 0;
						historyThrough = current.uid;
					}
					const older = history.slice(historyAt, historyAt + 25);
					let low = start;
					const movedHistory = () =>
						low === start
							? Effect.void
							: options.advance({
									validity,
									...scope,
									uid: current.uid,
									backfill: low
								});
					yield* deliver(older, (uid) => {
						low = uid;
					}).pipe(Effect.onExit(() => Effect.suspend(movedHistory)));
					historyAt += older.length;
					if (historyAt < history.length || historyThrough < current.uid) return true;
					yield* options.advance({ validity, uid: current.uid, ...scope });
					return false;
				})
			);
			/** One SEARCH is one view of the folder, so no delete falls between pages; what it lacks has gone. */
			const reconcile: Reconcile = (thread, since) =>
				redrain.withPermit(
					Effect.gen(function* () {
						// IMAP date searches ignore time and timezone, hence the guard day
						const found = yield* windowOf(new Date(Date.parse(since) - DAY)),
							window = new Set(found);
						for (const uid of known.keys()) if (!window.has(uid)) known.delete(uid);
						const unknown = found.filter((uid) => !known.has(uid));
						if (unknown.length > 0)
							yield* Stream.fromAsyncIterable(
								client.fetch(
									`${unknown[0]}:${unknown.at(-1)}`,
									{ uid: true, internalDate: true, headers: true },
									{ uid: true }
								),
								serverFailure('read IMAP headers')
							).pipe(
								Stream.runForEach((row) =>
									row.headers === undefined || !window.has(row.uid)
										? Effect.void
										: options
												.peek(row.headers, fallback(row.uid), arrival(row.internalDate), [])
												.pipe(
													Effect.map((page) => {
														known.set(row.uid, page && { id: page.id, thread: page.thread });
													})
												)
								)
							);
						const cursor = options.cursor(),
							through = cursor?.backfill ?? cursor?.uid ?? 0,
							hits = found.filter((uid) => known.get(uid)?.thread === thread),
							messages: Json[] = [];
						for (const uid of hits) {
							if (uid > through) continue;
							const row = yield* read(uid, PREVIEW_MAX);
							if (row === false) continue;
							const page = yield* options.peek(
								row.source ?? EMPTY,
								fallback(uid),
								arrival(row.internalDate),
								filesOf(row.bodyStructure)
							);
							if (page !== null) messages.push(page.message);
						}
						return {
							messages,
							// mail still draining is stored only partly, so its absence would prove nothing
							complete: found.every((uid) => known.has(uid)) && hits.every((uid) => uid <= through),
							...(began === undefined ? {} : { since: began })
						};
					})
				);
			const vanish = (uid: number) =>
				Effect.suspend(() => {
					const seen = known.get(uid);
					known.delete(uid);
					return seen ? options.vanished(seen.id) : Effect.void;
				});
			yield* Effect.acquireRelease(options.serve(reconcile), () => options.serve(null));
			yield* options.connected;
			const events = Stream.callback<'drain' | 'closed' | number>((queue) =>
				Effect.sync(() => {
					client.on('exists', () => Queue.offerUnsafe(queue, 'drain'));
					// QRESYNC's VANISHED names the UID; a plain EXPUNGE's sequence number waits for the reconcile
					client.on('expunge', ({ uid }) => {
						if (uid !== undefined) Queue.offerUnsafe(queue, uid);
					});
					client.on('close', () => {
						Queue.offerUnsafe(queue, 'closed');
						Queue.endUnsafe(queue);
					});
					Queue.offerUnsafe(queue, 'drain');
				})
			);
			yield* events.pipe(
				Stream.runForEach((event) =>
					event === 'closed'
						? Effect.fail(new ProviderUnavailable({ message: 'IMAP connection closed' }))
						: event === 'drain'
							? pull.pipe(Effect.repeat({ until: (more) => !more }))
							: vanish(event)
				)
			);
		})
	);
});
