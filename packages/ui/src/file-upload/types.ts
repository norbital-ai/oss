/**
 * Client-agnostic upload contract. Concrete implementation lives in the app (e.g. apps/core).
 */

export type UploadStage =
	| 'uploading'
	| 'converting'
	| 'summarizing'
	| 'complete'
	| 'error'
	| 'aborted';

export const UPLOAD_STAGE_MESSAGES: Record<UploadStage, string> = {
	uploading: 'Uploading...',
	converting: 'Converting...',
	summarizing: 'Summarizing...',
	complete: 'Done!',
	error: 'Failed',
	aborted: 'Cancelled'
};

const ACTIVE_UPLOAD_STAGES = new Set<UploadStage>(['uploading', 'converting', 'summarizing']);

export function isActiveUploadStage(stage: UploadStage): boolean {
	return ACTIVE_UPLOAD_STAGES.has(stage);
}

export interface UploadOptions {
	signal?: AbortSignal;
	/** Streaming multipart + SSE progress (default true in app implementation). */
	stream?: boolean;
	onProgress?: (stage: UploadStage, percent?: number) => void;
}

export interface BeginUploadOptions {
	stream?: boolean;
	uploadId?: string;
	onProgress?: (stage: UploadStage) => void;
}

/** Result of a successful upload (matches app JSON + `TFileValue`). */
export interface UploadResult {
	norbital_id: string;
	url: string;
	name: string;
	type: string;
	size: number;
	metadata?: Record<string, unknown>;
	indexed_status?: 'pending' | 'indexing' | 'ready' | 'failed' | 'not_indexable';
	indexed_error?: string | null;
}

export interface UploadEntry {
	id: string;
	file: File;
	stage: UploadStage;
	percent?: number;
	result?: UploadResult;
	error?: string;
}

export interface IFileUploadClient {
	readonly uploads: UploadEntry[];

	upload(file: File, options?: UploadOptions): Promise<UploadResult>;

	uploadMany(files: File[], options?: Pick<UploadOptions, 'stream'>): Promise<UploadResult[]>;

	beginUpload(
		file: File,
		options?: BeginUploadOptions
	): { id: string; promise: Promise<UploadResult> };

	delete(fileUrl: string): Promise<void>;

	cancel(entryId: string): void;

	/** Remove a finished or errored entry from the uploads list (cancels if still in flight). */
	clear(entryId: string): void;

	clearAllUploads(): void;
}
