import { Schema } from 'effect';
import type { ChatHost, IncomingFile } from './adapter.ts';
import { PlatformError } from './adapter.ts';

/** The host's guarded fetch owns cancellation and destination checks. */
export const request = async (fetch: ChatHost['fetch'], url: string | URL, init?: RequestInit) => {
	const response = await fetch(url, init);
	if (response.ok) return response;
	const wait = Number(response.headers.get('retry-after'));
	throw new PlatformError(
		`${response.status}: ${await response.text()}`,
		response.status,
		Number.isFinite(wait) && wait > 0 ? wait * 1000 : undefined
	);
};

/** Raw JSON enters a platform only through its declared wire shape. */
export const json = async <A>(schema: Schema.Decoder<A>, response: Response): Promise<A> =>
	Schema.decodeUnknownPromise(schema)(await response.json());
export const parse = <A>(schema: Schema.Codec<A>, text: string): Promise<A> =>
	Schema.decodeUnknownPromise(Schema.fromJsonString(schema))(text);

export const download = async (
	fetch: ChatHost['fetch'],
	url: string,
	headers: Readonly<Record<string, string>> = {}
) => new Uint8Array(await (await request(fetch, url, { headers })).arrayBuffer());

const IMAGES: Readonly<Record<string, string>> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	heic: 'image/heic',
	webp: 'image/webp'
};

/** A media URL, including the inline data URLs Sendblue delivers. */
export const fileOf = (url: string, fetch: ChatHost['fetch']): IncomingFile => {
	const inline = /^data:([^;,]+)/.exec(url)?.[1];
	const name = inline === undefined ? (url.split(/[?#]/)[0]?.split('/').pop() ?? '') : '';
	return {
		name: name || 'attachment',
		mime:
			inline ?? IMAGES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
		fetch: async () =>
			inline === undefined
				? download(fetch, url)
				: new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
	};
};
