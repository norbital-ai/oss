import type { FileRef, Id } from '../decl/values.ts';
import type { FileUrlOptions } from '@norbital-ai/std/kind';
import { PATHS } from '../protocol/wire.ts';

type FileUrlScope = { readonly app: string } | { readonly kiosk: string };

/** Stored files keep the caller's public surface when fetched directly by the browser. */
export function storedFileUrl(
	base: string,
	id: string,
	options: FileUrlOptions = {},
	scope?: FileUrlScope
): string {
	const query = new URLSearchParams();
	if (options.preview !== undefined) query.set('preview', String(options.preview));
	if (scope !== undefined) {
		if ('kiosk' in scope) query.set('kiosk', scope.kiosk);
		else query.set('app', scope.app);
	}
	const search = query.toString();
	return `${base}${PATHS.files}${encodeURIComponent(id)}${search === '' ? '' : `?${search}`}`;
}

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
