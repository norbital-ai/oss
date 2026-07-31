/**
 * The tenant runtime wire protocol.
 *
 * A tenant runtime is an isolated microVM whose only application channel to the outside world is
 * its own stdin/stdout. Core writes request frames to stdin and reads response frames from stdout;
 * the guest writes binding-call frames on the same stdout and reads their results back on stdin.
 * There is no application port, shared runtime socket, or credential inside the guest, so the
 * tenant cannot name a resource that is not already its own.
 *
 * Frame layout — every frame is self-delimiting so the two multiplexed directions can
 * interleave freely:
 *
 * ```text
 * ┌────────────┬─────────────┬──────────────────┬──────────────┐
 * │ u32be len  │ u32be hdrLen│ header (JSON)    │ body (bytes) │
 * └────────────┴─────────────┴──────────────────┴──────────────┘
 *   len = 4 + hdrLen + bodyLen
 * ```
 *
 * HTTP bodies travel as the raw `body` region — a multi-megabyte spreadsheet export costs one
 * copy and no encoding. Binding arguments and results travel inside the JSON header instead,
 * because they are small and may nest binary or temporal values at arbitrary depth; those two
 * types are escaped by {@link encodeWireValue}.
 */

export const FRAME_HEADER_BYTES = 8;

/** A decoded frame: a JSON header plus its raw body region. */
export type WireFrame = {
	readonly header: unknown;
	readonly body: Uint8Array;
};

/**
 * Core → guest. `binding` carries the result of a guest-initiated binding call; `cancel` says the
 * client hung up, which is the only way a server-sent-events response ever ends.
 */
export type HostFrameHeader =
	| {
			readonly t: 'request';
			readonly id: number;
			readonly method: string;
			readonly path: string;
			readonly headers: Record<string, string>;
	  }
	| { readonly t: 'binding'; readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly t: 'binding'; readonly id: number; readonly ok: false; readonly error: string }
	| { readonly t: 'cancel'; readonly id: number }
	| { readonly t: 'notify'; readonly channel: string; readonly payload: string };

/**
 * Guest → Core. A response always arrives as `head` then zero or more `chunk`s then `end`, because
 * the guest cannot know in advance whether a body will complete: an SSE stream stays open until the
 * client disconnects, so a transport that waited for a complete body would wait forever.
 */
export type GuestFrameHeader =
	| {
			readonly t: 'head';
			readonly id: number;
			readonly status: number;
			readonly headers: Record<string, string>;
	  }
	| { readonly t: 'chunk'; readonly id: number }
	| { readonly t: 'end'; readonly id: number }
	| { readonly t: 'error'; readonly id: number; readonly error: string }
	| {
			readonly t: 'binding';
			readonly id: number;
			readonly facility: string;
			readonly method: string;
			readonly args: readonly unknown[];
	  }
	| { readonly t: 'ready' };

export function encodeFrame(header: unknown, body?: Uint8Array | null): Uint8Array {
	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	const bodyBytes = body ?? EMPTY;
	const frame = new Uint8Array(FRAME_HEADER_BYTES + headerBytes.length + bodyBytes.length);
	const view = new DataView(frame.buffer);
	view.setUint32(0, FRAME_HEADER_BYTES - 4 + headerBytes.length + bodyBytes.length, false);
	view.setUint32(4, headerBytes.length, false);
	frame.set(headerBytes, FRAME_HEADER_BYTES);
	frame.set(bodyBytes, FRAME_HEADER_BYTES + headerBytes.length);
	return frame;
}

const EMPTY = new Uint8Array(0);

/**
 * Incremental frame reader. Stdio delivers arbitrary chunk boundaries, so callers push every
 * chunk they receive and drain whatever complete frames that produced.
 */
export class FrameReader {
	#buffered: Uint8Array[] = [];
	#length = 0;

	push(chunk: Uint8Array): void {
		this.#buffered.push(chunk);
		this.#length += chunk.length;
	}

	/** Yield each frame that is now complete, consuming it from the buffer. */
	*drain(): Generator<WireFrame> {
		while (this.#length >= 4) {
			const merged = this.#merge();
			const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
			const remaining = view.getUint32(0, false);
			if (merged.length < 4 + remaining) return;
			const headerLength = view.getUint32(4, false);
			const headerEnd = FRAME_HEADER_BYTES + headerLength;
			yield {
				// stupidity:allow R6b -- frame headers are validated by the switch on `t` at each call site.
				header: JSON.parse(
					new TextDecoder().decode(merged.subarray(FRAME_HEADER_BYTES, headerEnd))
				),
				body: merged.slice(headerEnd, 4 + remaining)
			};
			this.#buffered = [merged.subarray(4 + remaining)];
			this.#length = this.#buffered[0].length;
		}
	}

	#merge(): Uint8Array {
		if (this.#buffered.length === 1) return this.#buffered[0];
		const merged = new Uint8Array(this.#length);
		let offset = 0;
		for (const chunk of this.#buffered) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		this.#buffered = [merged];
		return merged;
	}
}

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
