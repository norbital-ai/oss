import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import exifr from 'exifr';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { z } from 'zod';

const exifSchema = z
	.object({
		DateTimeOriginal: z.union([z.date(), z.string()]).optional(),
		CreateDate: z.union([z.date(), z.string()]).optional(),
		Software: z.string().optional()
	})
	.passthrough();

export const photoIntegrityFlags = [
	'exact_duplicate',
	'visual_duplicate',
	'metadata_anomaly',
	'edited_metadata',
	'low_quality'
] as const;

export type PhotoIntegrityFlag = (typeof photoIntegrityFlags)[number];

export interface ExistingPhotoFingerprint {
	norbital_id: string;
	sha256: string;
	perceptual_hash: string;
}

export interface PhotoInspection {
	sha256: string;
	perceptualHash: string;
	width: number;
	height: number;
	format: string;
	flags: PhotoIntegrityFlag[];
}

interface DecodedImage {
	readonly data: Uint8Array;
	readonly width: number;
	readonly height: number;
	readonly format: 'jpeg' | 'png';
}

export function matchPhotoFingerprints(
	sha256: string,
	perceptualHash: string,
	existing: readonly ExistingPhotoFingerprint[]
): { flags: PhotoIntegrityFlag[]; matchedEvidenceIds: string[] } {
	const flags = new Set<PhotoIntegrityFlag>();
	const matches = new Set<string>();
	for (const candidate of existing) {
		if (candidate.sha256 === sha256) {
			flags.add('exact_duplicate');
			matches.add(candidate.norbital_id);
			continue;
		}
		if (perceptualHashDistance(candidate.perceptual_hash, perceptualHash) <= 5) {
			flags.add('visual_duplicate');
			matches.add(candidate.norbital_id);
		}
	}
	return { flags: [...flags], matchedEvidenceIds: [...matches] };
}

function toIsoDate(value: Date | string | undefined): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function expectedMimeType(format: string): string | null {
	switch (format) {
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'webp':
			return 'image/webp';
		case 'gif':
			return 'image/gif';
		case 'tiff':
			return 'image/tiff';
		case 'avif':
			return 'image/avif';
		case 'heif':
			return 'image/heif';
		default:
			return null;
	}
}

export function perceptualHashDistance(left: string, right: string): number {
	if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) return 64;
	let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
	let distance = 0;
	while (value > 0n) {
		distance += Number(value & 1n);
		value >>= 1n;
	}
	return distance;
}

function decodeImage(bytes: Uint8Array): DecodedImage {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		const decoded = decodeJpeg(bytes, {
			useTArray: true,
			formatAsRGBA: true,
			maxResolutionInMP: 40,
			maxMemoryUsageInMB: 128
		});
		return { ...decoded, format: 'jpeg' };
	}
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
		return { data: decoded.data, width: decoded.width, height: decoded.height, format: 'png' };
	}
	throw new Error('Photo evidence currently supports JPEG and PNG images.');
}

function imagePerceptualHash(image: DecodedImage): string {
	const sample = (column: number, row: number): number => {
		const x = Math.round((column * (image.width - 1)) / 8);
		const y = Math.round((row * (image.height - 1)) / 7);
		const offset = (y * image.width + x) * 4;
		return (
			(image.data[offset] * 299 + image.data[offset + 1] * 587 + image.data[offset + 2] * 114) /
			1000
		);
	};
	let bits = 0n;
	for (let row = 0; row < 8; row++) {
		for (let column = 0; column < 8; column++) {
			bits <<= 1n;
			if (sample(column, row) > sample(column + 1, row)) bits |= 1n;
		}
	}
	return bits.toString(16).padStart(16, '0');
}

export async function inspectPhoto(input: {
	bytes: Uint8Array;
	mimeType: string;
	now?: Date;
}): Promise<PhotoInspection> {
	const image = decodeImage(input.bytes);

	let exif: z.infer<typeof exifSchema> = {};
	try {
		const parsed = exifSchema.safeParse(
			await exifr.parse(input.bytes, {
				pick: ['DateTimeOriginal', 'CreateDate', 'Software']
			})
		);
		if (parsed.success) exif = parsed.data;
	} catch (error) {
		console.warn('[bca-photo-evidence] EXIF parsing failed', error);
	}

	const sha256 = createHash('sha256').update(input.bytes).digest('hex');
	const perceptualHash = imagePerceptualHash(image);
	const flags = new Set<PhotoIntegrityFlag>();
	const capturedAt = toIsoDate(exif.DateTimeOriginal ?? exif.CreateDate);
	const expectedMime = expectedMimeType(image.format);
	const now = input.now ?? new Date();
	if (
		(expectedMime != null && input.mimeType.toLowerCase() !== expectedMime) ||
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
	if (image.width < 640 || image.height < 480) flags.add('low_quality');

	return {
		sha256,
		perceptualHash,
		width: image.width,
		height: image.height,
		format: image.format,
		flags: [...flags]
	};
}
