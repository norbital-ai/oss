import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import exifr from 'exifr';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { exceedsSiteTolerance, SITE_LOCATION_TOLERANCE_M } from '../../../lib/haversine.js';

const require = createRequire(import.meta.url);
// pdq-wasm documents its CommonJS entry as the Node path; its ESM entry cannot load the bundled
// WebAssembly. The Vite config carries that entry and its WASM sidecar into the sealed runtime.
const { PDQ } = require('pdq-wasm') as typeof import('pdq-wasm');

const exifSchema = z
	.object({
		DateTimeOriginal: z.union([z.date(), z.string()]).optional(),
		CreateDate: z.union([z.date(), z.string()]).optional(),
		Software: z.string().optional(),
		GPSLatitude: z.number().optional(),
		GPSLongitude: z.number().optional()
	})
	.passthrough();

/** Keep in sync with `photo_evidence` model `flags` enum. */
export const photoIntegrityFlags = [
	'exact_duplicate',
	'visual_duplicate',
	'metadata_anomaly',
	'edited_metadata',
	'low_quality',
	'missing_geolocation',
	'location_mismatch'
] as const;

export type PhotoIntegrityFlag = (typeof photoIntegrityFlags)[number];

/** Flags that escalate the parent job assignment to `suspect` (one-way). */
export const suspectPhotoFlags = [
	'exact_duplicate',
	'visual_duplicate',
	'missing_geolocation',
	'location_mismatch'
] as const satisfies readonly PhotoIntegrityFlag[];

export interface PhotoInspection {
	sha256: string;
	/** Meta PDQ hash as 64-char hex (256-bit). */
	perceptualHash: string;
	/** PDQ quality score 0–100; Meta recommends discarding ≤49. */
	pdqQuality: number;
	width: number;
	height: number;
	captureLocation: { lat: number; lon: number } | null;
	flags: PhotoIntegrityFlag[];
}

/**
 * Meta PDQ near-duplicate threshold as Hamming distance (ThreatExchange default ≤31).
 * Stored as a 256-dim 0/1 `vector`; L2 distance equals √Hamming, so the DB threshold is √31.
 */
export const VISUAL_DUPLICATE_MAX_HAMMING = 31;
export const VISUAL_DUPLICATE_MAX_L2 = Math.sqrt(VISUAL_DUPLICATE_MAX_HAMMING);

/** Below this PDQ quality, the hash is too featureless to trust for similarity. */
export const PDQ_MIN_QUALITY = 50;

interface DecodedImage {
	readonly data: Uint8Array;
	readonly width: number;
	readonly height: number;
	readonly format: 'jpeg' | 'png';
}

let pdqReady: Promise<void> | null = null;

function ensurePdq(): Promise<void> {
	pdqReady ??= PDQ.init().then(() => undefined);
	return pdqReady;
}

function toIsoDate(value: Date | string | undefined): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function expectedMimeType(format: 'jpeg' | 'png'): string {
	switch (format) {
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		default: {
			const _exhaustive: never = format;
			return _exhaustive;
		}
	}
}

function captureLocationFromExif(
	exif: z.infer<typeof exifSchema>
): { lat: number; lon: number } | null {
	const lat = exif.GPSLatitude;
	const lon = exif.GPSLongitude;
	if (lat == null || lon == null) return null;
	return { lat, lon };
}

function decodeImage(bytes: Uint8Array): DecodedImage {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		const decoded = decodeJpeg(bytes, {
			useTArray: true,
			formatAsRGBA: true,
			maxResolutionInMP: 40,
			maxMemoryUsageInMB: 128
		});
		return {
			data: decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(decoded.data),
			width: decoded.width,
			height: decoded.height,
			format: 'jpeg'
		};
	}
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
		return {
			data: decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(decoded.data),
			width: decoded.width,
			height: decoded.height,
			format: 'png'
		};
	}
	throw new Error('Photo evidence currently supports JPEG and PNG images.');
}

