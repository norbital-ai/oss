export type FileMetadata = {
	summary: string;
	structure_hint: string;
};

export type FileValue = {
	norbital_id: string;
	name: string;
	size: number;
	type: string;
	url: string;
	metadata?: FileMetadata;
	indexed_status?: 'pending' | 'indexing' | 'ready' | 'failed' | 'not_indexable';
	indexed_error?: string | null;
};

export type AllowedFileType = string;
