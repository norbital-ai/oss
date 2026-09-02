// repository-health:allow SEM_SPREAD -- semantically adjacent to the bolt client upload
// state adapter by contract: ui owns the client-agnostic upload types, bolt consumes them.
/**
 * Client-agnostic upload contract. A concrete host adapter supplies the implementation.
 */

import { Cause, Effect, Schema } from 'effect';
import { FileValueSchema } from '../file-value/file-value.types.js';

const UploadStageSchema = Schema.Literals([
	'uploading',
	'converting',
	'summarizing',
	'complete',
	'error',
	'aborted'
]);
export type UploadStage = typeof UploadStageSchema.Type;

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
	signal?: AbortSignal | undefined;
	/** Streaming multipart + SSE progress (default true in app implementation). */
	stream?: boolean | undefined;
	onProgress?: ((stage: UploadStage, percent?: number) => void) | undefined;
}

export interface BeginUploadOptions {
	stream?: boolean | undefined;
	uploadId?: string | undefined;
	onProgress?: ((stage: UploadStage) => void) | undefined;
}

/** Result of a successful upload (matches app JSON + `TFileValue`). */
const UploadResultSchema = Schema.Struct({
	...FileValueSchema.fields,
	/**
	 * The object store's key for these bytes, which is what a `file()` column persists.
	 *
	 * Not the same string as `id`: the workspace client stores under `<uuid><extension>`
	 * and returns the bare uuid as the id. Reconstructing one from the other by string surgery is
	 * how a read lands on a key nothing was ever written under, so the key is carried.
	 */
	storageKey: Schema.String
});
export type UploadResult = typeof UploadResultSchema.Type;

export interface UploadEntry {
	id: string;
	file: File;
	stage: UploadStage;
	percent?: number;
	result?: UploadResult;
	error?: string;
}

export interface IFileUploadClient<E = Cause.UnknownError> {
	readonly uploads: UploadEntry[];

	upload(file: File, options?: UploadOptions): Effect.Effect<UploadResult, E>;

	uploadMany(
		files: File[],
		options?: Pick<UploadOptions, 'stream'>
	): Effect.Effect<UploadResult[], E>;

	beginUpload(
		file: File,
		options?: BeginUploadOptions
	): { id: string; effect: Effect.Effect<UploadResult, E> };

	delete(fileUrl: string): Effect.Effect<void, E>;

	cancel(entryId: string): void;

	/** Remove a finished or errored entry from the uploads list (cancels if still in flight). */
	clear(entryId: string): void;

	clearAllUploads(): void;
}
