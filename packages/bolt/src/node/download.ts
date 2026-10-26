/// <reference types="node" />
// `FilesPort.download` for a host that keeps files itself (compute model P21): the request goes out under the public
// network policy with every redirect hop checked again; the body is media by its first bytes or nothing is stored; it
// streams into the store a part at a time, so a download holds about one part whatever its size. A refusal, a body past
// the cap or a stall aborts the upload.
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Duration, Effect, type Scope } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import type { Downloaded } from '../engine/contracts.ts';
import { DOWNLOAD, mediaType } from '../engine/files/media.ts';
import type { PortFailure } from '../engine/port.ts';
import { pinnedLookup, publicDestination, type Address } from './net.ts';

/** Where a download streams: an upload begun once the body is media, its parts in order, then completed or aborted. */
export type DownloadSink<U> = {
	begin(mime: string): Effect.Effect<U, PortFailure>;
	part(upload: U, bytes: Uint8Array): Effect.Effect<void, PortFailure>;
	/** Answers the stored file's key. */
	complete(upload: U, sha256: string): Effect.Effect<string, PortFailure>;
	abort(upload: U): Effect.Effect<void>;
};
export type DownloadOptions = {
	/** A development host's own loopback origin (`localhost`, `127.0.0.1`) is reachable; nothing else private, ever. */
	allowLoopback?: boolean;
	maxBytes?: number;
	idleMs?: number;
};
/** A part is sent once it reaches this size (S3's smallest part but the last). */
const DOWNLOAD_PART_BYTES = 5 * 1024 * 1024;

const invalid = (message: string) => new FacilityFailure({ kind: 'invalid', message });
const upstream = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : 'the download failed'
	});
const decoded = (text: string): string => {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
};
/** The response's `content-disposition` name, else the URL's last path segment. */
const nameOf = (disposition: string | undefined, url: URL): string => {
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1],
		plain = /filename="?([^";]+)"?/i.exec(disposition ?? '')?.[1];
	const raw =
		encoded !== undefined
			? decoded(encoded)
			: (plain ?? decoded(url.pathname.split('/').at(-1) ?? ''));
	return raw.split(/[\\/]/).at(-1)?.trim() || 'download';
};

const addressesOf = (
	url: URL,
	allowLoopback: boolean
): Effect.Effect<readonly Address[], PortFailure> =>
	(url.protocol !== 'http:' && url.protocol !== 'https:') ||
	url.username !== '' ||
	url.password !== ''
		? Effect.fail(invalid('download takes a public http(s) URL without credentials.'))
		: allowLoopback && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
			? Effect.succeed([{ address: '127.0.0.1', family: 4 }])
			: publicDestination(
					url.hostname,
					Number(url.port || (url.protocol === 'https:' ? 443 : 80))
				).pipe(Effect.map((destination) => destination.addresses));

/** One hop: the response, destroyed when the download's scope closes. Interruptible, so the stall limit ends a hung connect. */
const open = (url: URL, addresses: readonly Address[]) =>
	Effect.callback<IncomingMessage, FacilityFailure>((resume) => {
		const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
			url,
			{
				agent: false,
				lookup: pinnedLookup(addresses),
				headers: { 'user-agent': 'norbital-download/1', 'accept-encoding': 'identity' }
			},
			(response) => resume(Effect.succeed(response))
		);
		req.on('error', (error) => resume(Effect.fail(upstream(error))));
		req.end();
		return Effect.sync(() => {
			req.destroy();
		});
	}).pipe(
		Effect.tap((response) =>
			Effect.addFinalizer(() =>
				Effect.sync(() => {
					response.destroy();
				})
			)
		)
	);

