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
	readonly login: () => Effect.Effect<Login, ProviderFailure>;
	readonly cursor: () => Cursor | null;
	readonly advance: (cursor: Cursor) => Effect.Effect<void, ProviderFailure>;
	readonly deliver: (source: Uint8Array, fallback: string) => Effect.Effect<void, ProviderFailure>;
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
			if (options.cursor()?.validity !== validity)
				yield* options.advance({ validity, uid: options.personal ? 0 : folder.uidNext - 1 });
			yield* options.connected;
			const redrain = yield* Semaphore.make(1);
			const pull = redrain.withPermit(
				Effect.gen(function* () {
					const from = options.cursor();
					if (from === null) return;
					const found = yield* mailCall('search IMAP messages', () =>
						client.search({ uid: `${from.uid + 1}:*` }, { uid: true })
					);
					const ids = (found || [])
						.filter((uid) => uid > from.uid)
						.sort((left, right) => left - right);
					let at = from.uid;
					const moved = () =>
						at === from.uid ? Effect.void : options.advance({ validity: from.validity, uid: at });
					yield* Effect.gen(function* () {
						for (let offset = 0; offset < ids.length; offset += 25) {
							const batch = yield* Stream.fromAsyncIterable(
								client.fetch(
									ids.slice(offset, offset + 25).join(','),
									{ uid: true, source: true },
									{ uid: true }
								),
								serverFailure('read IMAP messages')
							).pipe(Stream.runCollect);
							for (const message of [...batch].sort((left, right) => left.uid - right.uid)) {
								if (message.source === undefined) continue;
								yield* options.deliver(message.source, `imap-${from.validity}-${message.uid}`);
								at = message.uid;
							}
							yield* moved();
						}
					}).pipe(Effect.onExit(() => Effect.suspend(moved)));
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
						: pull
				)
			);
		})
	);
});
