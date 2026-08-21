import type {
	BeginUploadOptions,
	IFileUploadClient,
	UploadEntry,
	UploadOptions,
	UploadResult
} from '@norbital-ai/ui/file-upload';
import { workspaceSession } from '../../session.js';

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
	 * Stores one file and reports it as the renderer's own result shape.
	 *
	 * The key is minted here and carries the file's own extension, because the host derives the media
	 * type of what it serves back from that extension — a key without one reads back as an octet
	 * stream and the renderer shows a download instead of an image.
	 */
	async upload(file: File, options: UploadOptions = {}): Promise<UploadResult> {
		const { id, promise } = this.beginUpload(file, {
			...(options.stream === undefined ? {} : { stream: options.stream }),
			...(options.onProgress === undefined
				? {}
				: { onProgress: (stage: UploadEntry['stage']) => options.onProgress?.(stage) })
		});
		options.signal?.addEventListener('abort', () => this.cancel(id), { once: true });
		return promise;
	}

	async uploadMany(
		files: File[],
		options: Pick<UploadOptions, 'stream'> = {}
	): Promise<UploadResult[]> {
		return Promise.all(files.map((file) => this.upload(file, options)));
	}

	beginUpload(
		file: File,
		options: BeginUploadOptions = {}
	): { id: string; promise: Promise<UploadResult> } {
		const id = options.uploadId ?? crypto.randomUUID();
		const controller = new AbortController();
		this.#controllers.set(id, controller);
		const entry: UploadEntry = { id, file, stage: 'uploading', percent: 0 };
		this.uploads.push(entry);
		options.onProgress?.('uploading');
		const extension = file.name.includes('.') ? `.${file.name.split('.').at(-1)}` : '';
		const storageKey = `${id}${extension}`;
		const promise = workspaceSession()
			.files.store(
				storageKey,
				file,
				({ loaded, total }) => {
					entry.percent = total === 0 ? 100 : Math.round((loaded / total) * 100);
				},
				controller.signal
			)
			.then((url) => {
				const result: UploadResult = {
					norbital_id: id,
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
			})
			.catch((cause: unknown) => {
				entry.stage = controller.signal.aborted ? 'aborted' : 'error';
				entry.error = cause instanceof Error ? cause.message : String(cause);
				options.onProgress?.(entry.stage);
				throw cause;
			})
			.finally(() => {
				this.#controllers.delete(id);
			});
		return { id, promise };
	}

	/**
	 * Drops stored bytes, addressed by the URL the renderer holds.
	 *
	 * The renderer knows a file by its URL and the store is keyed, so the key is recovered from the
	 * entry that produced it. A URL this client never issued is not deleted rather than guessed at —
	 * deriving a key by string-slicing a URL is how one host's routing shape gets written into a
	 * framework, and how a delete lands on the wrong object when that shape changes.
	 */
	async delete(fileUrl: string): Promise<void> {
		const entry = this.uploads.find((candidate) => candidate.result?.url === fileUrl);
		if (entry?.result === undefined) return;
		const extension = entry.file.name.includes('.') ? `.${entry.file.name.split('.').at(-1)}` : '';
		await workspaceSession().files.remove(`${entry.result.norbital_id}${extension}`);
		this.clear(entry.id);
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
