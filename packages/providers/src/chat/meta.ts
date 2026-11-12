// What Messenger, Instagram and WhatsApp share: Meta's webhook (a GET handshake, then `x-hub-signature-256`, an HMAC of
// the raw body with the app secret), the Graph API's answers, and fitting text into a message.
import { Schema } from 'effect';
import type { ChatField, ChatHost, Delivery, IncomingFile } from './adapter.ts';
import { nothing, PlatformError, Unverified } from './adapter.ts';
import { download, json, parse } from './http.ts';
import { hmac, signed } from './verify.ts';

type Fetch = ChatHost['fetch'];
export const Attachment = Schema.Struct({
	type: Schema.String,
	payload: Schema.optionalKey(Schema.Struct({ url: Schema.optionalKey(Schema.String) }))
});
/** Graph error codes for "too many calls", whatever HTTP status they arrive with. */
const LIMITED = new Set([4, 32, 613]);

export const appFields: readonly ChatField[] = [
	{ name: 'appSecret', label: { en: 'App secret', zh: '应用密钥' }, secret: true },
	{
		name: 'verifyToken',
		label: { en: 'Webhook verify token', zh: 'Webhook 验证令牌' },
		secret: true
	}
];
/** Proves a delivery is Meta's: the answer to its GET handshake, or `null` for a signed POST, ready to parse. */
export const verified = (
	request: Request,
	body: string,
	verifyToken: string,
	appSecret: string
): Delivery | null => {
	if (request.method !== 'GET') {
		signed(request.headers.get('x-hub-signature-256'), `sha256=${hmac(appSecret, body, 'hex')}`);
		return null;
	}
	const query = new URL(request.url).searchParams;
	if (query.get('hub.mode') !== 'subscribe') throw new Unverified('not a subscription');
	signed(query.get('hub.verify_token'), verifyToken);
	return nothing(new Response(query.get('hub.challenge') ?? ''));
};
/** The `messaging` events of a delivery for `object`, the form Messenger and Instagram both arrive in. */
export const messaging = async <Event>(
	schema: Schema.Codec<Event>,
	body: string,
	object: string
): Promise<readonly Event[]> => {
	const hook = await parse(
		Schema.Struct({
			object: Schema.optionalKey(Schema.String),
			entry: Schema.optionalKey(
				Schema.Array(Schema.Struct({ messaging: Schema.optionalKey(Schema.Array(schema)) }))
			)
		}),
		body
	);
	return hook.object === object ? (hook.entry ?? []).flatMap((one) => one.messaging ?? []) : [];
};
/** One Graph API call, a POST when it has a `body`. */
export const graph = async <A>(
	schema: Schema.Decoder<A>,
	fetch: Fetch,
	url: string,
	headers: Readonly<Record<string, string>>,
	body?: object
): Promise<A> => {
	const response = await fetch(url, {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
	if (response.ok) return json(schema, response);
	const answer = await json(
		Schema.Struct({
			error: Schema.optionalKey(
				Schema.Struct({
					message: Schema.optionalKey(Schema.String),
					code: Schema.optionalKey(Schema.Number)
				})
			)
		}),
		response
	).catch(() => ({ error: undefined }));
	throw new PlatformError(
		answer.error?.message ?? `Graph API answered ${response.status}`,
		LIMITED.has(answer.error?.code ?? 0) ? 429 : response.status
	);
};
/** The files a Messenger or Instagram message carries: each is a URL on Meta's CDN, read without a token. */
export const filesOf = (
	attachments: readonly (typeof Attachment.Type)[] | undefined,
	fetch: Fetch
): readonly IncomingFile[] =>
	(attachments ?? []).flatMap(({ type, payload }) => {
		const url = payload?.url;
		if (url === undefined) return [];
		return [
			{
				name: new URL(url).pathname.split('/').pop() || type,
				mime: ['image', 'video', 'audio'].includes(type) ? `${type}/*` : 'application/octet-stream',
				fetch: () => download(fetch, url)
			}
		];
	});
/** `text` cut between characters into pieces of at most `limit` by `size`: each platform refuses a longer message. */
export const pieces = (
	text: string,
	limit: number,
	size: (piece: string) => number = (piece) => piece.length
) => {
	const whole: string[] = [];
	let piece = '';
	for (const character of text) {
		if (size(piece + character) > limit) {
			whole.push(piece);
			piece = '';
		}
		piece += character;
	}
	return [...whole, piece];
};
