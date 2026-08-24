import type {
	BeginUploadOptions,
	IFileUploadClient,
	UploadEntry,
	UploadOptions,
	UploadResult
} from '@norbital-ai/ui/file-upload';
import { Effect } from 'effect';
import { workspaceSession } from '#lib/client/session.js';

/**
 * The design system's file-upload contract, over the host's file store.
 *
 * There used to be nothing behind this. The host handed the data renderer a `createFileUploadClient`
 * whose every member rejected with "File upload is not wired to the … files facility yet", because
 * the only real implementation — `WorkspaceFileUploadClient` — answers a different result shape and
 * implements four of these eight members. Two clients for one job, neither of which could be used,
 * and a record sheet carrying a file field could not accept a file.
 *
 * There is one now, and it is the session's file store: the host names where files go when it mounts
 * the workspace, and this is the only adapter between that and the renderer.
 */
export class WorkspaceUploadClient implements IFileUploadClient {
	readonly uploads = $state<UploadEntry[]>([]);
	readonly #controllers = new Map<string, AbortController>();

	/**
	 * Mints the key an upload is stored under.
	 *
	 * Injected rather than read off the ambient `crypto`, so a test can pin the storage key and
	 * assert what the file store was actually asked for. A caller that already holds an id still
	 * wins: `beginUpload`'s `uploadId` is consulted first.
	 */
	readonly #newUploadId: () => string;

	constructor(newUploadId: () => string = () => globalThis.crypto.randomUUID()) {
		this.#newUploadId = newUploadId;
	}

	/**
	 * Stores one file and reports it as the renderer's own result shape.
	 *
	 * The key is minted here and carries the file's own extension, because the host derives the media
	 * type of what it serves back from that extension — a key without one reads back as an octet
	 * stream and the renderer shows a download instead of an image.
	 */
	upload(file: File, options: UploadOptions = {}): Effect.Effect<UploadResult, unknown> {
		const { id, effect } = this.beginUpload(file, {
			stream: options.stream,
			onProgress: (stage: UploadEntry['stage']) => options.onProgress?.(stage)
		});
		const abort = (): void => this.cancel(id);
		options.signal?.addEventListener('abort', abort, { once: true });
		if (options.signal?.aborted === true) abort();
		return effect.pipe(
			Effect.onInterrupt(() => Effect.sync(() => this.cancel(id))),
			Effect.ensuring(Effect.sync(() => options.signal?.removeEventListener('abort', abort)))
		);
	}

	uploadMany(
		files: File[],
		options: Pick<UploadOptions, 'stream'> = {}
	): Effect.Effect<UploadResult[], unknown> {
		return Effect.forEach(files, (file) => this.upload(file, options), {
			concurrency: 'unbounded'
		});
	}

	beginUpload(
		file: File,
		options: BeginUploadOptions = {}
	): { id: string; effect: Effect.Effect<UploadResult, unknown> } {
		const id = options.uploadId ?? this.#newUploadId();
		const controller = new AbortController();
		this.#controllers.set(id, controller);
		const entry: UploadEntry = { id, file, stage: 'uploading', percent: 0 };
		this.uploads.push(entry);
		options.onProgress?.('uploading');
		const extension = file.name.includes('.') ? `.${file.name.split('.').at(-1)}` : '';
		const storageKey = `${id}${extension}`;
		const effect = Effect.tryPromise({
			try: () =>
				workspaceSession().files.store(
					storageKey,
					file,
					({ loaded, total }) => {
						entry.percent = total === 0 ? 100 : Math.round((loaded / total) * 100);
					},
					controller.signal
				),
			catch: (cause) => cause
		}).pipe(
			Effect.map((url) => {
				const result: UploadResult = {
					id: id,
					storageKey,
					url,
					name: file.name,
					type: file.type,
					size: file.size
				};
				entry.stage = 'complete';
				entry.percent = 100;
				entry.result = result;
				options.onProgress?.('complete');
				return result;
			}),
			Effect.catch((cause) => {
				entry.stage = controller.signal.aborted ? 'aborted' : 'error';
				entry.error = String(cause);
				options.onProgress?.(entry.stage);
				return Effect.fail(cause);
			}),
			Effect.ensuring(Effect.sync(() => this.#controllers.delete(id)))
		);
		return { id, effect };
	}

	/**
	 * Drops stored bytes, addressed by the URL the renderer holds.
	 *
	 * The renderer knows a file by its URL and the store is keyed, so the key is recovered from the
	 * entry that produced it. A URL this client never issued is not deleted rather than guessed at —
	 * deriving a key by string-slicing a URL is how one host's routing shape gets written into a
	 * framework, and how a delete lands on the wrong object when that shape changes.
	 */
	delete(fileUrl: string): Effect.Effect<void, unknown> {
		const entry = this.uploads.find((candidate) => candidate.result?.url === fileUrl);
		const result = entry?.result;
		if (entry === undefined || result === undefined) return Effect.void;
		return Effect.tryPromise(() => workspaceSession().files.remove(result.storageKey)).pipe(
			Effect.tap(() => Effect.sync(() => this.clear(entry.id)))
		);
	}

	readonly cancel = (entryId: string): void => {
		this.#controllers.get(entryId)?.abort();
	};

	readonly clear = (entryId: string): void => {
		this.cancel(entryId);
		const index = this.uploads.findIndex((entry) => entry.id === entryId);
		if (index >= 0) this.uploads.splice(index, 1);
	};

	readonly clearAllUploads = (): void => {
		for (const entry of [...this.uploads]) this.clear(entry.id);
	};
}
