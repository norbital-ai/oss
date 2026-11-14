// Media the host decodes off the engine: image facts, previews and crops, Norbital Convert's ingest answer, and what
// `download` keeps.
import { Schema } from 'effect';

/** Source media the image preview decoder accepts. Other media are delivered unchanged. */
export const ImagePreviewMimeSchema = Schema.Literals([
	'image/jpeg',
	'image/png',
	'image/heic',
	'image/heif'
]);

/** Schema of what `ctx.files.image` reads from a JPEG, PNG or HEIC: format, size, the PDQ perceptual hash and EXIF. */
export const ImageMetadataSchema = Schema.Struct({
	format: Schema.Literals(['jpeg', 'png', 'heic']),
	width: Schema.Number,
	height: Schema.Number,
	pdq: Schema.String,
	exif: Schema.Struct({
		taken_at: Schema.optionalKey(Schema.String),
		gps: Schema.optionalKey(Schema.Struct({ lat: Schema.Number, lng: Schema.Number })),
		software: Schema.optionalKey(Schema.String),
		make: Schema.optionalKey(Schema.String),
		model: Schema.optionalKey(Schema.String)
	})
});

/** What an ingest answers (plan 12) with its image bytes decoded by `bytes`: Convert's wire (base64) or the port's ABI. */
export const ingest_answer = <B extends Schema.Codec<Uint8Array, unknown>>(bytes: B) => {
	const fields = {
		images: Schema.Array(Schema.Struct({ name: Schema.String, mime: Schema.String, bytes })),
		meta: Schema.Struct({
			usage: Schema.optionalKey(
				Schema.Struct({
					calls: Schema.Array(Schema.String),
					model: Schema.String,
					input: Schema.Number,
					output: Schema.Number,
					cost: Schema.Number
				})
			),
			stats: Schema.Struct({
				pages: Schema.NullOr(Schema.Number),
				bytes: Schema.Number,
				cpuMs: Schema.Number,
				wallMs: Schema.Number
			})
		})
	};
	return Schema.Union([
		Schema.Struct({ kind: Schema.Literal('document'), html: Schema.String, ...fields }),
		Schema.Struct({ kind: Schema.Literal('data'), json: Schema.Json, ...fields })
	]);
};
/** Schema of Norbital Convert's ingest answer, its images as bytes. */
export const IngestedSchema = ingest_answer(Schema.Uint8Array);
/**
 * Plan 12, Norbital Convert's ingest: parsing only, never OCR; a host may add a scanned page's transcript under its image in a `data-read` section. A `document` (pdf, office, html, text, images, audio) is
 * sanitised HTML, one block element per line (audio: one `<section data-speaker data-start data-end>` per segment); `data`
 * (a spreadsheet, CSV or JSON) is its cells as `{ sheets }`, or a JSON file's own value. `images` are referenced by name.
 */
export type Ingested = typeof IngestedSchema.Type;
/** What `ctx.files.image` reads from a JPEG, PNG or HEIC: format, size, the PDQ perceptual hash and EXIF. */
export type ImageMetadata = typeof ImageMetadataSchema.Type;
/** The edge lengths, in pixels, an image preview is made at. */
export type ImagePreviewSize = 64 | 512 | 1024;
/** Source media the image preview decoder accepts (`ImagePreviewMimeSchema`). */
export type ImagePreviewMime = typeof ImagePreviewMimeSchema.Type;
/** A rectangle in the oriented image, with coordinates from zero to one. */
export type ImageCrop = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	/** Enlarge a small region until its longer edge reaches this many pixels, at most 4×. */
	min_edge?: number;
};
/** A preview at most `maxEdge` on its long side, EXIF-oriented; `derived: false` is the original (an APNG, a HEIC sequence). */
export type ImagePreview = {
	readonly bytes: Uint8Array;
	readonly mime: string;
	readonly derived: boolean;
};
/**
 * Image decoding off the engine (JPEG, PNG, HEIC; rasters at most 16 million pixels, input at most
 * `HOST_LIMITS.storedFileBytes`): `facts`, a JPEG at most `maxEdge` on its long side, and a preview at most 5 MiB.
 */
