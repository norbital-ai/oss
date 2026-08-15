import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeWireValue, encodeWireValue } from '../src/runtime/wire.ts';

describe('runtime wire values', () => {
	it('round-trips binary and temporal values', () => {
		const bytes = new Uint8Array([0x00, 0xff, 0x7f, 0x80]);
		const when = new Date('2026-02-03T04:05:06.000Z');
		assert.deepEqual(decodeWireValue(encodeWireValue(bytes)), bytes);
		assert.deepEqual(decodeWireValue(encodeWireValue(when)), when);
	});

	it('round-trips nested objects and arrays', () => {
		const payload = {
			rows: [{ id: 1, at: new Date('2026-08-15T00:00:00.000Z') }],
			blob: new Uint8Array([1, 2, 3])
		};
		assert.deepEqual(decodeWireValue(encodeWireValue(payload)), payload);
	});

	it('leaves JSON-safe values unchanged', () => {
		assert.equal(encodeWireValue('ok'), 'ok');
		assert.equal(encodeWireValue(7), 7);
		assert.equal(encodeWireValue(null), null);
		assert.deepEqual(encodeWireValue({ a: true }), { a: true });
	});
});
