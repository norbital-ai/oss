export type UploadProgress = Readonly<{ readonly loaded: number; readonly total: number }>;
/** Owns upload file behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
const FileTransfers = {
	upload: async (file: File, onProgress: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<string> => {
		onProgress({ loaded: 0, total: file.size });
		const key = crypto.randomUUID();
		const authorization =
			typeof document === 'undefined' ? undefined : document.documentElement.dataset['boltAuthorization'];
		const response = await fetch(`/api/files/${encodeURIComponent(key)}`, {
			method: 'PUT',
			credentials: 'same-origin',
			headers: {
				...(file.type.length === 0 ? {} : { 'content-type': file.type }),
				...(authorization === undefined || authorization.length === 0 ? {} : { authorization })
			},
			body: file,
			signal
		});
		if (!response.ok) throw new Error(`Upload failed (${response.status})`);
		onProgress({ loaded: file.size, total: file.size });
		return `/api/files/${encodeURIComponent(key)}`;
	}
};
export const uploadFile = FileTransfers.upload;

export type UploadResult = Readonly<{ readonly id: string; readonly name: string; readonly type: string; readonly size: number; readonly url: string }>;
export type UploadEntry = Readonly<{ readonly id: string; readonly file: File }> & { stage: 'uploading' | 'complete' | 'error' | 'aborted'; percent: number; result?: UploadResult; error?: string };
/** Owns workspace file upload client behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
export class WorkspaceFileUploadClient {
	readonly uploads: Array<UploadEntry> = [];
	readonly #controllers = new Map<string, AbortController>();
	/** Owns upload behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
	async upload(file: File): Promise<UploadResult> {
		const id = crypto.randomUUID();
		const controller = new AbortController();
		this.#controllers.set(id, controller);
		const entry: UploadEntry = { id, file, stage: 'uploading', percent: 0 };
		this.uploads.push(entry);
		try {
			const url = await uploadFile(file, ({ loaded, total }) => { entry.percent = total === 0 ? 100 : Math.round((loaded / total) * 100); }, controller.signal);
			const result = { id, name: file.name, type: file.type, size: file.size, url };
			entry.stage = 'complete';
			entry.result = result;
			return result;
		} catch (cause) {
			entry.stage = controller.signal.aborted ? 'aborted' : 'error';
			entry.error = cause instanceof Error ? cause.message : String(cause);
			throw cause;
		} finally { this.#controllers.delete(id); }
	}
	/** Owns cancel behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
	readonly cancel = (id: string): void => { this.#controllers.get(id)?.abort(); };
	/** Owns clear behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
	readonly clear = (id: string): void => {
		this.cancel(id);
		const index = this.uploads.findIndex((entry) => entry.id === id);
		if (index >= 0) this.uploads.splice(index, 1);
	};
}
