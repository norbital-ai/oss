import type { ComputationDefinition } from './definition.js';

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => [k, canonicalize(v)])
	);
}

export function hashDefinition(def: ComputationDefinition): string {
	const canonical = canonicalize({
		id: def.id,
		tables: def.tables,
		exprs: def.exprs,
		outputs: def.outputs,
		dependsOn: def.dependsOn ?? []
	});
	return sha256(JSON.stringify(canonical));
}

export function sha256Json(value: unknown): string {
	return sha256(JSON.stringify(value));
}

function sha256(message: string): string {
	const msgBytes = new TextEncoder().encode(message);
	const K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
	];

	const H: [number, number, number, number, number, number, number, number] = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	];

	const l = msgBytes.length;
	const bl = l * 8;
	// k = number of zero-padding bytes: minimal k s.t. (l + 1 + k + 8) % 64 == 0
	const k = (64 - ((l + 9) % 64)) % 64;
	const padLen = l + 1 + k + 8;
	const padded = new Uint8Array(padLen);
	padded.set(msgBytes);
	padded[l] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padLen - 8, 0, false);
	view.setUint32(padLen - 4, bl >>> 0, false);

	for (let o = 0; o < padLen; o += 64) {
		const W = new Array<number>(64);
		for (let i = 0; i < 16; i++) W[i] = view.getUint32(o + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const w15 = W[i - 15]!;
			const w2 = W[i - 2]!;
			const s0 = rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3);
			const s1 = rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10);
			W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i]! + W[i]!) | 0;
			const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		H[0] = (H[0] + a) | 0;
		H[1] = (H[1] + b) | 0;
		H[2] = (H[2] + c) | 0;
		H[3] = (H[3] + d) | 0;
		H[4] = (H[4] + e) | 0;
		H[5] = (H[5] + f) | 0;
		H[6] = (H[6] + g) | 0;
		H[7] = (H[7] + h) | 0;
	}
	return H.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

function rr(v: number, n: number): number {
	return ((v >>> n) | (v << (32 - n))) >>> 0;
}
