import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	decodeWireValue,
	encodeFrame,
	encodeWireValue,
	FrameReader,
	FRAME_HEADER_BYTES,
	type GuestFrameHeader,
	type HostFrameHeader
} from '../src/runtime/wire.ts';

/**
 * The framing the host-owned stdio channel runs on.
 *
 * Everything here is about one hazard: the reader never sees the writes the writer made. Stdio hands
 * over whatever bytes have arrived, so a frame can be split anywhere and several frames can arrive
 * as one buffer, and a codec that happens to work when each write lands whole would fail in
 * production and nowhere else. So the split points are asserted explicitly, byte by byte.
 */

function drain(reader: FrameReader): { header: unknown; body: Uint8Array }[] {
	return [...reader.drain()];
}

/** Feed bytes the way a pipe would: in fragments that respect no frame boundary. */
function pushInChunks(reader: FrameReader, bytes: Uint8Array, size: number): void {
	for (let offset = 0; offset < bytes.length; offset += size) {
		reader.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
	}
}

describe('runtime frames', () => {
	it('round-trips a header with no body', () => {
		const header: GuestFrameHeader = {
			t: 'binding',
			id: 7,
			facility: 'db',
			method: 'query',
			args: ['select 1']
		};
		const reader = new FrameReader();
		reader.push(encodeFrame(header));
		const frames = drain(reader);
		assert.equal(frames.length, 1);
		assert.deepEqual(frames[0]?.header, header);
		assert.equal(frames[0]?.body.length, 0);
	});

	it('reassembles one frame delivered a byte at a time', () => {
		const header: HostFrameHeader = { t: 'binding', id: 1, ok: true, value: { rows: [] } };
		const encoded = encodeFrame(header);
		const reader = new FrameReader();
		for (let index = 0; index < encoded.length - 1; index += 1) {
			reader.push(encoded.subarray(index, index + 1));
			assert.deepEqual(drain(reader), [], `frame completed early after ${index + 1} bytes`);
		}
		reader.push(encoded.subarray(encoded.length - 1));
		assert.deepEqual(drain(reader)[0]?.header, header);
	});

	it('yields several interleaved frames out of a single chunk, in order', () => {
		const headers: HostFrameHeader[] = [
			{ t: 'configure', hostPlugins: [] },
			{ t: 'binding', id: 2, ok: true, value: 'second' },
			{ t: 'binding', id: 1, ok: false, error: 'first failed' }
		];
		const encoded = headers.map((header) => encodeFrame(header));
		const joined = new Uint8Array(encoded.reduce((total, frame) => total + frame.length, 0));
		let offset = 0;
		for (const frame of encoded) {
			joined.set(frame, offset);
			offset += frame.length;
		}
		const reader = new FrameReader();
		reader.push(joined);
		assert.deepEqual(
			drain(reader).map((frame) => frame.header),
			headers
		);
	});

	/**
	 * The body region is opaque bytes, not text. A codec that decoded it, or that used a sentinel to
	 * find the end of a frame, would corrupt exactly these values — which is why the length prefix
	 * exists rather than a delimiter.
	 */
	it('preserves a body containing NUL, 0xff and a UTF-8 lead byte, across chunk boundaries', () => {
		const body = new Uint8Array(64 * 1024);
		for (let index = 0; index < body.length; index += 1) body[index] = index % 256;
		body.set([0x00, 0x0a, 0xff, 0xe2, 0x82, 0xac], 0);
		const reader = new FrameReader();
		pushInChunks(reader, encodeFrame({ t: 'ready' }, body), 7);
		const frames = drain(reader);
		assert.equal(frames.length, 1);
		assert.deepEqual(frames[0]?.body, body);
	});

	/**
	 * Binding arguments travel inside the JSON header, so the escaping and the framing have to
	 * compose: bytes that JSON cannot hold become `$u8` first and the frame carries the text.
	 */
	it('carries escaped binary and temporal values inside the header', () => {
		const bytes = new Uint8Array([0x00, 0xff, 0x7f, 0x80]);
		const when = new Date('2026-02-03T04:05:06.000Z');
		const reader = new FrameReader();
		reader.push(
			encodeFrame({
				t: 'binding',
				id: 3,
				facility: 'fileStorage',
				method: 'put',
				args: [encodeWireValue(bytes), encodeWireValue(when)]
			})
		);
		const header = drain(reader)[0]?.header as { args: unknown[] };
		assert.deepEqual(decodeWireValue(header.args[0]), bytes);
		assert.deepEqual(decodeWireValue(header.args[1]), when);
	});

	it('waits without yielding while a frame is still incomplete', () => {
		const encoded = encodeFrame({ t: 'ready' });
		const reader = new FrameReader();
		reader.push(encoded.subarray(0, FRAME_HEADER_BYTES));
		assert.deepEqual(drain(reader), []);
		reader.push(encoded.subarray(FRAME_HEADER_BYTES));
		assert.equal(drain(reader).length, 1);
	});

	/**
	 * A desynchronised stream must fail loudly. Buffering towards a length that no writer will ever
	 * satisfy presents as a runtime that quietly stopped answering, which is the worst of the
	 * available failures — the channel is dead either way, and only one of them says so.
	 */
	it('refuses a length prefix that no frame could have', () => {
		const reader = new FrameReader({ maxFrameBytes: 1024 });
		reader.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
		assert.throws(() => drain(reader), /not a frame this reader can assemble/);
	});

	it('refuses a header longer than the frame that contains it', () => {
		const encoded = encodeFrame({ t: 'ready' });
		const corrupt = encoded.slice();
		new DataView(corrupt.buffer).setUint32(4, 4096, false);
		const reader = new FrameReader();
		reader.push(corrupt);
		assert.throws(() => drain(reader), /declared a 4096-byte header/);
	});

	it('refuses a frame whose declared length cannot hold its own lengths', () => {
		const reader = new FrameReader();
		reader.push(new Uint8Array([0, 0, 0, 2, 0, 0]));
		assert.throws(() => drain(reader), /not a frame this reader can assemble/);
	});

	it('refuses a header that is not JSON', () => {
		const notJson = new TextEncoder().encode('{nope');
		const frame = new Uint8Array(FRAME_HEADER_BYTES + notJson.length);
		const view = new DataView(frame.buffer);
		view.setUint32(0, 4 + notJson.length, false);
		view.setUint32(4, notJson.length, false);
		frame.set(notJson, FRAME_HEADER_BYTES);
		const reader = new FrameReader();
		reader.push(frame);
		assert.throws(() => drain(reader), SyntaxError);
	});
});
