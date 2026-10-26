/// <reference types="node" />
// Content-addressed blobs in a local directory (bolt dev, the test kit, a single-host bolt-server): the key is the
// bytes' sha256, so a put is idempotent. No signed URLs. A download streams into a temporary file, renamed to its key.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import type { Files } from '../engine/ports.ts';
import { Port } from '../engine/port.ts';
import { downloadMedia, type DownloadOptions } from './download.ts';

export function localFiles(dir: string, options: DownloadOptions = {}): Files['Service'] {
	const path = (key: string): Effect.Effect<string, FacilityFailure> =>
		/^[0-9a-f]{64}$/.test(key)
			? Effect.succeed(join(dir, key))
			: Effect.fail(new FacilityFailure({ kind: 'invalid', message: 'invalid local file key' }));
	return {
		put: (bytes, meta) =>
			Effect.gen(function* () {
				const key = createHash('sha256').update(bytes).digest('hex');
				yield* Port.attempt('files', () => mkdir(dir, { recursive: true }));
				yield* Port.attempt('files', () => writeFile(join(dir, key), bytes));
				return { key, bytes: bytes.byteLength, sha256: key, mime: meta.mime };
			}),
		get: (key, max) =>
			Effect.gen(function* () {
				const bytes = new Uint8Array(
					yield* path(key).pipe(
						Effect.flatMap((file) => Port.attempt('files', () => readFile(file)))
					)
				);
				if (bytes.byteLength > max)
					return yield* Effect.fail(
						new FacilityFailure({
							kind: 'tooLarge',
							message: `the file holds ${bytes.byteLength} bytes; at most ${max} were requested`
						})
					);
				return bytes;
			}),
		url: () => Port.unavailable('files.url', 'local files have no signed URLs'),
		remove: (key) =>
			path(key).pipe(
				Effect.flatMap((file) => Port.attempt('files', () => unlink(file))),
				Effect.asVoid
			),
		download: (url) =>
			downloadMedia(
				url,
				{
					begin: () =>
						Effect.gen(function* () {
							const temp = join(dir, `.download-${randomUUID()}`);
							yield* Port.attempt('files', () => mkdir(dir, { recursive: true }));
							return { temp, handle: yield* Port.attempt('files', () => open(temp, 'wx')) };
						}),
					part: ({ handle }, bytes) => Port.attempt('files', () => handle.writeFile(bytes)),
					complete: ({ temp, handle }, sha256) =>
						Port.attempt('files', async () => {
							await handle.close();
							await rename(temp, join(dir, sha256));
						}).pipe(Effect.as(sha256)),
					abort: ({ temp, handle }) =>
						Effect.tryPromise(() => handle.close()).pipe(
							Effect.ignore,
							Effect.andThen(Effect.tryPromise(() => unlink(temp))),
							Effect.ignore
						)
				},
				options
			)
	};
}
