// Hashing and encodings in the engine's own JavaScript (compute model §14): the cell has no `node:crypto`, and what the
// engine hashes is its own work, metered with it. Random bytes and UUIDs come from `globalThis.crypto`; keys the engine
// must not hold are the host's (`Keys`). SHA-256 is the store's.
import { sha256 } from '@norbital-ai/store';
const utf8 = new TextEncoder();
const bytesOf = (data: Uint8Array | string): Uint8Array =>
	typeof data === 'string' ? utf8.encode(data) : data;

// Merkle–Damgård over 64-byte blocks with a big-endian bit length: full blocks are read in place, only the tail is copied.
const blocks = (data: Uint8Array, block: (bytes: Uint8Array, offset: number) => void): void => {
	const n = data.length,
		full = n - (n % 64);
	for (let i = 0; i < full; i += 64) block(data, i);
	const tail = new Uint8Array(n - full < 56 ? 64 : 128);
	tail.set(data.subarray(full));
	tail[n - full] = 0x80;
	const view = new DataView(tail.buffer);
	view.setUint32(tail.length - 8, Math.floor(n / 0x20000000));
	view.setUint32(tail.length - 4, (n * 8) >>> 0);
	for (let i = 0; i < tail.length; i += 64) block(tail, i);
};
const word = (b: Uint8Array, i: number) =>
	(b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!;
const bigEndian = (h: Uint32Array): Uint8Array => {
	const out = new Uint8Array(h.length * 4),
		view = new DataView(out.buffer);
	h.forEach((v, i) => view.setUint32(i * 4, v));
	return out;
};
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

export const sha1 = (data: Uint8Array | string): Uint8Array => {
	const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]),
		w = new Uint32Array(80);
	blocks(bytesOf(data), (b, o) => {
		for (let t = 0; t < 16; t++) w[t] = word(b, o + t * 4);
		for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!, 1);
		let a = h[0]!,
			bb = h[1]!,
			c = h[2]!,
			d = h[3]!,
			e = h[4]!;
		for (let t = 0; t < 80; t++) {
			const f =
				t < 20
					? ((bb & c) | (~bb & d)) + 0x5a827999
					: t < 40
						? (bb ^ c ^ d) + 0x6ed9eba1
						: t < 60
							? ((bb & c) | (bb & d) | (c & d)) + 0x8f1bbcdc
							: (bb ^ c ^ d) + 0xca62c1d6;
			const next = (rotl(a, 5) + f + e + w[t]!) | 0;
			e = d;
			d = c;
			c = rotl(bb, 30);
			bb = a;
			a = next;
		}
		h[0] = h[0]! + a;
		h[1] = h[1]! + bb;
		h[2] = h[2]! + c;
		h[3] = h[3]! + d;
		h[4] = h[4]! + e;
	});
	return bigEndian(h);
};

/** RFC 2104 over SHA-256 (64-byte blocks). */
export const hmacSha256 = (key: Uint8Array | string, data: Uint8Array | string): Uint8Array => {
	const k = bytesOf(key),
		pad = new Uint8Array(64);
	pad.set(k.length > 64 ? sha256(k) : k);
	const message = bytesOf(data),
		inner = new Uint8Array(64 + message.length),
		outer = new Uint8Array(64 + 32);
	for (let i = 0; i < 64; i++) {
		inner[i] = pad[i]! ^ 0x36;
		outer[i] = pad[i]! ^ 0x5c;
	}
	inner.set(message, 64);
	outer.set(sha256(inner), 64);
	return sha256(outer);
};

/** Constant time over equal lengths; different lengths are unequal (the length is not secret). */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
};

export const fromHex = (hex: string): Uint8Array =>
	Uint8Array.from({ length: hex.length >> 1 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
	B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const encode = (bytes: Uint8Array, alphabet: string, padded: boolean): string => {
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0),
			left = bytes.length - i;
		parts.push(
			alphabet[n >> 18]! +
				alphabet[(n >> 12) & 63]! +
				(left > 1 ? alphabet[(n >> 6) & 63]! : padded ? '=' : '') +
				(left > 2 ? alphabet[n & 63]! : padded ? '=' : '')
		);
	}
	return parts.join('');
};
export const toBase64 = (bytes: Uint8Array): string => encode(bytes, B64, true);
export const toBase64url = (bytes: Uint8Array): string => encode(bytes, B64URL, false);
const SEXTET = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) SEXTET[B64.charCodeAt(i)] = SEXTET[B64URL.charCodeAt(i)] = i;
/** Either alphabet, padded or not; other characters are skipped and `=` ends the value, as Node's decoder does. */
export const fromBase64 = (text: string): Uint8Array => {
	const out = new Uint8Array(Math.floor((text.length * 3) / 4));
	let length = 0,
		bits = 0,
		acc = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 61) break;
		const v = code < 128 ? SEXTET[code]! : -1;
		if (v < 0) continue;
		acc = (acc << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[length++] = (acc >> bits) & 0xff;
		}
	}
	return out.subarray(0, length);
};
