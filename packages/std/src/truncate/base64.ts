export type EncodedPayloadExtracted = {
	base64: string;
	mimeType: string;
	placeholder: string;
};

export type EncodedPayloadStripCtx = {
	extracted: EncodedPayloadExtracted[];
	nextIndex: number;
};

const MIN_ENCODED_LEN = 1024;

const DATA_URL_BASE64_REGEX = /data:([^;,]+);base64,([A-Za-z0-9+/=]+)/g;
const RAW_BASE64_REGEX = /[A-Za-z0-9+/]{1024,}={0,2}/g;
const HEX_BLOB_REGEX = /[0-9a-fA-F]{1024,}/g;

function isBase64Char(c: string): boolean {
	return /^[A-Za-z0-9+/=]$/.test(c);
}

function decodeBase64PrefixBytes(base64: string, maxBytes: number = 16): Uint8Array | null {
	try {
		const raw = base64.slice(0, Math.min(base64.length, 4 * Math.ceil(maxBytes / 3)));
		const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');

		if (typeof atob === 'function') {
			const bin = atob(padded);
			const len = Math.min(bin.length, maxBytes);
			const out = new Uint8Array(len);
			for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
			return out;
		}

		const gB = (
			globalThis as typeof globalThis & {
				Buffer?: { from(data: string, encoding: string): Uint8Array };
			}
		).Buffer;
		if (gB) {
			const buf = gB.from(padded, 'base64');
			return new Uint8Array(buf.subarray(0, Math.min(buf.length, maxBytes)));
		}

		return null;
	} catch {
		return null;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	if (typeof btoa === 'function') {
		let bin = '';
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			const sub = bytes.subarray(i, i + chunk);
			bin += String.fromCharCode(...sub);
		}
		return btoa(bin);
	}

	const gB = (
		globalThis as typeof globalThis & {
			Buffer?: { from(data: Uint8Array): { toString(encoding: 'base64'): string } };
		}
	).Buffer;
	if (gB) return gB.from(bytes).toString('base64');

	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	const gBtoa = (globalThis as typeof globalThis & { btoa?: (s: string) => string }).btoa;
	return gBtoa ? gBtoa(s) : s;
}

function sniffMimeType(bytes: Uint8Array): string {
	if (bytes.length < 12) return 'application/octet-stream';

	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return 'image/png';
	}

	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}

	if (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return 'image/gif';
	}

	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return 'image/webp';
	}

	if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
		return 'application/pdf';
	}

	return 'application/octet-stream';
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0) return null;
	try {
		const out = new Uint8Array(hex.length / 2);
		for (let i = 0; i < hex.length; i += 2) {
			out[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
		}
		return out;
	} catch {
		return null;
	}
}

function makePlaceholder(ctx: EncodedPayloadStripCtx): string {
	ctx.nextIndex += 1;
	return `[Encoded ${ctx.nextIndex}]`;
}

function extractFromDataUrls(text: string, ctx: EncodedPayloadStripCtx): string {
	return text.replace(DATA_URL_BASE64_REGEX, (_match, mimeType: string, base64: string) => {
		const placeholder = makePlaceholder(ctx);
		ctx.extracted.push({
			base64,
			mimeType:
				typeof mimeType === 'string' && mimeType.length > 0 ? mimeType : 'application/octet-stream',
			placeholder
		});
		return placeholder;
	});
}

function extractFromRawBase64(text: string, ctx: EncodedPayloadStripCtx): string {
	return text.replace(RAW_BASE64_REGEX, (match: string, offset: number, full: string) => {
		if (match.length < MIN_ENCODED_LEN) return match;

		const prev = offset > 0 ? full[offset - 1] : '';
		const next = offset + match.length < full.length ? full[offset + match.length] : '';
		if ((prev && isBase64Char(prev)) || (next && isBase64Char(next))) return match;

		const bytes = decodeBase64PrefixBytes(match, 16);
		const mimeType = bytes ? sniffMimeType(bytes) : 'application/octet-stream';

		const placeholder = makePlaceholder(ctx);
		ctx.extracted.push({ base64: match, mimeType, placeholder });
		return placeholder;
	});
}

function extractFromHex(text: string, ctx: EncodedPayloadStripCtx): string {
	return text.replace(HEX_BLOB_REGEX, (match: string, offset: number, full: string) => {
		if (match.length < MIN_ENCODED_LEN) return match;
		if (match.length % 2 !== 0) return match;

		const prev = offset > 0 ? full[offset - 1] : '';
		const next = offset + match.length < full.length ? full[offset + match.length] : '';
		const isHexChar = (c: string) => /^[0-9a-fA-F]$/.test(c);
		if ((prev && isHexChar(prev)) || (next && isHexChar(next))) return match;

		const bytes = hexToBytes(match);
		if (!bytes) return match;
		const mimeType = sniffMimeType(bytes.subarray(0, 16));
		const base64 = bytesToBase64(bytes);

		const placeholder = makePlaceholder(ctx);
		ctx.extracted.push({ base64, mimeType, placeholder });
		return placeholder;
	});
}

export function createEncodedPayloadStripCtx(): EncodedPayloadStripCtx {
	return { extracted: [], nextIndex: 0 };
}

export function stripEncodedPayloads(text: string): {
	text: string;
	extracted: EncodedPayloadExtracted[];
} {
	const ctx = createEncodedPayloadStripCtx();
	return {
		text: stripEncodedPayloadsWithCtx(text, ctx),
		extracted: ctx.extracted
	};
}

export function stripEncodedPayloadsWithCtx(text: string, ctx: EncodedPayloadStripCtx): string {
	let cleaned = text;
	cleaned = extractFromDataUrls(cleaned, ctx);
	cleaned = extractFromRawBase64(cleaned, ctx);
	cleaned = extractFromHex(cleaned, ctx);
	return cleaned;
}
