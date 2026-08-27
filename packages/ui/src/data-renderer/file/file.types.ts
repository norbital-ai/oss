// repository-health:allow SEM_PARALLEL -- data-renderer/file imports the FileValue contract over
// the #lib/file-value barrel, so the pair is linked, not parallel.
import { Schema } from 'effect';
import type { FileValue } from '#lib/file-value';

/**
 * A `file()` column's stored value: the key that identifies the bytes, plus the display facts the
 * column carries so no surface has to look up a target row to show a file name.
 */
const FileRefSchema = Schema.Struct({
	storage_key: Schema.NonEmptyString,
	file_name: Schema.String,
	file_size: Schema.Number,
	mime_type: Schema.String
});
type FileRef = Schema.Schema.Type<typeof FileRefSchema>;

const decodeFileRef = Schema.decodeUnknownResult(FileRefSchema);

/** Reads a stored file-column value; anything that is not the full reference is not a file. */
export function readFileRef(candidate: unknown): FileRef | null {
	const decoded = decodeFileRef(candidate);
	return decoded._tag === 'Failure' ? null : decoded.success;
}

/** Hydrates a stored reference without assuming anything about the host's public file route. */
export function fileValueFromFileRef(
	ref: FileRef,
	urlFor: (storageKey: string) => string
): FileValue {
	return {
		id: ref.storage_key,
		name: ref.file_name,
		size: ref.file_size,
		type: ref.mime_type,
		url: urlFor(ref.storage_key)
	};
}

/**
 * Persists the object-store key an upload returned, not its UI upload id.
 *
 * Existing hydrated values use the storage key as `id`; a fresh upload deliberately has two
 * identities because its stored key also carries the file extension. `FileInput` speaks the shared
 * display shape, so the upload-only member is read structurally at this boundary.
 */
export function fileRefFromFileValue(file: FileValue): FileRef {
	const uploadedStorageKey = Reflect.get(file, 'storageKey');
	return {
		storage_key:
			typeof uploadedStorageKey === 'string' && uploadedStorageKey.length > 0
				? uploadedStorageKey
				: file.id,
		file_name: file.name,
		file_size: file.size,
		mime_type: file.type
	};
}
