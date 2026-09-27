// `ctx.files.image` (§5.8.1), run in a worker by files.ts, never on the host event loop or in the guest: decodes JPEG,
// PNG and HEIC (libheif), hashes PDQ, reads EXIF, and derives a JPEG. The decoders are field-operations' former guest
// ones (jpeg-js, fast-png, libheif-js, exifr, pdq-wasm), moved host-side.
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import exifr from 'exifr';
import { decode as decodePng } from 'fast-png';
import jpeg from 'jpeg-js';
// @ts-expect-error libheif-js ships no declarations for its bundled wasm build
import createLibheif from 'libheif-js/libheif-wasm/libheif-bundle.mjs';

type Raster = { data: Uint8Array; width: number; height: number; channels: 3 | 4; format: 'jpeg' | 'png' | 'heic' };
type HeifImage = { get_width(): number; get_height(): number; free(): void;
	display(t: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: { data: Uint8ClampedArray } | null) => void): void };
type Libheif = { ready?: Promise<void>; HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[]; decoder: { delete(): void } } };

/** `mif1`/`msf1` are the generic brands phones write for still HEIC; `avif` is absent (the bundle decodes HEVC). */
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']);
const ascii = (b: Uint8Array, from: number) => String.fromCharCode(...b.subarray(from, from + 4));

async function decode(bytes: Uint8Array): Promise<Raster> {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		// RGB, not RGBA: a 12 MP RGBA raster is 48 MiB only to be copied again
		const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
		return { data: d.data, width: d.width, height: d.height, channels: 3, format: 'jpeg' };
	}
	if (bytes[0] === 0x89 && ascii(bytes, 1).startsWith('PNG')) {
		const d = decodePng(bytes);
		if (d.channels !== 3 && d.channels !== 4) throw new Error('a PNG must be RGB or RGBA');
		if (d.depth !== 8) throw new Error('a PNG must have 8-bit channels');
		return { data: d.data as Uint8Array, width: d.width, height: d.height, channels: d.channels, format: 'png' };
	}
	if (bytes.length >= 12 && ascii(bytes, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8))) {
		const heif = await (createLibheif() as Libheif | Promise<Libheif>);
		await heif.ready;
		const decoder = new heif.HeifDecoder(), images = decoder.decode(bytes);
		try {
			const image = images[0];
			if (image === undefined) throw new Error('no image in the HEIF container');
			const width = image.get_width(), height = image.get_height();
			const rgba = await new Promise<Uint8ClampedArray>((resolve, reject) => image.display({ data: new Uint8ClampedArray(width * height * 4), width, height },
				(r) => r === null ? reject(new Error('the HEIF image could not be decoded')) : resolve(r.data)));
			return { data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, channels: 4, format: 'heic' };
		} finally {
			for (const one of images) one.free();
			decoder.decoder.delete();
		}
	}
	throw new Error('ctx.files.image reads JPEG, PNG and HEIC images');
}

/** `r` box-averaged by an integer factor so its longest side is at most `edge`, as `out`-channel pixels (alpha 255). */
function shrink(r: Raster, edge: number, out: 3 | 4) {
	const f = Math.max(1, Math.ceil(Math.max(r.width, r.height) / edge));
	const width = Math.max(1, Math.floor(r.width / f)), height = Math.max(1, Math.floor(r.height / f)), area = f * f;
	const data = new Uint8Array(width * height * out);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		let red = 0, green = 0, blue = 0;
		for (let dy = 0; dy < f; dy++) for (let dx = 0, i = ((y * f + dy) * r.width + x * f) * r.channels; dx < f; dx++, i += r.channels) {
			red += r.data[i]!; green += r.data[i + 1]!; blue += r.data[i + 2]!;
		}
		const o = (y * width + x) * out;
		data[o] = Math.round(red / area); data[o + 1] = Math.round(green / area); data[o + 2] = Math.round(blue / area);
		if (out === 4) data[o + 3] = 255;
	}
	return { data, width, height };
}

// pdq-wasm's ESM entry cannot find its wasm; the CommonJS one loads it
const { PDQ } = createRequire(import.meta.url)('pdq-wasm') as typeof import('pdq-wasm');
/** PDQ reduces every image to 64×64 itself; a larger raster only buys CPU. */
const PDQ_MAX_SIDE = 512;

async function facts(bytes: Uint8Array) {
	const r = await decode(bytes);
	await PDQ.init();
	const pdq = PDQ.hash({ ...shrink(r, PDQ_MAX_SIDE, 3), channels: 3 });
	// EXIF is third-party and often malformed: an unreadable block is simply absent
	const x = (await exifr.parse(bytes, { ifd0: { pick: ['Software', 'Make', 'Model'] }, exif: { pick: ['DateTimeOriginal', 'CreateDate'] },
		gps: { pick: ['GPSLatitudeRef', 'GPSLatitude', 'GPSLongitudeRef', 'GPSLongitude'] } }).catch(() => undefined) ?? {}) as { [tag: string]: unknown };
	const taken = x['DateTimeOriginal'] ?? x['CreateDate'], at = taken instanceof Date ? taken : typeof taken === 'string' ? new Date(taken) : undefined;
	const text = (k: string) => typeof x[k] === 'string' && x[k] !== '' ? { [k.toLowerCase()]: (x[k] as string).trim() } : {};
	const gps = typeof x['latitude'] === 'number' && typeof x['longitude'] === 'number' ? { gps: { lat: x['latitude'], lng: x['longitude'] } } : {};
	return { format: r.format, width: r.width, height: r.height, pdq: Buffer.from(pdq.hash).toString('hex'),
		exif: { ...(at !== undefined && !Number.isNaN(at.getTime()) ? { takenAt: at.toISOString() } : {}), ...gps, ...text('Software'), ...text('Make'), ...text('Model') } };
}

async function derive(bytes: Uint8Array, maxEdge: number) {
	const s = shrink(await decode(bytes), maxEdge, 4);
	// ponytail: EXIF orientation is not applied; rotate here if a derived JPEG must stand upright
	return new Uint8Array(jpeg.encode(s, 85).data);
}

const job = workerData as { bytes: Uint8Array; maxEdge?: number };
parentPort!.postMessage(job.maxEdge === undefined ? await facts(job.bytes) : await derive(job.bytes, job.maxEdge));
