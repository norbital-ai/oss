// SHA-256 in plain JavaScript: a cell and a browser have no `node:crypto`, and what the store hashes (a schema's
// fingerprint, a constraint's name, a migration's checksum) is small. Canonical JSON is what it hashes.
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
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

const K256 = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export const sha256 = (data: Uint8Array | string): Uint8Array => {
	const h = new Uint32Array([
			0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
		]),
		w = new Uint32Array(64);
	blocks(bytesOf(data), (b, o) => {
		for (let t = 0; t < 16; t++) w[t] = word(b, o + t * 4);
		for (let t = 16; t < 64; t++) {
			const x = w[t - 15]!,
				y = w[t - 2]!;
			w[t] =
				w[t - 16]! +
				(rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) +
				w[t - 7]! +
				(rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
		}
		let a = h[0]!,
			bb = h[1]!,
			c = h[2]!,
			d = h[3]!,
			e = h[4]!,
			f = h[5]!,
			g = h[6]!,
			hh = h[7]!;
		for (let t = 0; t < 64; t++) {
			const t1 =
				(hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t]! + w[t]!) |
				0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = bb;
			bb = a;
			a = (t1 + t2) | 0;
		}
		h[0] = h[0]! + a;
		h[1] = h[1]! + bb;
		h[2] = h[2]! + c;
		h[3] = h[3]! + d;
		h[4] = h[4]! + e;
		h[5] = h[5]! + f;
		h[6] = h[6]! + g;
		h[7] = h[7]! + hh;
	});
	return bigEndian(h);
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const toHex = (bytes: Uint8Array): string => {
	let out = '';
	for (const b of bytes) out += HEX[b];
	return out;
};
export const sha256Hex = (input: string | Uint8Array): string => toHex(sha256(input));
/** Canonical JSON: keys sorted, absent members dropped, so equal values hash equal whatever their key order. */
export const canonical = (v: unknown): string =>
	JSON.stringify(v, (_k, x: unknown) => {
		if (x === null || typeof x !== 'object' || Array.isArray(x)) return x;
		const held: Readonly<Record<string, unknown>> = { ...x };
		return Object.fromEntries(
			Object.entries(held)
				.filter(([, value]) => value !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		);
	});
