import type { FileRef, Id } from '../decl/values.ts';

/** A stored-file handle from upload or a row read, as bolt's branded `FileRef` for writes and acts. */
export function fileRef(file: {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
}): FileRef {
	return {
		id: file.id as Id<'sys_file'>,
		name: file.name,
		mime: file.mime
	} as FileRef;
}
