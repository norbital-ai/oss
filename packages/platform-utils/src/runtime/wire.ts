/**
 * The tenant runtime wire: value escaping, and the frames that carry it over stdio.
 *
 * A tenant runtime and its host exchange JSON: facility arguments and results, and the commands the
 * host sends into the runtime. JSON carries neither of the two types those payloads actually contain
 * — file bytes and `Date` — so both are escaped here on the way out and restored on the way in.
 *
 * The escaping lives in this package rather than in Pod because both ends of the wire need it and the
 * host half cannot depend on the framework.
 *
 * The framing half exists because a sealed sandbox cannot open a connection to its host: measured on
 * a real node, an egress allow rule for the host's private address reaches the eBPF map and the
 * traffic still does not flow. So the host opens the channel instead — it starts the guest with a
 * writable stdin and speaks these frames over the guest's stdio. The guest still *initiates*
 * requests, because `db.query` is synchronous per SQL statement and no host can push an answer to a
 * question nobody has asked; it just no longer initiates *connections*.
 *
 * Frame layout — every frame is self-delimiting so the two multiplexed directions can interleave
 * freely, and so a reader can recover a frame from stdio's arbitrary chunk boundaries:
 *
 * ```text
 * ┌────────────┬─────────────┬──────────────────┬──────────────┐
 * │ u32be len  │ u32be hdrLen│ header (JSON)    │ body (bytes) │
 * └────────────┴─────────────┴──────────────────┴──────────────┘
 *   len = 4 + hdrLen + bodyLen — every byte of the frame after the first u32
 * ```
 *
 * The binding protocol leaves `body` empty: facility arguments and results may nest binary or
 * temporal values at arbitrary depth, so they travel inside the JSON header escaped by
 * {@link encodeWireValue}. The raw body region is kept because it costs nothing and a future frame
 * that carries one large opaque payload should not have to base64 it.
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

/** Bytes before the JSON header: the two big-endian u32 lengths. */
export const FRAME_HEADER_BYTES = 8;

/**
 * The largest frame a reader will assemble.
 *
 * A corrupt length prefix is indistinguishable from a very large frame until the bytes arrive, so
 * without a ceiling a single garbage u32 makes the reader buffer for a payload that will never
 * come — which presents as a runtime that has stopped answering rather than as a broken channel.
 * The limit is far above any real binding payload (a base64-escaped file is the largest thing that
 * travels here) and far below a random u32, so it separates the two cases.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** A decoded frame: a JSON header plus its raw body region. */
export type WireFrame = {
	readonly header: unknown;
	readonly body: Uint8Array;
};

/**
 * Host → guest.
 *
 * `configure` is a push carrying the guest's deployment configuration; the guest must not bind its
 * port before it arrives. `binding` is the response to one guest-initiated call, correlated by `id`,
 * and its failure form carries a message and nothing else, which the agent loop reads.
 */
export type HostFrameHeader =
	| { readonly t: 'configure'; readonly hostPlugins: readonly unknown[] }
	| { readonly t: 'binding'; readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly t: 'binding'; readonly id: number; readonly ok: false; readonly error: string };

/**
 * Guest → host.
 *
 * `binding` is a request: a facility, a method, and arguments escaped by {@link encodeWireValue}.
 * `ready` says the deployment configuration is installed *and* the HTTP port is bound, so it is the
 * one signal that distinguishes a runtime that is serving from a process that merely started.
 */
export type GuestFrameHeader =
	| {
			readonly t: 'binding';
			readonly id: number;
			readonly facility: string;
			readonly method: string;
			readonly args: readonly unknown[];
	  }
	| { readonly t: 'ready' };

const EMPTY = new Uint8Array(0);

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

/**
 * Incremental frame reader. Stdio delivers arbitrary chunk boundaries — one write can arrive as
 * three reads and three writes as one — so callers push every chunk they receive and drain whatever
 * complete frames that produced.
 *
 * Every failure here throws, and a caller must treat the throw as fatal to the channel rather than
 * skipping bytes and trying again: once the stream is out of phase there is no sentinel to resync
 * on, and a "recovered" reader would deliver a plausible frame assembled from the middle of two.
 */
export class FrameReader {
	#buffered: Uint8Array[] = [];
	#length = 0;
	readonly #maxFrameBytes: number;

	constructor(options: { readonly maxFrameBytes?: number } = {}) {
		this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
	}

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
			if (remaining < 4 || remaining > this.#maxFrameBytes) {
				throw new Error(
					`Runtime frame declared ${remaining} bytes, which is not a frame this reader can assemble (limit ${this.#maxFrameBytes})`
				);
			}
			if (merged.length < 4 + remaining) return;
			const headerLength = view.getUint32(4, false);
			const headerEnd = FRAME_HEADER_BYTES + headerLength;
			if (headerEnd > 4 + remaining) {
				throw new Error(
					`Runtime frame declared a ${headerLength}-byte header inside a ${remaining}-byte frame`
				);
			}
			yield {
				// stupidity:allow R6b -- frame headers are validated by the switch on `t` at each call site.
				header: JSON.parse(
					new TextDecoder().decode(merged.subarray(FRAME_HEADER_BYTES, headerEnd))
				),
				body: merged.slice(headerEnd, 4 + remaining)
			};
			const rest = merged.subarray(4 + remaining);
			this.#buffered = [rest];
			this.#length = rest.length;
		}
	}

	#merge(): Uint8Array {
		const only = this.#buffered.length === 1 ? this.#buffered[0] : null;
		if (only) return only;
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
