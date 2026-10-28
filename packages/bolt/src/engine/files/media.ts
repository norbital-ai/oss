// What `download` keeps (compute model §3, "Agents' files"): a body is media by its first bytes, never by the
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
export function mediaType(head: Uint8Array): string | undefined {
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