/**
 * Inspect a JPEG/PNG evidence file.
 *
 * PDQ hashes are computed in hex here; hooks persist them as a 256-dim 0/1 `vector` via
 * `hexToBinaryEmbedding`. Near-duplicate search uses the same `findNearest` path as omni
 * embeddings (HNSW + L2). Exact duplicates
 * still use SHA-256. EXIF/GPS stays on `exifr`.
 */
export async function inspectPhoto(input: {
	bytes: Uint8Array;
	mimeType: string;
	now?: Date;
}): Promise<PhotoInspection> {
	await ensurePdq();
	const image = decodeImage(input.bytes);
	// PDQ accepts RGB (3) or grayscale (1); drop the alpha channel from RGBA decodes.
	const rgb = new Uint8Array(image.width * image.height * 3);
	for (let i = 0, j = 0; i < image.data.length; i += 4, j += 3) {
		rgb[j] = image.data[i]!;
		rgb[j + 1] = image.data[i + 1]!;
		rgb[j + 2] = image.data[i + 2]!;
	}
	const pdq = PDQ.hash({
		data: rgb,
		width: image.width,
		height: image.height,
		channels: 3
	});
	const perceptualHash = PDQ.toHex(pdq.hash);

	let exif: z.infer<typeof exifSchema> = {};
	try {
		const parsed = exifSchema.safeParse(
			await exifr.parse(input.bytes, {
				pick: ['DateTimeOriginal', 'CreateDate', 'Software', 'GPSLatitude', 'GPSLongitude']
			})
		);
		if (parsed.success) exif = parsed.data;
	} catch (error) {
		console.warn('[field-ops-photo-evidence] EXIF parsing failed', error);
	}

	const sha256 = createHash('sha256').update(input.bytes).digest('hex');
	const flags = new Set<PhotoIntegrityFlag>();
	const capturedAt = toIsoDate(exif.DateTimeOriginal ?? exif.CreateDate);
	const now = input.now ?? new Date();
	const expectedMime = expectedMimeType(image.format);
	if (
		input.mimeType.toLowerCase() !== expectedMime ||
		(capturedAt != null && new Date(capturedAt).getTime() > now.getTime() + 24 * 60 * 60 * 1000)
	) {
		flags.add('metadata_anomaly');
	}
	if (
		exif.Software != null &&
		/photoshop|lightroom|gimp|snapseed|pixelmator/i.test(exif.Software)
	) {
		flags.add('edited_metadata');
	}
	if (image.width < 640 || image.height < 480 || pdq.quality < PDQ_MIN_QUALITY) {
		flags.add('low_quality');
	}

	return {
		sha256,
		perceptualHash,
		pdqQuality: pdq.quality,
		width: image.width,
		height: image.height,
		captureLocation: captureLocationFromExif(exif),
		flags: [...flags]
	};
}

/**
 * Compare the photo's GPS capture point against the job site's map location. Missing capture
 * coordinates always flag; a captured point beyond the site tolerance flags `location_mismatch`.
 */
export function evaluateCaptureGeolocation(
	capture: { lat: number; lon: number } | null,
	site: { lat: number; lon: number } | null,
	maxDistanceM = SITE_LOCATION_TOLERANCE_M
): PhotoIntegrityFlag[] {
	if (capture == null) return ['missing_geolocation'];
	if (site == null) return [];
	if (exceedsSiteTolerance(capture, site, maxDistanceM)) return ['location_mismatch'];
	return [];
}

/** Photo evidence must be attached to exactly one of a job assignment or a variation request. */
export function assertExactlyOnePhotoParent(
	jobAssignmentId: string | null | undefined,
	variationRequestId: string | null | undefined
): void {
	const hasJobAssignment = jobAssignmentId != null && jobAssignmentId !== '';
	const hasVariation = variationRequestId != null && variationRequestId !== '';
	if (hasJobAssignment === hasVariation) {
		throw new Error(
			'Photo evidence must reference exactly one job assignment or variation request.'
		);
	}
}
