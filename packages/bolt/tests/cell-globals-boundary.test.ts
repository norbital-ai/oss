import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { Kernel } from '../src/protocol/cell.ts';

// The cell bundle a host loads into a bare isolate; opening it attaches the cell globals over the kernel.
const bundle = readFileSync(new URL('../build/cell.js', import.meta.url), 'utf8');
const realm = () => {
	const kernel: Kernel = {
		send: () => { throw new Error('No membrane call is expected.'); },
		timer: () => { throw new Error('No timer is expected.'); },
		clear: () => { throw new Error('No timer is expected.'); },
		random: (bytes) => Uint8Array.from({ length: bytes }, (_, index) => index & 255),
		log: () => undefined
	};
	const context = createContext({ kernel });
	runInContext(`${bundle}\n__bolt_cell.open(kernel);`, context);
	return (script: string): unknown => runInContext(script, context);
};

describe('bare cell standard-library boundaries', () => {
	it('decodes offset bytes and reconsumes malformed UTF8 while streaming', () => {
		const run = realm();
		expect(run(`(() => {
			const decoder = new TextDecoder();
			return [
				decoder.decode(new Uint8Array([0, 0xe2, 0x82, 0]).subarray(1, 3), { stream: true }),
				decoder.decode(new Uint8Array([0, 0xac, 0xff, 0x61, 0]).subarray(1, 4)),
				new TextDecoder().decode(new Uint8Array([0xe2, 0x28, 0xa1])),
				new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 34 }, (_, i) => i === 0 ? 0 : i === 33 ? 255 : i + 127).subarray(1, 33))
			];
		})()`)).toEqual([
			'', '€�a', '�(�',
			new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 32 }, (_, index) => index + 128))
		]);
	});

	it('preserves native URL escaping, base64, and UUID version/variant bits', () => {
		const run = realm();
		const value = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String, host: Schema.String, text: Schema.String, encoded: Schema.String, uuid: Schema.String }))(run(`(() => {
			const url = new URL('HTTPS://example.test/é/%F0%9F%98%80?q=%C3%A9+ok#😀');
			return { url: url.href, host: new URL('http://0x7f.1/').host,
				text: atob(' aGk/ '), encoded: btoa('hi?'), uuid: crypto.randomUUID() };
		})()`));
		expect(value.url).toBe(new URL('HTTPS://example.test/é/%F0%9F%98%80?q=%C3%A9+ok#😀').href);
		expect(value.host).toBe(new URL('http://0x7f.1/').host);
		expect(value.text).toBe('hi?');
		expect(value.encoded).toBe(Buffer.from('hi?').toString('base64'));
		expect(value.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});
