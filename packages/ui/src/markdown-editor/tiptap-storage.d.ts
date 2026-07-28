import type { IFileUploadClient } from '../file-upload/types.js';

declare module '@tiptap/core' {
	interface Storage {
		fileAttachment?: { uploadClient?: IFileUploadClient };
	}
}

export {};
