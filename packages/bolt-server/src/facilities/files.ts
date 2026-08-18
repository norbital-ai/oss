import {
	FacilityCall,
	FileRequest,
	FileResponse,
	failure,
	makeWireError,
	success,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Config, Effect, Schema } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { selectConfiguredProvider, type ConfiguredProviderFactory } from '../config.js';

// stupidity:allow AL10 -- local file-store options stay beside their constructor in the required 14-file architecture
export interface LocalFilesOptions {
	readonly rootDirectory: string;
}

/** Creates an atomic, rooted, traversal-safe local filesystem binding. */
export const makeLocalFilesBinding = ({
	rootDirectory
}: LocalFilesOptions): FacilityBinding<FileRequest, FileResponse> => {
	const root = resolve(rootDirectory);
	/** Resolves a wire key while refusing any path that escapes the configured root. */
	const pathFor = (key: string): string => {
		if (key.includes('\0')) {
			throw new Error('file key contains a null byte');
		}
		const path = resolve(root, key);
		const fromRoot = relative(root, path);
		if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
			throw new Error('file key leaves the configured root');
		}
		return path;
	};

	return {
		call: async (unsafeMetadata, unsafeInput, signal) => {
			try {
				await Schema.decodeUnknownPromise(FacilityCall)(unsafeMetadata);
				const input = await Schema.decodeUnknownPromise(FileRequest)(unsafeInput);
				if (signal.aborted) {
					return failure(makeWireError('files.cancelled', 'File call was cancelled'));
				}

				if (input._tag === 'Read') {
					const bytes = new Uint8Array(await readFile(pathFor(input.key), { signal }));
					return success(
						FileResponse.make({
							key: input.key,
							bytes,
							etag: createHash('sha256').update(bytes).digest('hex')
						})
					);
				}

				if (input._tag === 'Write') {
					const path = pathFor(input.key);
					await mkdir(dirname(path), { recursive: true });
					const temporaryPath = `${path}.${randomUUID()}.tmp`;
					try {
						await writeFile(temporaryPath, input.bytes, { signal });
						await rename(temporaryPath, path);
					} finally {
						await rm(temporaryPath, { force: true });
					}
					return success(
						FileResponse.make({
							key: input.key,
							etag: createHash('sha256').update(input.bytes).digest('hex')
						})
					);
				}

				if (input._tag === 'Delete') {
					await rm(pathFor(input.key), { force: true });
					return success(FileResponse.make({ key: input.key }));
				}

				const prefixPath = pathFor(input.prefix);
				const entries = await readdir(prefixPath, { recursive: true, withFileTypes: true });
				const keys = entries
					.filter((entry) => entry.isFile())
					.map((entry) =>
						relative(root, resolve(entry.parentPath, entry.name)).split(sep).join('/')
					)
					.sort();
				return success(FileResponse.make({ keys }));
			} catch {
				return failure(
					makeWireError('files.failed', 'Local file operation failed', {
						retryable: false,
						outcome: signal.aborted ? 'unknown' : 'known'
					})
				);
			}
		}
	};
};

/** Loads the rooted self-host file store from Effect's current ConfigProvider. */
export const makeLocalFilesBindingFromConfig = Effect.fn(
	'BoltServer.Files.makeLocalFilesBindingFromConfig'
)(function* () {
	const rootDirectory = yield* Config.nonEmptyString('BOLT_SERVER_FILES_ROOT');
	return makeLocalFilesBinding({ rootDirectory });
});

/** Selects the local file store or a registered object-store provider through Effect Config; stupidity:allow Q3 -- public Config-selected provider factory entry point. */
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

/** Exposes rooted-local and Config-selected file binding construction. */
export const FileFacilities = {
	local: makeLocalFilesBinding,
	fromConfig: makeFilesBindingFromConfig
};
