import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { expect, it, vi } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import type { ImagePreviewMime, ImagePreviewSize } from '../src/engine/contracts.ts';
import { Files, Images } from '../src/engine/ports.ts';
import { imagesPort } from '../src/node/images.ts';
import { ImagePreviews, ImagePreviewsLive } from '../src/protocol/image-previews.ts';
import { TestWorkspace } from '../src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	policies: {},
	integrations: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url)));
const chunk = (type: string, bytes: Uint8Array) => {
	const out = Buffer.alloc(bytes.length + 12);
	out.writeUInt32BE(bytes.length, 0);
	out.write(type, 4, 'ascii');
	out.set(bytes, 8);
	out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4);
	return out;
};
const rgba = (width: number, height: number, alpha = 255) => {
	const data = new Uint8Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		data[pixel * 4] = 180;
		data[pixel * 4 + 1] = 90;
		data[pixel * 4 + 2] = 30;
		data[pixel * 4 + 3] = alpha;
	}
	return { data, width, height };
};
const animated = () => {
	const png = encodePng({ ...rgba(2, 1, 128), channels: 4, depth: 8 });
	const control = Buffer.alloc(8),
		frame = Buffer.alloc(26);
	control.writeUInt32BE(1, 0);
	frame.writeUInt32BE(2, 4);
	frame.writeUInt32BE(1, 8);
	frame.writeUInt16BE(100, 22);
	return new Uint8Array(
		Buffer.concat([
			png.subarray(0, 33),
			chunk('acTL', control),
			chunk('fcTL', frame),
			png.subarray(33)
		])
	);
};
const orientedJpeg = (orientation: number) => {
	const pixels = rgba(16, 8);
	for (let y = 0; y < 8; y++)
		for (let x = 0; x < 16; x++) {
			const offset = (y * 16 + x) * 4;
			pixels.data[offset] = x < 8 ? 255 : 0;
			pixels.data[offset + 1] = 0;
			pixels.data[offset + 2] = x < 8 ? 0 : 255;
		}
	const bytes = jpeg.encode(pixels, 95).data;
	const exif = Buffer.from([
		0x45,
		0x78,
		0x69,
		0x66,
		0,
		0,
		0x49,
		0x49,
		0x2a,
		0,
		8,
		0,
		0,
		0,
		1,
		0,
		0x12,
		1,
		3,
		0,
		1,
		0,
		0,
		0,
		orientation,
		0,
		0,
		0,
		0,
		0,
		0,
		0
	]);
	const marker = Buffer.alloc(4);
	marker[0] = 0xff;
	marker[1] = 0xe1;
	marker.writeUInt16BE(exif.length + 2, 2);
	return new Uint8Array(Buffer.concat([bytes.subarray(0, 2), marker, exif, bytes.subarray(2)]));
};

/** A preview through the Node host's image port, as the engine asks for one. */
const imagePreview = (bytes: Uint8Array, mime: ImagePreviewMime, edge: ImagePreviewSize) =>
	Effect.gen(function* () {
		return yield* (yield* Images).preview(bytes, mime, edge);
	}).pipe(Effect.provide(Images.fromAbi(imagesPort)));

it.live('supports all three fixed bounds without upscaling and keeps PNG alpha', () =>
	Effect.gen(function* () {
		const input = encodePng({ ...rgba(1200, 800, 128), channels: 4, depth: 8 });
		for (const edge of [64, 512, 1024] as const) {
			const result = yield* imagePreview(input, 'image/png', edge);
			expect(result).toMatchObject({ mime: 'image/png', derived: true });
			const decoded = decodePng(result.bytes);
			expect(decoded.width).toBe(edge);
			expect(decoded.height).toBe(Math.round((800 * edge) / 1200));
			expect(decoded.channels).toBe(4);
			expect(decoded.data[3]).toBe(128);
		}
		const tiny = yield* imagePreview(
			encodePng({ ...rgba(2, 1, 64), channels: 4, depth: 8 }),
			'image/png',
			64
		);
		expect(decodePng(tiny.bytes)).toMatchObject({ width: 2, height: 1 });
	})
);

it.live('applies JPEG EXIF rotation and mirroring to the actual thumbnail pixels', () =>
	Effect.gen(function* () {
		const rotated = jpeg.decode((yield* imagePreview(orientedJpeg(6), 'image/jpeg', 64)).bytes);
		expect(rotated).toMatchObject({ width: 8, height: 16 });
		expect(rotated.data[0]).toBeGreaterThan(200);
		expect(rotated.data[2]).toBeLessThan(40);
		const bottom = (rotated.height - 1) * rotated.width * 4;
		expect(rotated.data[bottom + 2]).toBeGreaterThan(200);
		const mirrored = jpeg.decode((yield* imagePreview(orientedJpeg(2), 'image/jpeg', 64)).bytes);
		expect(mirrored).toMatchObject({ width: 16, height: 8 });
		expect(mirrored.data[2]).toBeGreaterThan(200);
		expect(mirrored.data[0]).toBeLessThan(40);
	})
);

it.live('honors the native primary HEIC rotation without applying it twice', () =>
	Effect.gen(function* () {
		const bytes = fixture('photo.heic');
		const offset = Buffer.from(bytes).indexOf('irot');
		expect(offset).toBeGreaterThan(0);
		bytes[offset + 4] = 1;
		const result = yield* imagePreview(bytes, 'image/heic', 64);
		expect(result).toMatchObject({ mime: 'image/jpeg', derived: true });
		expect(jpeg.decode(result.bytes)).toMatchObject({ width: 48, height: 64 });
	})
);

