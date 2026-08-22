import { Schema } from 'effect';

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
export type FileRef = Schema.Schema.Type<typeof FileRefSchema>;

const fileRefLegacySchema = Schema.Struct({
	storage_key: Schema.NonEmptyString,
	file_name: Schema.optionalKey(Schema.String),
	file_size: Schema.optionalKey(Schema.Number),
	mime_type: Schema.optionalKey(Schema.String)
});
const decodeFileRefLegacy = Schema.decodeUnknownResult(fileRefLegacySchema);

/**
 * The tolerant read of a stored file-column value: older uploads predate the column carrying its
 * own display facts, so missing ones fall back to the only stable identity a file has.
 */
export function readFileRef(candidate: unknown): FileRef | null {
	const decoded = decodeFileRefLegacy(candidate);
	if (decoded._tag === 'Failure') return null;
	return {
		storage_key: decoded.success.storage_key,
		file_name: decoded.success.file_name ?? decoded.success.storage_key,
		file_size: decoded.success.file_size ?? 0,
		mime_type: decoded.success.mime_type ?? 'application/octet-stream'
	};
}
