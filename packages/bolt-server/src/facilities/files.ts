import { FileRequest, FileResponse, type FacilityBinding } from '@norbital-ai/bolt-protocol';
import { Config, Effect } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
	makeWireBinding,
	selectConfiguredProvider,
	type ConfiguredProviderFactory
} from '../config.js';

export interface LocalFilesOptions {
	readonly rootDirectory: string;
}

/** Creates an atomic, rooted, traversal-safe local filesystem binding. */
export const makeLocalFilesBinding = (
	{ rootDirectory }: LocalFilesOptions,
	/** Names the temporary companion of an atomic write; injected so the suffix's source is a parameter, never ambient. */
	temporarySuffix: () => string = randomUUID
): FacilityBinding<FileRequest, FileResponse> => {
	const root = resolve(rootDirectory);
	/** Resolves a wire key while refusing any path that escapes the configured root. */
	const pathFor = (key: string): Effect.Effect<string, Error> => {
		if (key.includes('\0')) {
			return Effect.fail(new Error('file key contains a null byte'));
		}
		const path = resolve(root, key);
		const fromRoot = relative(root, path);
		if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
			return Effect.fail(new Error('file key leaves the configured root'));
		}
		return Effect.succeed(path);
	};

	return makeWireBinding({
		request: FileRequest,
		response: FileResponse,
		cancelled: { code: 'files.cancelled', message: 'File call was cancelled' },
		failed: { code: 'files.failed', message: 'Local file operation failed', retryable: false },
		invoke: (_metadata, input, signal) =>
			Effect.runPromise(
				Effect.gen(function* () {
					if (input._tag === 'Read') {
						const path = yield* pathFor(input.key);
						const bytes = new Uint8Array(
							yield* Effect.tryPromise(() => readFile(path, { signal }))
						);
						return FileResponse.make({
							key: input.key,
							bytes,
							etag: createHash('sha256').update(bytes).digest('hex')
						});
					}

					if (input._tag === 'Write') {
						const path = yield* pathFor(input.key);
						yield* Effect.tryPromise(() => mkdir(dirname(path), { recursive: true }));
						const temporaryPath = `${path}.${temporarySuffix()}.tmp`;
						const staged = Effect.gen(function* () {
							yield* Effect.tryPromise(() => writeFile(temporaryPath, input.bytes, { signal }));
							yield* Effect.tryPromise(() => rename(temporaryPath, path));
						});
						yield* staged.pipe(
							Effect.ensuring(
								Effect.tryPromise(() => rm(temporaryPath, { force: true })).pipe(
									Effect.catch(() => Effect.void)
								)
							)
						);
						return FileResponse.make({
							key: input.key,
							etag: createHash('sha256').update(input.bytes).digest('hex')
						});
					}

					if (input._tag === 'Delete') {
						const path = yield* pathFor(input.key);
						yield* Effect.tryPromise(() => rm(path, { force: true }));
						return FileResponse.make({ key: input.key });
					}

					const prefixPath = yield* pathFor(input.prefix);
					const entries = yield* Effect.tryPromise(() =>
						readdir(prefixPath, { recursive: true, withFileTypes: true })
					);
					// One pass over the tree: a recursive listing of a large prefix is the expensive part, and
					// a filter/map chain walks it twice before the sort walks it a third time.
					const keys: Array<string> = [];
					for (const entry of entries) {
						if (!entry.isFile()) continue;
						keys.push(relative(root, resolve(entry.parentPath, entry.name)).split(sep).join('/'));
					}
					keys.sort();
					return FileResponse.make({ keys });
				})
			)
	});
};

/** Loads the rooted self-host file store from Effect's current ConfigProvider. */
export const makeLocalFilesBindingFromConfig = Effect.fn(
	'BoltServer.Files.makeLocalFilesBindingFromConfig'
)(function* () {
	const rootDirectory = yield* Config.nonEmptyString('BOLT_SERVER_FILES_ROOT');
	return makeLocalFilesBinding({ rootDirectory });
});

/** Selects the local file store or a registered object-store provider through Effect Config. */
export const makeFilesBindingFromConfig = <Error>(
	factories: Readonly<
		Record<string, ConfiguredProviderFactory<FacilityBinding<FileRequest, FileResponse>, Error>>
	> = {}
) =>
	Effect.gen(function* () {
		const provider = yield* Config.nonEmptyString('BOLT_SERVER_FILES_PROVIDER').pipe(
			Config.withDefault('local')
		);
		if (provider === 'local') return yield* makeLocalFilesBindingFromConfig();
		return yield* selectConfiguredProvider('FILES', factories);
	});

export type StartedLocalFiles = {
	readonly binding: ReturnType<typeof makeLocalFilesBinding>;
	readonly rootDirectory: string;
	readonly close: () => Promise<void>;
};

/** Local files binding rooted in a temp directory. Close removes the directory. */
export const startLocalFiles = async (): Promise<StartedLocalFiles> => {
	const rootDirectory = await mkdtemp(join(tmpdir(), 'bolt-server-files-'));
	return {
		binding: makeLocalFilesBinding({ rootDirectory }),
		rootDirectory,
		close: () => rm(rootDirectory, { recursive: true, force: true })
	};
};
