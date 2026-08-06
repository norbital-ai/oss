import type {
	BeginUploadOptions,
	IFileUploadClient,
	UploadEntry,
	UploadOptions,
	UploadResult
} from '@norbital-ai/ui/file-upload';
import { z } from 'zod';

const uploadResponseSchema = z.object({
	norbital_id: z.string().uuid(),
	name: z.string(),
	type: z.string(),
	size: z.number().int().nonnegative()
});

/**
 * The subset of the i18n api the upload client needs, passed in rather than read from context:
 * this class is constructed by the shell's runtime wiring, outside any component init, so it
 * cannot call `useI18n` itself. The shell hands it `t` from its own typed hook; a caller that
 * omits it keeps the source English so the client stays renderable in isolation.
 */
export type FileUploadI18n = {
	t(key: string, vars?: { readonly [name: string]: string | number }): string;
};

async function responsePayload(response: Response, t: FileUploadI18n['t']): Promise<unknown> {
	const payload: unknown = await response.json();
	if (response.ok) return payload;
	const message =
		payload && typeof payload === 'object' && typeof Reflect.get(payload, 'message') === 'string'
			? Reflect.get(payload, 'message')
			: t('pod.fileUpload.operationFailed', { status: response.status });
	throw new Error(message);
}

function readFileBase64(file: File, t: FileUploadI18n['t'], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		const abort = () => reader.abort();
		const cleanup = () => signal?.removeEventListener('abort', abort);
		signal?.addEventListener('abort', abort, { once: true });
		reader.onerror = () => {
			cleanup();
			reject(reader.error ?? new Error(t('pod.fileUpload.readError')));
		};
		reader.onabort = () => {
			cleanup();
			reject(new DOMException('Upload cancelled', 'AbortError'));
		};
		reader.onload = () => {
			cleanup();
			const encoded = typeof reader.result === 'string' ? reader.result.split(',')[1] : undefined;
			if (!encoded) reject(new Error(t('pod.fileUpload.encodeError')));
			else resolve(encoded);
		};
		reader.readAsDataURL(file);
	});
}

export class WorkspaceFileUploadClient implements IFileUploadClient {
	readonly uploads = $state<UploadEntry[]>([]);
	private readonly controllers = new Map<string, AbortController>();
	private readonly recordIdByObjectUrl = new Map<string, string>();
	private readonly t: FileUploadI18n['t'];

	constructor(i18n?: FileUploadI18n) {
		this.t = i18n ? (key, vars) => i18n.t(key, vars) : (key) => key;
	}

	upload(file: File, options?: UploadOptions): Promise<UploadResult> {
		return this.beginUpload(file, options).promise;
	}

	async uploadMany(
		files: File[],
		options?: Pick<UploadOptions, 'stream'>
	): Promise<UploadResult[]> {
		if (options?.stream === false) return Promise.all(files.map((file) => this.upload(file)));
		const results: UploadResult[] = [];
		// stupidity:allow A6 -- streaming uploads are intentionally sequential to bound memory and preserve progress order.
		for (const file of files) results.push(await this.upload(file));
		return results;
	}

	beginUpload(file: File, options?: BeginUploadOptions) {
		const id = options?.uploadId ?? crypto.randomUUID();
		const controller = new AbortController();
		this.controllers.set(id, controller);
		const entry: UploadEntry = { id, file, stage: 'uploading', percent: 0 };
		this.uploads.push(entry);
		options?.onProgress?.('uploading');

		const promise = this.performUpload(entry, controller.signal)
			.then((result) => {
				entry.result = result;
				entry.stage = 'complete';
				entry.percent = 100;
				options?.onProgress?.('complete');
				return result;
			})
			.catch((cause: unknown) => {
				entry.stage =
					cause instanceof DOMException && cause.name === 'AbortError' ? 'aborted' : 'error';
				entry.error = cause instanceof Error ? cause.message : String(cause);
				options?.onProgress?.(entry.stage);
				throw cause;
			})
			.finally(() => this.controllers.delete(id));
		return { id, promise };
	}

	private async performUpload(entry: UploadEntry, signal: AbortSignal): Promise<UploadResult> {
		const dataBase64 = await readFileBase64(entry.file, this.t, signal);
		const response = await fetch('/_runtime/files/upload', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json', 'x-norbital-request-id': crypto.randomUUID() },
			body: JSON.stringify({
				file_name: entry.file.name,
				mime_type: entry.file.type || 'application/octet-stream',
				file_size: entry.file.size,
				data_base64: dataBase64
			}),
			signal
		});
		const parsed = uploadResponseSchema.parse(await responsePayload(response, this.t));
		const objectUrl = URL.createObjectURL(entry.file);
		this.recordIdByObjectUrl.set(objectUrl, parsed.norbital_id);
		return { ...parsed, url: objectUrl };
	}

	async delete(fileUrl: string): Promise<void> {
		const recordId = this.recordIdByObjectUrl.get(fileUrl);
		if (!recordId) return;
		const response = await fetch('/_runtime/files/delete', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json', 'x-norbital-request-id': crypto.randomUUID() },
			body: JSON.stringify({ record_id: recordId })
		});
		await responsePayload(response, this.t);
		URL.revokeObjectURL(fileUrl);
		this.recordIdByObjectUrl.delete(fileUrl);
	}

	cancel(entryId: string): void {
		this.controllers.get(entryId)?.abort();
	}

	clear(entryId: string): void {
		this.cancel(entryId);
		const index = this.uploads.findIndex((entry) => entry.id === entryId);
		if (index >= 0) this.uploads.splice(index, 1);
	}

	clearAllUploads(): void {
		for (const entry of this.uploads) this.cancel(entry.id);
		this.uploads.length = 0;
	}
}
