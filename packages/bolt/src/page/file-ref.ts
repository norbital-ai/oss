import type { FileRef } from '../decl/values.ts';
import { IdValue, type FileUrlOptions } from '@norbital-ai/std/kind';
import { Schema } from 'effect';
import { PATHS } from '../protocol/wire.ts';

type FileUrlScope = { readonly app: string } | { readonly kiosk: string };

const StoredFile = Schema.Struct({
	id: IdValue,
	name: Schema.String,
	mime: Schema.String,
	size: Schema.optionalKey(Schema.Int)
});
/** A stored handle is branded only after the host's id, file metadata and optional size validate. */
export const FileRefSchema: Schema.Codec<FileRef> = Schema.declare(
	(value: unknown): value is FileRef => Schema.is(StoredFile)(value),
	{ identifier: 'FileRef' }
);

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
	readonly size?: number;
}): FileRef {
	return Schema.decodeUnknownSync(FileRefSchema)(file);
}
