import type { HTMLInputAttributes } from 'svelte/elements';
import type { IFileUploadClient } from '../file-upload/index.js';
import type { FileValue as TFileValue } from '../file-value/index.js';

export type FileRejectedReason =
	'Maximum file size exceeded' | 'File type not allowed' | 'Maximum files uploaded';

export interface FileDropZoneProps extends Omit<HTMLInputAttributes, 'multiple' | 'accept'> {
	client: IFileUploadClient;
	isCompact?: boolean;
	maxFiles?: number;
	fileCount?: number;
	maxFileSize?: number;
	onFileRejected?: (opts: { reason: FileRejectedReason; file: File }) => void;
	onUploadStart?: (files: File[]) => void;
	onUploadSuccess?: (files: TFileValue[]) => void;
	onUploadError?: (error: string, file?: File) => void;
	accept?: string[];
	uploadedFiles?: TFileValue[];
	onRemoveFile?: (index: number) => void;
	readonly?: boolean;
}

export { default as FileDropZone } from './file-drop-zone.svelte';
