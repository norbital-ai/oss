import { Buffer as NativeBuffer } from 'node:buffer';
import vm from 'node:vm';
import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { NODE_SHIM } from '../src/engine/agent/run-js-node.ts';

const evaluate = (source: string, native = false) => {
	const context = vm.createContext({ TextEncoder, TextDecoder, atob, btoa, ...(native ? { Buffer: NativeBuffer } : {}) });
	if (!native) vm.runInContext(NODE_SHIM, context);
	const result: unknown = vm.runInContext(source, context);
	return Schema.decodeUnknownSync(Schema.Json)(structuredClone(result));
};

describe('file-run Buffer accessors', () => {
	it('matches native reads, writes, return offsets and endian bytes inside a subarray', () => {
		const source = `(() => {
			const backing = Buffer.alloc(96, 204), b = backing.subarray(5, 85);
			const writes = [
				b.writeUInt8(171, 0), b.writeInt8(-12, 1),
				b.writeUInt16LE(4660, 2), b.writeUInt16BE(22136, 4),
				b.writeInt16LE(-1234, 6), b.writeInt16BE(-4321, 8),
				b.writeUInt32LE(305419896, 10), b.writeUInt32BE(2427178479, 14),
				b.writeInt32LE(-12345678, 18), b.writeInt32BE(-87654321, 22),
				b.writeFloatLE(12.5, 26), b.writeDoubleLE(-4321.25, 30)
			];
			b.writeUInt32BE(0x41a00000, 38);
			b.writeUInt32BE(0x400921fb, 42); b.writeUInt32BE(0x54442d18, 46);
			b.writeUInt32LE(0x89abcdef, 50); b.writeUInt32LE(0x01234567, 54);
			b.writeUInt32BE(0x01234567, 58); b.writeUInt32BE(0x89abcdef, 62);
			return {
				writes,
				reads: [
					b.readUInt8(0), b.readInt8(1), b.readUInt16LE(2), b.readUInt16BE(4),
					b.readInt16LE(6), b.readInt16BE(8), b.readUInt32LE(10), b.readUInt32BE(14),
					b.readInt32LE(18), b.readInt32BE(22), b.readFloatLE(26), b.readFloatBE(38),
					b.readDoubleLE(30), b.readDoubleBE(42),
					b.readBigUInt64LE(50).toString(), b.readBigUInt64BE(58).toString()
				],
				bytes: Array.from(backing)
			};
		})()`;
		expect(evaluate(source)).toEqual(evaluate(source, true));
	});

	it('retains the existing accessor surface, default offset, class descriptors and Uint aliases', () => {
		expect(evaluate(`(() => {
			const b = Buffer.alloc(8), names = Object.getOwnPropertyNames(Buffer.prototype);
			const readers = names.filter((name) => /^read[A-Z]/.test(name) && !name.includes('Uint'));
			const writers = names.filter((name) => /^write[A-Z]/.test(name) && !name.includes('Uint'));
			const descriptors = [...readers, ...writers].every((name) => {
				const descriptor = Object.getOwnPropertyDescriptor(Buffer.prototype, name);
				return descriptor.enumerable === false && descriptor.configurable === true && descriptor.writable === true
					&& descriptor.value.name === name && descriptor.value.length === (name.startsWith('write') ? 1 : 0);
			});
			const aliases = Object.keys(Buffer.prototype);
			return {
				readers, writers, descriptors,
				aliases: aliases.length === 12 && aliases.every((name) => Buffer.prototype[name] === Buffer.prototype[name.replace('Uint', 'UInt')]),
				defaults: [b.writeUInt16LE(4660), b.readUInt16LE(), b.readUint16LE(), b.readUInt8()],
				unsupported: [typeof b.writeFloatBE, typeof b.writeDoubleBE, typeof b.writeBigUInt64LE, typeof b.readBigInt64LE]
			};
		})()`)).toEqual({
			readers: [
				'readUInt8', 'readInt8', 'readUInt16LE', 'readUInt16BE', 'readInt16LE', 'readInt16BE',
				'readUInt32LE', 'readUInt32BE', 'readInt32LE', 'readInt32BE', 'readFloatLE', 'readFloatBE',
				'readDoubleLE', 'readDoubleBE', 'readBigUInt64LE', 'readBigUInt64BE'
			],
			writers: [
				'writeUInt8', 'writeInt8', 'writeUInt16LE', 'writeUInt16BE', 'writeInt16LE', 'writeInt16BE',
				'writeUInt32LE', 'writeUInt32BE', 'writeInt32LE', 'writeInt32BE', 'writeFloatLE', 'writeDoubleLE'
			],
			descriptors: true,
			aliases: true,
			defaults: [2, 4660, 4660, 52],
			unsupported: ['undefined', 'undefined', 'undefined', 'undefined']
		});
	});

	it('retains DataView bounds and receiver failures without exposing bytes beyond a subarray', () => {
		expect(evaluate(`(() => {
			const b = Buffer.alloc(16).subarray(4, 7);
			const failure = (operation) => { try { operation(); return null; } catch (error) { return error.name; } };
			return [
				failure(() => b.readUInt32LE()), failure(() => b.readUInt16BE(2)),
				failure(() => b.writeInt16LE(-1, 2)), failure(() => b.readBigUInt64BE()),
				failure(() => b.readUInt8(-1)), failure(() => b.writeUInt8(1, -1)),
				failure(() => Buffer.prototype.readUInt8.call({}))
			];
		})()`)).toEqual(['RangeError', 'RangeError', 'RangeError', 'RangeError', 'RangeError', 'RangeError', 'TypeError']);
	});
});
