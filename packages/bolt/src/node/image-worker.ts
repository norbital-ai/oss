// `ctx.files.image` (§5.8.1), run in a worker by images.ts, never on the host event loop or in the guest: decodes JPEG,
// PNG and HEIC (libheif), hashes PDQ, reads EXIF, and derives a JPEG. The decoders are field-operations' former guest
// ones (jpeg-js, fast-png, libheif-js, exifr, pdq-wasm), moved host-side.
import { Cause, Effect, Exit, Predicate, Schema } from 'effect';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';
import exifr from 'exifr';
import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import type { ImagePreview } from '../engine/contracts.ts';
import { ImagePreviewMime, ImagePreviewSize } from './images.ts';
class ImageError extends Schema.TaggedError<ImageError>()('ImageError', {
	message: Schema.String
}) {}
const failed = (error: unknown) =>
	new ImageError({
		message: error instanceof Error ? error.message : 'the image could not be decoded'
	});
type Raster = {
	data: Uint8Array;
	width: number;
	height: number;
	channels: 3 | 4;
	format: 'jpeg' | 'png' | 'heic';
};
/** `mif1`/`msf1` are the generic brands phones write for still HEIC; `avif` is absent (the bundle decodes HEVC). */
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']);
const ascii = (b: Uint8Array, from: number) => String.fromCharCode(...b.subarray(from, from + 4));
const MAX_RASTER_PIXELS = 16_000_000;
const rasterSize = (width: number, height: number) => {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width * height > MAX_RASTER_PIXELS
	)
		throw failed(new Error('a PNG or HEIC raster must have at most 16 million pixels'));
};
/** Inspect chunks without inflating: an APNG is delivered intact, and repeated headers cannot bypass the size cap. */
function pngInfo(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		bytes.length < 33 ||
		bytes[0] !== 137 ||
		ascii(bytes, 1) !== 'PNG\r' ||
		bytes[5] !== 10 ||
		bytes[6] !== 26 ||
		bytes[7] !== 10 ||
		view.getUint32(8) !== 13 ||
		ascii(bytes, 12) !== 'IHDR'
	)
		throw failed(new Error('the PNG header is invalid'));
	const width = view.getUint32(16),
		height = view.getUint32(20),
		depth = bytes[24],
		color = bytes[25];
	const channels =
		color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
	if (depth === undefined || channels === 0)
		throw failed(new Error('the PNG color type is invalid'));
	const compressed: Uint8Array[] = [],
		profiles: Uint8Array[] = [];
	let animated = false,
		ended = false;
	for (let offset = 8; offset + 12 <= bytes.length;) {
		const length = view.getUint32(offset),
			type = ascii(bytes, offset + 4),
			end = offset + length + 12;
		if (end > bytes.length || (type === 'IHDR' && offset !== 8))
			throw failed(new Error('the PNG chunks are invalid'));
		if (type === 'acTL') animated = true;
		if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, end - 4));
		if (type === 'iCCP') profiles.push(bytes.subarray(offset + 8, end - 4));
		if (type === 'IEND') {
			ended = true;
			break;
		}
		offset = end;
	}
	if (!ended) throw failed(new Error('the PNG is incomplete'));
	return {
		width,
		height,
		depth,
		color,
		channels,
		compressed,
		profiles,
		animated,
		interlaced: bytes[28] === 1
	};
}
function checkPng(bytes: Uint8Array) {
	const info = pngInfo(bytes);
	rasterSize(info.width, info.height);
	if (info.depth !== 8 && !(info.color === 3 && [1, 2, 4].includes(info.depth)))
		throw failed(new Error('a PNG must have 8-bit channels or an indexed palette'));
	const scan = (x: number, y: number, dx: number, dy: number) => {
		const width = Math.max(0, Math.ceil((info.width - x) / dx)),
			height = Math.max(0, Math.ceil((info.height - y) / dy));
		return width === 0 ? 0 : (Math.ceil((width * info.channels * info.depth) / 8) + 1) * height;
	};
	const expected = info.interlaced
		? scan(0, 0, 8, 8) +
			scan(4, 0, 8, 8) +
			scan(0, 4, 4, 8) +
			scan(2, 0, 4, 4) +
			scan(0, 2, 2, 4) +
			scan(1, 0, 2, 2) +
			scan(0, 1, 1, 2)
		: scan(0, 0, 1, 1);
	// fast-png's inflater has no output cap. Validate the same IDAT stream with Node's native bounded inflater first.
	if (
		inflateSync(Buffer.concat(info.compressed), { maxOutputLength: expected }).byteLength !==
		expected
	)
		throw failed(new Error('the PNG raster length is invalid'));
	let metadataBytes = 0;
	for (const profile of info.profiles) {
		const name = profile.indexOf(0);
		if (name < 1 || name > 79 || profile[name + 1] !== 0 || metadataBytes >= 1024 * 1024)
			throw failed(new Error('the PNG color profile is invalid or exceeds 1 MiB'));
		metadataBytes += inflateSync(profile.subarray(name + 2), {
			maxOutputLength: 1024 * 1024 - metadataBytes
		}).byteLength;
	}
}
function heifBoxes(bytes: Uint8Array, from: number, to: number) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const result: { type: string; from: number; to: number }[] = [];
	if (from < 0 || to > bytes.length || from > to)
		throw failed(new Error('the HEIC container is invalid'));
	for (let offset = from; offset < to;) {
		if (offset + 8 > to) throw failed(new Error('the HEIC boxes are invalid'));
		const length = view.getUint32(offset),
			header = length === 1 ? 16 : 8;
		if (offset + header > to) throw failed(new Error('the HEIC box header is invalid'));
		const size =
			length === 1 ? Number(view.getBigUint64(offset + 8)) : length === 0 ? to - offset : length;
		if (!Number.isSafeInteger(size) || size < header || offset + size > to)
			throw failed(new Error('the HEIC box size is invalid'));
		result.push({ type: ascii(bytes, offset + 4), from: offset + header, to: offset + size });
		offset += size;
	}
	return result;
}
/** Bound encoded dimensions too: a tiny clean-aperture crop must not conceal a huge native decode. */
function checkHeif(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const meta = heifBoxes(bytes, 0, bytes.length).find((box) => box.type === 'meta');
	if (meta === undefined) throw failed(new Error('the HEIC metadata is missing'));
	const properties = heifBoxes(bytes, meta.from + 4, meta.to).find((box) => box.type === 'iprp');
	const container =
		properties === undefined
			? undefined
			: heifBoxes(bytes, properties.from, properties.to).find((box) => box.type === 'ipco');
	if (container === undefined) throw failed(new Error('the HEIC image properties are missing'));
	let found = false;
	for (const property of heifBoxes(bytes, container.from, container.to))
		if (property.type === 'ispe') {
			if (property.from + 12 > property.to)
				throw failed(new Error('the HEIC dimensions are invalid'));
			rasterSize(view.getUint32(property.from + 4), view.getUint32(property.from + 8));
			found = true;
		}
	if (!found) throw failed(new Error('the HEIC encoded dimensions are missing'));
}
const decode = Effect.fn('Image.decode')(function* (
	bytes: Uint8Array
): Effect.fn.Return<Raster, ImageError> {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		// RGB, not RGBA: a 12 MP RGBA raster is 48 MiB only to be copied again
		const d = yield* Effect.try({
			try: () =>
				jpeg.decode(bytes, {
					useTArray: true,
					formatAsRGBA: false,
					maxResolutionInMP: 40,
					maxMemoryUsageInMB: 256
				}),
			catch: failed
		});
		return { data: d.data, width: d.width, height: d.height, channels: 3, format: 'jpeg' };
	}
	if (bytes[0] === 0x89 && ascii(bytes, 1).startsWith('PNG')) {
		yield* Effect.try({
			try: () => checkPng(bytes),
			catch: (error) =>
				Predicate.hasProperty(error, 'code') && error.code === 'ERR_BUFFER_TOO_LARGE'
					? failed(new Error('the PNG inflated data exceeds its bounds'))
					: failed(error)
		});
		const d = yield* Effect.try({ try: () => decodePng(bytes), catch: failed });
		if (d.palette !== undefined) {
			const channels = d.palette[0]?.length;
			if (channels !== 3 && channels !== 4)
				return yield* Effect.fail(failed(new Error('the PNG palette is invalid')));
			const data = yield* Effect.try({ try: () => convertIndexedToRgb(d), catch: failed });
			return { data, width: d.width, height: d.height, channels, format: 'png' };
		}
		if (!(d.data instanceof Uint8Array))
			return yield* Effect.fail(failed(new Error('a PNG must have 8-bit channels')));
		if (d.channels === 4 || (d.channels === 3 && d.transparency === undefined))
			return {
				data: d.data,
				width: d.width,
				height: d.height,
				channels: d.channels,
				format: 'png'
			};
		if (d.channels !== 1 && d.channels !== 2 && d.channels !== 3)
			return yield* Effect.fail(failed(new Error('the PNG channels are invalid')));
		const rgba = new Uint8Array(d.width * d.height * 4);
		for (let pixel = 0; pixel < d.width * d.height; pixel++) {
			const from = pixel * d.channels,
				to = pixel * 4;
			const red = d.data[from]!,
				green = d.channels === 3 ? d.data[from + 1]! : red,
				blue = d.channels === 3 ? d.data[from + 2]! : red;
			rgba[to] = red;
			rgba[to + 1] = green;
			rgba[to + 2] = blue;
			rgba[to + 3] =
				d.channels === 2
					? d.data[from + 1]!
					: d.transparency !== undefined &&
						  red === d.transparency[0] &&
						  (d.channels === 1 || (green === d.transparency[1] && blue === d.transparency[2]))
						? 0
						: 255;
		}
		return { data: rgba, width: d.width, height: d.height, channels: 4, format: 'png' };
	}
	if (bytes.length >= 12 && ascii(bytes, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8))) {
		yield* Effect.try({ try: () => checkHeif(bytes), catch: failed });
		const heif = yield* Effect.tryPromise({
			// the 2 MB libheif bundle loads only for a HEIC: every other image's worker skips parsing it
			try: () => import('libheif-js/libheif-wasm/libheif-bundle.mjs').then((m) => m.default()),
			catch: failed
		});
		if (heif.ready !== undefined)
			yield* Effect.tryPromise({ try: () => heif.ready ?? Promise.resolve(), catch: failed });
		return yield* Effect.acquireUseRelease(
			Effect.try({
				try: () => {
					const decoder = new heif.HeifDecoder();
					return { decoder, images: decoder.decode(bytes) };
				},
				catch: failed
			}),
			({ images }) =>
				Effect.gen(function* (): Effect.fn.Return<Raster, ImageError> {
					const image = images[0];
					if (image === undefined)
						return yield* Effect.fail(failed(new Error('no image in the HEIF container')));
					const width = image.get_width(),
						height = image.get_height();
					yield* Effect.try({ try: () => rasterSize(width, height), catch: failed });
					const rgba = yield* Effect.callback<Uint8ClampedArray, ImageError>((resume) => {
						image.display(
							{ data: new Uint8ClampedArray(width * height * 4), width, height },
							(result) =>
								resume(
									result === null
										? Effect.fail(failed(new Error('the HEIF image could not be decoded')))
										: Effect.succeed(result.data)
								)
						);
					});
					return {
						data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
						width,
						height,
						channels: 4,
						format: 'heic'
					};
				}),
			({ images, decoder }) =>
				Effect.sync(() => {
					for (const image of images) image.free();
					if (decoder.decoder !== null) heif.heif_context_free(decoder.decoder);
					decoder.decoder = null;
				})
		);
	}
	return yield* Effect.fail(failed(new Error('ctx.files.image reads JPEG, PNG and HEIC images')));
});
/** `r` box-averaged by an integer factor so its longest side is at most `edge`, as `out`-channel pixels (alpha 255). */
function shrink(r: Raster, edge: number, out: 3 | 4) {
	const f = Math.max(1, Math.ceil(Math.max(r.width, r.height) / edge));
	const width = Math.max(1, Math.floor(r.width / f)),
		height = Math.max(1, Math.floor(r.height / f)),
		area = f * f;
	const data = new Uint8Array(width * height * out);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let red = 0,
				green = 0,
				blue = 0;
			for (let dy = 0; dy < f; dy++)
				for (
					let dx = 0, i = ((y * f + dy) * r.width + x * f) * r.channels;
					dx < f;
					dx++, i += r.channels
				) {
					red += r.data[i]!;
					green += r.data[i + 1]!;
					blue += r.data[i + 2]!;
				}
			const o = (y * width + x) * out;
			data[o] = Math.round(red / area);
			data[o + 1] = Math.round(green / area);
			data[o + 2] = Math.round(blue / area);
			if (out === 4) data[o + 3] = 255;
		}
	return { data, width, height };
}
// pdq-wasm's ESM entry cannot find its wasm; the CommonJS one loads it
const pdqModule: unknown = createRequire(import.meta.url)('pdq-wasm');
const PdqModule = Schema.Struct({
	PDQ: Schema.declare(
		(value: unknown): value is Pick<typeof import('pdq-wasm').PDQ, 'init' | 'hash'> =>
			(Predicate.isObject(value) || typeof value === 'function') &&
			'init' in value &&
			typeof value.init === 'function' &&
			'hash' in value &&
			typeof value.hash === 'function'
	)
});
const { PDQ } = Schema.decodeUnknownSync(PdqModule)(pdqModule);
/** PDQ reduces every image to 64×64 itself; a larger raster only buys CPU. */
const PDQ_MAX_SIDE = 512;
const facts = Effect.fn('Image.facts')(function* (bytes: Uint8Array) {
	const r = yield* decode(bytes);
	yield* Effect.tryPromise({ try: () => PDQ.init(), catch: failed });
	const pdq = PDQ.hash({ ...shrink(r, PDQ_MAX_SIDE, 3), channels: 3 });
	// EXIF is third-party and often malformed: an unreadable block is simply absent
	const raw: unknown = yield* Effect.tryPromise({
		try: (): Promise<unknown> =>
			exifr.parse(bytes, {
				ifd0: { pick: ['Software', 'Make', 'Model'] },
				exif: { pick: ['DateTimeOriginal', 'CreateDate'] },
				gps: { pick: ['GPSLatitudeRef', 'GPSLatitude', 'GPSLongitudeRef', 'GPSLongitude'] }
			}),
		catch: failed
	}).pipe(
		Effect.tapCause(Effect.logWarning),
		Effect.catch(() => Effect.succeed(undefined))
	);
	const x = Predicate.isObject(raw) ? raw : {};
	const taken = x['DateTimeOriginal'] ?? x['CreateDate'],
		at = taken instanceof Date ? taken : typeof taken === 'string' ? new Date(taken) : undefined;
	const text = (k: string) => {
		const value = x[k];
		return typeof value === 'string' && value !== '' ? { [k.toLowerCase()]: value.trim() } : {};
	};
	const gps =
		typeof x['latitude'] === 'number' && typeof x['longitude'] === 'number'
			? { gps: { lat: x['latitude'], lng: x['longitude'] } }
			: {};
	return {
		format: r.format,
		width: r.width,
		height: r.height,
		pdq: Buffer.from(pdq.hash).toString('hex'),
		exif: {
			...(at !== undefined && !Number.isNaN(at.getTime()) ? { takenAt: at.toISOString() } : {}),
			...gps,
			...text('Software'),
			...text('Make'),
			...text('Model')
		}
	};
});
const derive = Effect.fn('Image.derive')(function* (bytes: Uint8Array, maxEdge: number) {
	const s = shrink(yield* decode(bytes), maxEdge, 4);
	return yield* Effect.try({ try: () => new Uint8Array(jpeg.encode(s, 85).data), catch: failed });
});
/** libheif already applies the primary item's irot/imir; its accompanying EXIF must not rotate that raster twice. */
function heifTransform(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const boxes = (from: number, to: number) => heifBoxes(bytes, from, to);
	const meta = boxes(0, bytes.length).find((box) => box.type === 'meta');
	if (meta === undefined) return false;
	const metadata = boxes(meta.from + 4, meta.to);
	const primary = metadata.find((box) => box.type === 'pitm'),
		properties = metadata.find((box) => box.type === 'iprp');
	if (primary === undefined || properties === undefined) return false;
	const primaryId =
		view.getUint8(primary.from) === 0
			? view.getUint16(primary.from + 4)
			: view.getUint32(primary.from + 4);
	const propertyBoxes = boxes(properties.from, properties.to),
		container = propertyBoxes.find((box) => box.type === 'ipco');
	if (container === undefined) return false;
	const transforms = boxes(container.from, container.to).map(
		(box) => box.type === 'imir' || (box.type === 'irot' && (view.getUint8(box.from) & 3) !== 0)
	);
	for (const association of propertyBoxes.filter((box) => box.type === 'ipma')) {
		let offset = association.from;
		const version = view.getUint8(offset),
			wide = (view.getUint32(offset) & 1) !== 0,
			count = view.getUint32(offset + 4);
		offset += 8;
		for (let item = 0; item < count; item++) {
			if (offset + (version < 1 ? 3 : 5) > association.to)
				throw failed(new Error('the HEIC property associations are invalid'));
			const id = version < 1 ? view.getUint16(offset) : view.getUint32(offset);
			offset += version < 1 ? 2 : 4;
			const length = view.getUint8(offset++);
			for (let index = 0; index < length; index++) {
				if (offset + (wide ? 2 : 1) > association.to)
					throw failed(new Error('the HEIC property association is incomplete'));
				const property = wide ? view.getUint16(offset) & 0x7fff : view.getUint8(offset) & 0x7f;
				offset += wide ? 2 : 1;
				if (id === primaryId && transforms[property - 1]) return true;
			}
		}
	}
	return false;
}
function orient(raster: { data: Uint8Array; width: number; height: number }, orientation: number) {
	if (orientation === 1) return raster;
	const width = orientation >= 5 ? raster.height : raster.width,
		height = orientation >= 5 ? raster.width : raster.height;
	const data = new Uint8Array(raster.data.length);
	for (let y = 0; y < raster.height; y++)
		for (let x = 0; x < raster.width; x++) {
			const tx =
				orientation === 2 || orientation === 3
					? raster.width - 1 - x
					: orientation === 5 || orientation === 8
						? y
						: orientation === 6 || orientation === 7
							? raster.height - 1 - y
							: x;
			const ty =
				orientation === 3 || orientation === 4
					? raster.height - 1 - y
					: orientation === 5 || orientation === 6
						? x
						: orientation === 7 || orientation === 8
							? raster.width - 1 - x
							: y;
			const from = (y * raster.width + x) * 4,
				to = (ty * width + tx) * 4;
			data.set(raster.data.subarray(from, from + 4), to);
		}
	return { data, width, height };
}
/** Alpha-weighted box filtering, with no upscaling or full-sized rotated copy. */
function thumbnail(raster: Raster, edge: number) {
	const scale = Math.min(1, edge / Math.max(raster.width, raster.height));
	const width = Math.max(1, Math.round(raster.width * scale)),
		height = Math.max(1, Math.round(raster.height * scale));
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let red = 0,
				green = 0,
				blue = 0,
				alpha = 0,
				count = 0;
			for (
				let sy = Math.floor((y * raster.height) / height);
				sy < Math.floor(((y + 1) * raster.height) / height);
				sy++
			)
				for (
					let sx = Math.floor((x * raster.width) / width);
					sx < Math.floor(((x + 1) * raster.width) / width);
					sx++
				) {
					const from = (sy * raster.width + sx) * raster.channels,
						a = raster.channels === 4 ? raster.data[from + 3]! : 255;
					red += raster.data[from]! * a;
					green += raster.data[from + 1]! * a;
					blue += raster.data[from + 2]! * a;
					alpha += a;
					count++;
				}
			const to = (y * width + x) * 4;
			data[to] = alpha === 0 ? 0 : Math.round(red / alpha);
			data[to + 1] = alpha === 0 ? 0 : Math.round(green / alpha);
			data[to + 2] = alpha === 0 ? 0 : Math.round(blue / alpha);
			data[to + 3] = Math.round(alpha / count);
		}
	return { data, width, height };
}
const preview = Effect.fn('Image.preview')(function* (
	bytes: Uint8Array,
	mime: string,
	edge: number
): Effect.fn.Return<ImagePreview, ImageError> {
	if (
		bytes[0] === 0x89 &&
		ascii(bytes, 1).startsWith('PNG') &&
		(yield* Effect.try({ try: () => pngInfo(bytes).animated, catch: failed }))
	)
		return { bytes, mime, derived: false };
	if (bytes.length >= 12 && ascii(bytes, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8))) {
		const sequence = yield* Effect.try({
			try: () => {
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
					end = view.getUint32(0);
				if (end < 16 || end > bytes.length || ascii(bytes, 4) !== 'ftyp')
					throw failed(new Error('the HEIC file type is invalid'));
				for (let offset = 8; offset + 4 <= end; offset += 4)
					if (offset !== 12 && ['msf1', 'hevc', 'hevx'].includes(ascii(bytes, offset))) return true;
				return false;
			},
			catch: failed
		});
		if (sequence) return { bytes, mime, derived: false };
	}
	const raster = yield* decode(bytes);
	const containerOriented =
		raster.format === 'heic' &&
		(yield* Effect.try({ try: () => heifTransform(bytes), catch: failed }));
	const orientation = containerOriented
		? 1
		: ((yield* Effect.tryPromise({ try: () => exifr.orientation(bytes), catch: failed })) ?? 1);
	if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8)
		return yield* Effect.fail(failed(new Error('the EXIF orientation is invalid')));
	const scaled = orient(thumbnail(raster, edge), orientation);
	const png = raster.format === 'png';
	const result = yield* Effect.try({
		try: () =>
			png
				? encodePng({ ...scaled, channels: 4, depth: 8 })
				: new Uint8Array(jpeg.encode(scaled, 85).data),
		catch: failed
	});
	if (result.byteLength > 5 * 1024 * 1024)
		return yield* Effect.fail(failed(new Error('the image preview exceeds 5 MiB')));
	return { bytes: result, mime: png ? 'image/png' : 'image/jpeg', derived: true };
});
const Job = Schema.Struct({
	bytes: Schema.declare((value: unknown): value is Uint8Array => value instanceof Uint8Array),
	maxEdge: Schema.optionalKey(Schema.Number),
	preview: Schema.optionalKey(Schema.Struct({ maxEdge: ImagePreviewSize, mime: ImagePreviewMime }))
});
const job = Schema.decodeUnknownSync(Job)(workerData);
const outcome: Exit.Exit<
	Effect.Success<ReturnType<typeof facts>> | Uint8Array | ImagePreview,
	ImageError
> =
	job.preview !== undefined
		? await Effect.runPromiseExit(preview(job.bytes, job.preview.mime, job.preview.maxEdge))
		: job.maxEdge === undefined
			? await Effect.runPromiseExit(facts(job.bytes))
			: await Effect.runPromiseExit(derive(job.bytes, job.maxEdge));
if (Exit.isFailure(outcome)) {
	const error = Cause.squash(outcome.cause);
	throw new Error(error instanceof Error ? error.message : Cause.pretty(outcome.cause));
}
parentPort?.postMessage(outcome.value);
