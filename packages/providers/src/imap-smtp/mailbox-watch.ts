import { ImapFlow } from 'imapflow';
import { Effect, Queue, Semaphore, Stream } from 'effect';
import { pinnedLookup, publicDestination } from '@norbital-ai/bolt/engine';
import { checkServerIdentity } from 'node:tls';
import { ProviderUnavailable, type ProviderFailure } from '../errors.ts';
import { mailCall, serverFailure, type Cursor, type Login, type Mailbox } from './model.ts';

export const imap = (box: Mailbox, auth: Login, plain: boolean) =>
	Effect.gen(function* () {
		const destination = yield* publicDestination(box.imap.host, box.imap.port).pipe(
			Effect.mapError((error) => new ProviderUnavailable({ message: error.message }))
		);
		return yield* Effect.acquireRelease(
			Effect.sync(() => {
				const client = new ImapFlow({
					host: destination.hostname,
					port: box.imap.port,
					servername: destination.hostname,
					tls: {
						lookup: pinnedLookup(destination.addresses),
						servername: destination.hostname,
						rejectUnauthorized: true,
						checkServerIdentity: (_hostname, certificate) =>
							checkServerIdentity(destination.hostname, certificate)
					},
					auth,
					logger: false,
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

type WatchOptions = {
	readonly box: Mailbox;
	readonly personal: boolean;
	readonly plain: boolean;
	/** A frozen source timestamp boundary; changing it replays the newly requested import scope. */
	readonly after?: string | undefined;
	readonly login: () => Effect.Effect<Login, ProviderFailure>;
	readonly cursor: () => Cursor | null;
	readonly advance: (cursor: Cursor) => Effect.Effect<void, ProviderFailure>;
	readonly deliver: (
		source: Uint8Array,
		fallback: string,
		receivedAt: string | undefined
	) => Effect.Effect<void, ProviderFailure>;
	readonly connected: Effect.Effect<void, ProviderFailure>;
};

/** Redrains serialize; a UID moves only after delivery, including the successful prefix on failure. */
export const mailboxWatch = Effect.fn('Mailbox.watch')(function* (options: WatchOptions) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const client = yield* imap(options.box, yield* options.login(), options.plain);
			yield* mailCall(`IMAP ${options.box.imap.host}`, () => client.connect()).pipe(
				Effect.onInterrupt(() => Effect.sync(() => client.close()))
			);
			const folder = yield* mailCall('open IMAP folder', () =>
				client.mailboxOpen(options.box.folder, { readOnly: options.personal })
			);
			const validity = String(folder.uidValidity);
			const scope = options.after === undefined ? {} : { after: options.after };
			const previous = options.cursor();
			if (previous?.validity !== validity || previous?.after !== options.after)
				yield* options.advance({
					validity,
					uid: options.personal
						? 0
						: previous?.validity === validity
							? previous.uid
							: folder.uidNext - 1,
					...scope
				});
			yield* options.connected;
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
			const deliver = (ids: readonly number[], accepted: (uid: number) => void) =>
				Effect.gen(function* () {
					if (ids.length === 0) return;
					const batch = yield* Stream.fromAsyncIterable(
						client.fetch(
							ids.join(','),
							{ uid: true, source: true, internalDate: true },
							{ uid: true }
						),
						serverFailure('read IMAP messages')
					).pipe(Stream.runCollect);
					for (const message of [...batch].sort((left, right) => left.uid - right.uid)) {
						if (message.source === undefined) continue;
						const received =
							message.internalDate === undefined ? undefined : new Date(message.internalDate);
						yield* options.deliver(
							message.source,
							`imap-${validity}-${message.uid}`,
							received === undefined || Number.isNaN(received.getTime())
								? undefined
								: received.toISOString()
						);
						accepted(message.uid);
					}
				});
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
			const events = Stream.callback<'drain' | 'closed'>((queue) =>
				Effect.sync(() => {
					client.on('exists', () => Queue.offerUnsafe(queue, 'drain'));
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
						: pull.pipe(Effect.repeat({ until: (more) => !more }))
				)
			);
		})
	);
});
