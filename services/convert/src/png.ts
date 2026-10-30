// Pixels to an 8-bit PNG, and a picture turned the way its page shows it.
import { crc32, deflateSync } from 'node:zlib';

export type Pixels = { width: number; height: number; channels: number; data: Uint8Array };

const chunk = (kind: string, body: Buffer) => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(kind, 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body, crc32(head.subarray(4))), 0);
	return Buffer.concat([head, body, crc]);
};
/** Colour whose every pixel is grey, as one channel: a third of the bytes to compress. */
const grey = (p: Pixels): Pixels => {
	if (p.channels !== 3) return p;
	const d = p.data;
	const one = new Uint8Array(d.length / 3);
	for (let i = 0, j = 0; i < one.length; i++, j += 3) {
		const v = d[j]!;
		if (v !== d[j + 1] || v !== d[j + 2]) return p;
		one[i] = v;
	}
	return { ...p, channels: 1, data: one };
};
export function encode(pixels: Pixels): Buffer {
	const p = grey(pixels);
	const stride = p.width * p.channels;
	const raw = Buffer.alloc(p.height * (stride + 1));
	for (let y = 0; y < p.height; y++) raw.set(p.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(p.width, 0);
	ihdr.writeUInt32BE(p.height, 4);
	ihdr[8] = 8;
	ihdr[9] = [0, 0, 4, 2, 6][p.channels]!;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		// ponytail: level 3 trades a little size for speed on page-sized scans; raise it if bytes matter more than CPU.
		chunk('IDAT', deflateSync(raw, { level: 3 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/**
 * The picture as its page shows it. `across` and `down` are where its columns and its rows run on the shown page
 * (y down): each `[dx, dy]` along one axis, for a quarter turn, a half turn or a mirror. Anything else is a skew: the
 * picture stays as stored and `skewed` is true.
 */
export function orient(p: Pixels, across: [number, number], down: [number, number]): { pixels: Pixels; skewed: boolean } {
	const axis = ([x, y]: [number, number]) => (Math.abs(y) <= 0.01 * Math.abs(x) ? 'x' : Math.abs(x) <= 0.01 * Math.abs(y) ? 'y' : undefined);
	const [a, d] = [axis(across), axis(down)];
	if (!a || !d || a === d) return { pixels: p, skewed: true };
	const swap = a === 'y';
	const [w, h] = swap ? [p.height, p.width] : [p.width, p.height];
	const flipCol = (swap ? across[1] : across[0]) < 0;
	const flipRow = (swap ? down[0] : down[1]) < 0;
	if (!swap && !flipCol && !flipRow) return { pixels: p, skewed: false };
	const data = new Uint8Array(p.data.length);
	const n = p.channels;
	for (let j = 0; j < p.height; j++)
		for (let i = 0; i < p.width; i++) {
			const ci = flipCol ? p.width - 1 - i : i;
			const rj = flipRow ? p.height - 1 - j : j;
			const [x, y] = swap ? [rj, ci] : [ci, rj];
			const from = (j * p.width + i) * n;
			const to = (y * w + x) * n;
			for (let k = 0; k < n; k++) data[to + k] = p.data[from + k]!;
		}
	return { pixels: { width: w, height: h, channels: n, data }, skewed: false };
}