export interface ImagesPort {
	facts(bytes: Uint8Array, signal: AbortSignal): Promise<ImageMetadata>;
	jpeg(bytes: Uint8Array, maxEdge: number, signal: AbortSignal): Promise<Uint8Array>;
	/** Lossless PNG of the selected oriented pixels, at most 5 MiB; the source stays unchanged. */
	crop(bytes: Uint8Array, box: ImageCrop, signal: AbortSignal): Promise<Uint8Array>;
	preview(
		bytes: Uint8Array,
		mime: ImagePreviewMime,
		maxEdge: ImagePreviewSize,
		signal: AbortSignal
	): Promise<ImagePreview>;
}

// ── download ──
// What `download` keeps ("Agents' files"): a body is media by its first bytes, never by the
// `content-type` it was sent with: images, audio, video, PDFs and CAD models and drawings. Everything else (executables, source code, archives, the unrecognized) is refused;
// an HTML page is kept as a document beside PDFs.

/** `download`'s limits: the body cap, the stall that ends it, the redirect hops followed, and the head its type is read from. */
export const DOWNLOAD = {
	maxBytes: 100 * 1024 * 1024,
	idleMs: 20_000,
	redirects: 5,
	headBytes: 4096
} as const;

const ascii = (b: Uint8Array, at: number, length: number): string =>
	String.fromCharCode(...b.subarray(at, at + length));
const HEIF = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

/** The media type of a body from its first `DOWNLOAD.headBytes` bytes (all of a shorter body); `undefined` is not media. */
export function media_type(head: Uint8Array): string | undefined {
	const b0 = head[0] ?? 0,
		b1 = head[1] ?? 0;
	if (b0 === 0x89 && ascii(head, 1, 7) === 'PNG\r\n\x1a\n') return 'image/png';
	if (b0 === 0xff && b1 === 0xd8 && head[2] === 0xff) return 'image/jpeg';
	if (ascii(head, 0, 4) === 'GIF8') return 'image/gif';
	if (ascii(head, 0, 4) === 'RIFF') {
		const form = ascii(head, 8, 4);
		return form === 'WEBP' ? 'image/webp' : form === 'WAVE' ? 'audio/wav' : undefined;
	}
	if (ascii(head, 4, 4) === 'ftyp') {
		const brand = ascii(head, 8, 4);
		return HEIF.has(brand)
			? 'image/heic'
			: brand === 'avif' || brand === 'avis'
				? 'image/avif'
				: brand === 'M4A '
					? 'audio/mp4'
					: brand === 'qt  '
						? 'video/quicktime'
						: 'video/mp4';
	}
	if (b0 === 0x1a && b1 === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
	if (ascii(head, 0, 3) === 'ID3') return 'audio/mpeg';
	// an MPEG audio frame's 11-bit sync; layer bits 00 are ADTS AAC
	if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return (b1 & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
	if (ascii(head, 0, 4) === 'OggS') return 'audio/ogg';
	if (ascii(head, 0, 4) === 'fLaC') return 'audio/flac';
	if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
	const tiff = ascii(head, 0, 4);
	if (tiff === 'II*\0' || tiff === 'MM\0*') return 'image/tiff';
	// CAD models and drawings, each by its own signature; zip and OLE containers (3MF, SolidWorks) stay archives
	if (ascii(head, 0, 13) === 'ISO-10303-21;') return 'model/step';
	if (/^AC10\d\d/.test(ascii(head, 0, 6))) return 'image/vnd.dwg';
	if (ascii(head, 0, 4) === 'glTF') return 'model/gltf-binary';
	if (ascii(head, 0, 18) === 'AutoCAD Binary DXF') return 'image/vnd.dxf';
	const text = ascii(head, 0, head.length);
	if (/^\s*0\r?\nSECTION\r?\n/.test(text)) return 'image/vnd.dxf';
	if (/^solid[ \t][^\n]*\r?\n\s*(facet|endsolid)/.test(text)) return 'model/stl';
	// an IGES start record: 80 columns, its section letter in column 73
	if (/^.{72}S[ \d]{7}\r?\n/.test(text)) return 'model/iges';
	// An HTML page is a document the person asked to keep, like a PDF; source code and archives remain refused.
	const page = text.trimStart().toLowerCase();
	if (page.startsWith('<!doctype html') || page.startsWith('<html')) return 'text/html';
	return undefined;
}
