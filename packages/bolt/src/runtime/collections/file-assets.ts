import { Effect, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import type { FilesInterface } from '#lib/runtime/facilities/services.js';

const isString = Schema.is(Schema.String);

export type FileAsset = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly mimeType: string | null;
	readonly size: number;
	readonly bytes: Uint8Array;
}>;

type FileAssetReference = Readonly<{
	readonly storage_key?: unknown;
	readonly file_name?: unknown;
	readonly mime_type?: unknown;
}>;

/** Reads the object named directly by a `file()` value; no asset-row lookup or elevation exists. */
export const readFileAsset = Effect.fn('Collections.readAsset')(function* (
	effectId: EffectId,
	files: FilesInterface,
	file: FileAssetReference
) {
	const storageKey = isString(file?.storage_key) ? file?.storage_key : undefined;
	if (storageKey === undefined) {
		return yield* new Database.FacilityError({
			operation: 'files.read',
			code: 'files.asset_missing',
			message: 'This file value names no stored object, so there is nothing to read.',
			retryable: false,
			outcome: 'known'
		});
	}
	const response = yield* files.execute(effectId, { _tag: 'Read', key: storageKey });
	const bytes = response.bytes ?? new Uint8Array();
	return {
		id: storageKey,
		name: isString(file.file_name) ? file.file_name : storageKey,
		mimeType: isString(file.mime_type) ? file.mime_type : null,
		size: bytes.byteLength,
		bytes
	} satisfies FileAsset;
});

/** Portable base64 for tenant isolates, which have neither Node's Buffer nor reliable `btoa`. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const encodeBase64 = (bytes: Uint8Array): string => {
	let out = '';
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
		out += BASE64_ALPHABET[(triple >> 18) & 63];
		out += BASE64_ALPHABET[(triple >> 12) & 63];
		out += second === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63];
		out += third === undefined ? '=' : BASE64_ALPHABET[triple & 63];
	}
	return out;
};
