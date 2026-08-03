/**
 * Value escaping for the tenant runtime wire.
 *
 * A tenant runtime and its host exchange JSON: facility arguments and results, and the commands the
 * host sends into the runtime. JSON carries neither of the two types those payloads actually contain
 * — file bytes and `Date` — so both are escaped here on the way out and restored on the way in.
 *
 * The escaping lives in this package rather than in Pod because both ends of the wire need it and the
 * host half cannot depend on the framework.
 */

const U8_TAG = '$u8';
const DATE_TAG = '$date';

/**
 * Escape the two values that a plain JSON round-trip would destroy: binary (file bytes, map
 * PNGs) and `Date` (every `timestamptz` column the driver hands back). Everything else is
 * already JSON, and anything that is not — a function, a class instance — was never
 * transferable across the boundary to begin with.
 */
export function encodeWireValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { [U8_TAG]: base64Encode(value) };
	if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
	if (Array.isArray(value)) return value.map(encodeWireValue);
	if (value == null || typeof value !== 'object') return value;
	const encoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) encoded[key] = encodeWireValue(entry);
	return encoded;
}

export function decodeWireValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(decodeWireValue);
	if (value == null || typeof value !== 'object') return value;
	const record = value as Record<string, unknown>;
	const encodedBytes = record[U8_TAG];
	if (typeof encodedBytes === 'string') return base64Decode(encodedBytes);
	const encodedDate = record[DATE_TAG];
	if (typeof encodedDate === 'string') return new Date(encodedDate);
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) decoded[key] = decodeWireValue(entry);
	return decoded;
}

// Node's Buffer is unavailable in some consumers of this module (the browser client imports the
// binding types from the same barrel), so base64 goes through the universal primitives.
function base64Encode(bytes: Uint8Array): string {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function base64Decode(encoded: string): Uint8Array {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