/** Fetches `url` under the policy and streams its body into `sink` when its first bytes are media. */
export const downloadMedia = <U>(
	url: string,
	sink: DownloadSink<U>,
	options: DownloadOptions = {}
): Effect.Effect<Downloaded, PortFailure> =>
	Effect.scoped(
		Effect.gen(function* () {
			const maxBytes = options.maxBytes ?? DOWNLOAD.maxBytes,
				idleMs = options.idleMs ?? DOWNLOAD.idleMs;
			const stalled = {
				duration: Duration.millis(idleMs),
				orElse: () =>
					Effect.fail(
						new FacilityFailure({
							kind: 'timeout',
							message: `The download sent nothing for ${idleMs} ms.`
						})
					)
			};
			const follow = (
				target: URL,
				hop: number
			): Effect.Effect<{ response: IncomingMessage; url: URL }, PortFailure, Scope.Scope> =>
				Effect.gen(function* () {
					if (hop > DOWNLOAD.redirects)
						return yield* Effect.fail(
							invalid(`The URL redirected more than ${DOWNLOAD.redirects} times.`)
						);
					const response = yield* open(
						target,
						yield* addressesOf(target, options.allowLoopback ?? false)
					).pipe(Effect.timeoutOrElse(stalled));
					const status = response.statusCode ?? 0,
						location = response.headers.location;
					if (status >= 200 && status < 300) return { response, url: target };
					response.destroy();
					if (status < 300 || status >= 400 || location === undefined)
						return yield* Effect.fail(
							new FacilityFailure({
								kind: 'upstream',
								message: `The URL answered ${status}.`,
								status
							})
						);
					const next = yield* Effect.try({
						try: () => new URL(location, target),
						catch: () => invalid('A redirect named an invalid URL.')
					});
					return yield* follow(next, hop + 1);
				});
			const { response, url: final } = yield* follow(
				yield* Effect.try({ try: () => new URL(url), catch: () => invalid('The URL is invalid.') }),
				0
			);
			const chunks = response[Symbol.asyncIterator]();
			return yield* storeMedia(
				nameOf(response.headers['content-disposition'], final),
				Effect.tryPromise({
					try: (): Promise<IteratorResult<unknown, undefined>> => chunks.next(),
					catch: upstream
				}).pipe(
					Effect.timeoutOrElse(stalled),
					Effect.flatMap((next) => {
						if (next.done === true) return Effect.succeed(undefined);
						const chunk: unknown = next.value;
						return chunk instanceof Uint8Array
							? Effect.succeed(chunk)
							: Effect.fail(upstream(new Error('the response body is not bytes')));
					})
				),
				sink,
				maxBytes
			);
		})
	);

/**
 * Streams a body (`next` answers its chunks in order, `undefined` at the end) into `sink` when its first bytes are media;
 * anything else is refused before an upload begins. The browser's download feeds it the page's parts.
 */
export const storeMedia = <U, E>(
	name: string,
	next: Effect.Effect<Uint8Array | undefined, E>,
	sink: DownloadSink<U>,
	maxBytes: number = DOWNLOAD.maxBytes
): Effect.Effect<Downloaded, E | PortFailure> =>
	Effect.gen(function* () {
		const hash = createHash('sha256');
		let size = 0;
		// the next chunk counted and hashed; `undefined` at the end
		const read = next.pipe(
			Effect.flatMap((chunk) => {
				if (chunk === undefined) return Effect.succeed(undefined);
				size += chunk.byteLength;
				if (size > maxBytes)
					return Effect.fail(invalid(`The file is over ${maxBytes} bytes; nothing was stored.`));
				hash.update(chunk);
				return Effect.succeed(chunk);
			})
		);
		const head: Uint8Array[] = [];
		let ended = false;
		for (let bytes = 0; bytes < DOWNLOAD.headBytes;) {
			const chunk = yield* read;
			if (chunk === undefined) {
				ended = true;
				break;
			}
			head.push(chunk);
			bytes += chunk.byteLength;
		}
		const first = Buffer.concat(head),
			mime = mediaType(first.subarray(0, DOWNLOAD.headBytes));
		// what came back, so a host's stub or error page reads as such: its size and its first bytes, printable
		if (mime === undefined)
			return yield* Effect.fail(
				invalid(
					`The file is not media (an image, audio, video, a PDF or an HTML page): it is ${ended ? '' : 'at least '}${size} bytes${
						size === 0
							? ''
							: `, beginning ${JSON.stringify(first.toString('latin1', 0, 64).replace(/[^\x20-\x7e]/g, '.'))}`
					}; nothing was stored.`
				)
			);
		const upload = yield* sink.begin(mime);
		const stored = yield* Effect.gen(function* () {
			let part: Uint8Array[] = [first],
				partBytes = first.byteLength;
			for (let chunk = yield* read; chunk !== undefined; chunk = yield* read) {
				part.push(chunk);
				partBytes += chunk.byteLength;
				if (partBytes >= DOWNLOAD_PART_BYTES) {
					yield* sink.part(upload, Buffer.concat(part));
					part = [];
					partBytes = 0;
				}
			}
			if (partBytes > 0) yield* sink.part(upload, Buffer.concat(part));
			const sha256 = hash.digest('hex');
			return { key: yield* sink.complete(upload, sha256), sha256 };
		}).pipe(Effect.onError(() => sink.abort(upload)));
		return { ...stored, bytes: size, mime, name };
	});
