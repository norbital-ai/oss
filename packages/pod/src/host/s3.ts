import { createHash, createHmac } from 'node:crypto';
import type { HostFileStorageBinding } from '@norbital-ai/platform-utils/runtime/binding';

/**
 * S3-compatible object storage, signed with SigV4 over `fetch`.
 *
 * Signing is implemented here rather than pulled from an SDK because the surface actually used is
 * three verbs, while every S3 SDK is a large dependency that a workspace with no
 * file fields would still install. SigV4 is a stable, specified algorithm; the cost of owning it
 * is bounded, and it keeps this package free of a vendor client.
 *
 * Works against AWS S3, MinIO, Cloudflare R2, and DigitalOcean Spaces. MinIO and R2 need
 * `forcePathStyle: true` unless the endpoint already resolves per-bucket.
 */

export type S3FileStorageOptions = {
	readonly bucket: string;
	readonly region: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	/** Service endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or `http://127.0.0.1:9000`. */
	readonly endpoint: string;
	/** Address objects as `<endpoint>/<bucket>/<key>`. Required by MinIO and R2. */
	readonly forcePathStyle?: boolean;
	/** Prefix applied to every key, so one bucket can hold several workspaces. */
	readonly prefix?: string;
	readonly sessionToken?: string;
};

const SERVICE = 's3';

function sha256Hex(payload: Uint8Array | string): string {
	return createHash('sha256').update(payload).digest('hex');
}

function hmac(key: Uint8Array | string, value: string): Buffer {
	return createHmac('sha256', key).update(value).digest();
}

/**
 * Percent-encode for SigV4. Encoding is stricter than `encodeURIComponent` — `!`, `'`, `(`, `)`
 * and `*` must be escaped too, and a signature computed over a differently-encoded path is simply
 * wrong, which S3 reports only as a generic mismatch.
 */
function uriEncode(value: string, encodeSlash: boolean): string {
	let encoded = '';
	for (const character of value) {
		if (/[A-Za-z0-9\-._~]/.test(character)) {
			encoded += character;
		} else if (character === '/') {
			encoded += encodeSlash ? '%2F' : '/';
		} else {
			for (const byte of Buffer.from(character, 'utf8')) {
				encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
			}
		}
	}
	return encoded;
}

function amzDate(now: Date): { readonly stamp: string; readonly dateStamp: string } {
	const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	return { stamp, dateStamp: stamp.slice(0, 8) };
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
	return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), SERVICE), 'aws4_request');
}

export function s3FileStorage(options: S3FileStorageOptions): HostFileStorageBinding {
	const endpoint = new URL(options.endpoint);
	const prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : '';

	/** The request URL and the host header S3 will have signed against. */
	const objectUrl = (key: string): URL => {
		const encodedKey = uriEncode(`${prefix}${key}`, false);
		if (options.forcePathStyle) {
			return new URL(
				`${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}/${options.bucket}/${encodedKey}`
			);
		}
		return new URL(`${endpoint.protocol}//${options.bucket}.${endpoint.host}/${encodedKey}`);
	};

	const credentialScope = (dateStamp: string): string =>
		`${dateStamp}/${options.region}/${SERVICE}/aws4_request`;

	const signedRequest = (
		method: string,
		url: URL,
		body: Uint8Array | undefined,
		now: Date
	): Headers => {
		const { stamp, dateStamp } = amzDate(now);
		const payloadHash = body ? sha256Hex(body) : sha256Hex('');
		const headers = new Headers({
			host: url.host,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': stamp
		});
		if (options.sessionToken) headers.set('x-amz-security-token', options.sessionToken);

		const signedHeaderNames = [...headers.keys()].sort();
		const canonicalHeaders = signedHeaderNames
			.map((name) => `${name}:${headers.get(name)?.trim()}\n`)
			.join('');
		const signedHeaders = signedHeaderNames.join(';');
		const canonicalRequest = [
			method,
			url.pathname,
			url.searchParams.toString(),
			canonicalHeaders,
			signedHeaders,
			payloadHash
		].join('\n');
		const stringToSign = [
			'AWS4-HMAC-SHA256',
			stamp,
			credentialScope(dateStamp),
			sha256Hex(canonicalRequest)
		].join('\n');
		const signature = hmac(
			signingKey(options.secretAccessKey, dateStamp, options.region),
			stringToSign
		).toString('hex');

		headers.set(
			'authorization',
			`AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope(dateStamp)}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		);
		return headers;
	};

	const send = async (
		method: string,
		key: string,
		body?: Uint8Array,
		contentType?: string
	): Promise<Response> => {
		const url = objectUrl(key);
		const headers = signedRequest(method, url, body, new Date());
		// Set after signing: `content-type` is not in SignedHeaders, so including it in the canonical
		// request would produce a signature S3 cannot reproduce.
		if (contentType) headers.set('content-type', contentType);
		// A Uint8Array over a plain ArrayBuffer is a valid BodyInit; TS only narrows the generic
		// form, so name it as the buffer view fetch actually accepts.
		return fetch(url, {
			method,
			headers,
			...(body ? { body: body as unknown as BodyInit } : {}) // stupidity: boundary-cast -- non-data Fetch boundary; the bytes remain unchanged.
		});
	};

	const failed = async (response: Response, action: string, key: string): Promise<never> => {
		throw new Error(
			`S3 ${action} failed for "${key}" (${response.status}): ${(await response.text()).slice(0, 500)}`
		);
	};

	return {
		async put(key, body, contentType) {
			const response = await send('PUT', key, body, contentType);
			if (!response.ok) await failed(response, 'put', key);
		},
		async get(key) {
			const response = await send('GET', key);
			if (response.status === 404) return null;
			if (!response.ok) await failed(response, 'get', key);
			return new Uint8Array(await response.arrayBuffer());
		},
		async delete(key) {
			const response = await send('DELETE', key);
			// A delete that finds nothing has already achieved what it was asked to do.
			if (!response.ok && response.status !== 404) await failed(response, 'delete', key);
		}
	};
}
