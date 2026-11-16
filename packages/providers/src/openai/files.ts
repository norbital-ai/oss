import { encode } from 'effect/encoding/Base64';
import { imageLabel } from '@norbital-ai/host-api';
import type { Json } from 'effect/Schema';
const TEXT = /^(text\/|application\/(json|csv|xml|[\w.-]+\+(json|xml))$)/;
const dataUrl = (f: { mime: string; bytes: Uint8Array }) =>
	`data:${f.mime};base64,${encode(f.bytes)}`;
/** One file a tool opened as chat parts: an image as its size and the image, text as text; anything else is parsed by `read_file`. */
export function fileParts(f: { mime: string; bytes: Uint8Array }, name: string): Json[] {
	if (f.mime.startsWith('image/'))
		return [
			{ type: 'text', text: imageLabel(name, f.bytes) },
			{ type: 'image_url', image_url: { url: dataUrl(f) } }
		];
	if (TEXT.test(f.mime))
		return [{ type: 'text', text: `${name} (${f.mime}):\n${new TextDecoder().decode(f.bytes)}` }];
	return [{ type: 'text', text: `${name} (${f.mime}): read_file reads it` }];
}