it.live(
	'rejects oversized PNG/HEIC dimensions and bounded-inflate overflow before raster decoding',
	() =>
		Effect.gen(function* () {
			const png = fixture('photo.png');
			const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
			header.setUint32(16, 5000);
			header.setUint32(20, 5000);
			expect(yield* Effect.flip(imagePreview(png, 'image/png', 64))).toMatchObject({
				kind: 'upstream',
				message: expect.stringContaining('16 million pixels')
			});
			const heic = fixture('photo.heic');
			const ispe = Buffer.from(heic).indexOf('ispe');
			expect(ispe).toBeGreaterThan(0);
			const dimensions = new DataView(heic.buffer, heic.byteOffset, heic.byteLength);
			dimensions.setUint32(ispe + 8, 5000);
			dimensions.setUint32(ispe + 12, 5000);
			expect(yield* Effect.flip(imagePreview(heic, 'image/heic', 64))).toMatchObject({
				kind: 'upstream',
				message: expect.stringContaining('16 million pixels')
			});
			const small = encodePng({ ...rgba(1, 1), channels: 4, depth: 8 });
			const overflow = new Uint8Array(
				Buffer.concat([
					small.subarray(0, 33),
					chunk('IDAT', deflateSync(new Uint8Array(1024 * 1024))),
					chunk('IEND', new Uint8Array())
				])
			);
			expect(yield* Effect.flip(imagePreview(overflow, 'image/png', 64))).toMatchObject({
				kind: 'upstream',
				message: 'the PNG inflated data exceeds its bounds'
			});
		})
);

it.live(
	'shares small derivatives, evicts at four entries, and never caches originals or failures',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
				const files = Context.get(context, Files);
				const previews = Context.get(
					yield* Layer.build(ImagePreviewsLive.pipe(Layer.provide(Layer.succeedContext(context)))),
					ImagePreviews
				);
				const source = fixture('photo.png');
				const stored = yield* files.put(source, { mime: 'image/png', name: 'photo.png' });
				const get = vi.spyOn(files, 'get');
				yield* Effect.addFinalizer(() => Effect.sync(() => get.mockRestore()));
				const [a, b] = yield* Effect.all(
					[previews.get(stored.key, 'image/png', 64), previews.get(stored.key, 'image/png', 64)],
					{ concurrency: 'unbounded' }
				);
				expect(a).toBe(b);
				expect(get).toHaveBeenCalledTimes(1);
				for (let index = 0; index < 4; index++) {
					const pixels = rgba(2, 1, 100 + index);
					const next = yield* files.put(encodePng({ ...pixels, channels: 4, depth: 8 }), {
						mime: 'image/png',
						name: `${index}.png`
					});
					yield* previews.get(next.key, 'image/png', 64);
				}
				yield* previews.get(stored.key, 'image/png', 64);
				expect(get).toHaveBeenCalledTimes(6);
				const apng = animated();
				const animation = yield* files.put(apng, { mime: 'image/png', name: 'motion.png' });
				for (let count = 0; count < 2; count++)
					expect(yield* previews.get(animation.key, 'image/png', 64)).toEqual({
						bytes: apng,
						mime: 'image/png',
						derived: false
					});
				expect(get).toHaveBeenCalledTimes(8);
				const vector = new TextEncoder().encode(
					'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
				);
				const svg = yield* files.put(vector, { mime: 'image/svg+xml', name: 'drawing.svg' });
				expect(yield* previews.get(svg.key, 'image/svg+xml', 64)).toEqual({
					bytes: vector,
					mime: 'image/svg+xml',
					derived: false
				});
				const invalid = yield* files.put(new Uint8Array([1, 2, 3]), {
					mime: 'image/png',
					name: 'invalid.png'
				});
				for (let count = 0; count < 2; count++)
					expect(yield* Effect.flip(previews.get(invalid.key, 'image/png', 64))).toMatchObject({
						kind: 'upstream'
					});
				expect(get).toHaveBeenCalledTimes(11);
			})
		)
);

it.live('serves valid 1024 PNGs larger than the per-entry cache cap without retaining them', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
			const files = Context.get(context, Files);
			const previews = Context.get(
				yield* Layer.build(ImagePreviewsLive.pipe(Layer.provide(Layer.succeedContext(context)))),
				ImagePreviews
			);
			const pixels = rgba(1024, 1024);
			let state = 0x13579bdf;
			for (let index = 0; index < pixels.data.length; index++) {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				pixels.data[index] = state & 255;
			}
			const stored = yield* files.put(encodePng({ ...pixels, channels: 4, depth: 8 }), {
				mime: 'image/png',
				name: 'noise.png'
			});
			const get = vi.spyOn(files, 'get');
			yield* Effect.addFinalizer(() => Effect.sync(() => get.mockRestore()));
			for (let count = 0; count < 2; count++) {
				const result = yield* previews.get(stored.key, 'image/png', 1024);
				expect(result.bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
				expect(result.bytes.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
				expect(decodePng(result.bytes)).toMatchObject({ width: 1024, height: 1024 });
			}
			expect(get).toHaveBeenCalledTimes(2);
		})
	)
);
