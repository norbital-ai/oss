import { Clock, Crypto, Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
	Ai,
	Files,
	Geo,
	Port,
	WebRead,
	decisionsSystem1,
	openAiChat,
	structuredSystem1
} from '@norbital-ai/bolt/engine';
import { downloadMedia, type DownloadOptions } from '@norbital-ai/bolt/node';
import { openAiEmbeddings, openRouterChat } from '@norbital-ai/providers/openrouter';
import type { Config } from './config.ts';

/** S3-compatible SigV4, with a provider-requested signed URL expiry. */
export const s3Files = Effect.fn('server.s3Files')(function* (
	endpoint: string,
	credential: string,
	downloads: DownloadOptions = {}
) {
	const client = yield* HttpClient.HttpClient;
	const base = new URL(endpoint);
	const region = base.searchParams.get('region') ?? 'us-east-1';
	base.search = '';
	const colon = credential.indexOf(':');
	const [id, secret] = [credential.slice(0, colon), credential.slice(colon + 1)];
	const object = (key: string) => {
		if (!/^[\w-]+(\.\w+)?$/.test(key)) throw new Error('not a file key');
		return new URL(`${base.pathname.replace(/\/$/, '')}/${key}`, base);
	};
	const signed = (
		method: string,
		url: URL,
		headers: { [k: string]: string },
		payload: string,
		now: number,
		presign?: number
	) => {
		const t = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, ''),
			day = t.slice(0, 8),
			scope = `${day}/${region}/s3/aws4_request`;
		const h: { [k: string]: string } = { host: url.host, ...headers };
		if (presign === undefined)
			Object.assign(h, { 'x-amz-content-sha256': payload, 'x-amz-date': t });
		const names = Object.keys(h).sort(),
			signedHeaders = names.join(';');
		if (presign !== undefined)
			for (const [k, v] of Object.entries({
				'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
				'X-Amz-Credential': `${id}/${scope}`,
				'X-Amz-Date': t,
				'X-Amz-Expires': String(presign),
				'X-Amz-SignedHeaders': signedHeaders
			}))
				url.searchParams.set(k, v);
		const enc = (x: string) =>
			encodeURIComponent(x).replace(
				/[!'()*]/g,
				(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
			);
		const query = [...url.searchParams]
			.map(([k, v]) => `${enc(k)}=${enc(v)}`)
			.sort()
			.join('&');
		const request = [
			method,
			url.pathname,
			query,
			names.map((n) => `${n}:${(h[n] ?? '').trim()}\n`).join(''),
			signedHeaders,
			payload
		].join('\n');
		const hmac = (k: Buffer | string, x: string) => createHmac('sha256', k).update(x).digest();
		const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
		const signature = hmac(
			key,
			['AWS4-HMAC-SHA256', t, scope, createHash('sha256').update(request).digest('hex')].join('\n')
		).toString('hex');
		if (presign !== undefined) {
			url.searchParams.set('X-Amz-Signature', signature);
			return h;
		}
		return {
			...h,
			authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		};
	};
	const call = Effect.fn('s3.request')(function* (
		method: 'PUT' | 'GET' | 'DELETE' | 'POST',
		key: string,
		body?: Uint8Array,
		mime?: string,
		query: Readonly<Record<string, string>> = {}
	) {
		const url = yield* Effect.try({
				try: () => {
					const target = object(key);
					for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
					return target;
				},
				catch: Port.failure('files')
			}),
			payload = createHash('sha256')
				.update(body ?? new Uint8Array())
				.digest('hex');
		const headers = signed(
			method,
			url,
			mime === undefined ? {} : { 'content-type': mime },
			payload,
			yield* Clock.currentTimeMillis
		);
		delete headers['host'];
		let request = HttpClientRequest.make(method)(url.href, { headers });
		if (body !== undefined) request = HttpClientRequest.bodyUint8Array(request, body, mime);
		const response = yield* client.execute(request).pipe(Effect.mapError(Port.failure('files')));
		if (response.status >= 400 && !(method === 'DELETE' && response.status === 404))
			return yield* Effect.fail(
				Port.failure('files')(
					new Error(
						`The files store answered ${response.status} to ${method}: ${(yield* response.text.pipe(Effect.mapError(Port.failure('files')))).slice(0, 300)}`
					)
				)
			);
		return response;
	});
	return Files.of({
		put: (bytes, meta) =>
			Effect.gen(function* () {
				const key = randomUUID();
				yield* call('PUT', key, bytes, meta.mime);
				return {
					key,
					bytes: bytes.byteLength,
					sha256: createHash('sha256').update(bytes).digest('hex'),
					mime: meta.mime
				};
			}),
		get: (key, max) =>
			Effect.gen(function* () {
				const response = yield* call('GET', key);
				if (Number(response.headers['content-length'] ?? 0) > max)
					return yield* Effect.fail(
						Port.failure('files')(new Error(`The file is larger than ${max} bytes`))
					);
				const bytes = new Uint8Array(
					yield* response.arrayBuffer.pipe(Effect.mapError(Port.failure('files')))
				);
				if (bytes.byteLength > max)
					return yield* Effect.fail(
						Port.failure('files')(new Error(`The file is larger than ${max} bytes`))
					);
				return bytes;
			}),
		url: (key, expiresInS) =>
			Effect.gen(function* () {
				const url = yield* Effect.try({ try: () => object(key), catch: Port.failure('files') });
				signed('GET', url, {}, 'UNSIGNED-PAYLOAD', yield* Clock.currentTimeMillis, expiresInS);
				return url.href;
			}),
		remove: (key) => call('DELETE', key).pipe(Effect.asVoid),
		// a multipart upload, a part at a time: a download never holds the whole file
		download: (url) =>
			downloadMedia(
				url,
				{
					begin: (mime) =>
						Effect.gen(function* () {
							const key = randomUUID();
							const answer = yield* (yield* call('POST', key, undefined, mime, {
								uploads: ''
							})).text.pipe(Effect.mapError(Port.failure('files')));
							const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(answer)?.[1];
							if (uploadId === undefined)
								return yield* Effect.fail(
									Port.failure('files')(new Error('The files store began no upload.'))
								);
							const etags: string[] = [];
							return { key, id: uploadId, etags };
						}),
					part: (upload, bytes) =>
						Effect.gen(function* () {
							const response = yield* call('PUT', upload.key, bytes, undefined, {
								partNumber: String(upload.etags.length + 1),
								uploadId: upload.id
							});
							const etag = response.headers['etag'];
							if (etag === undefined)
								return yield* Effect.fail(
									Port.failure('files')(
										new Error('The files store answered a part without its ETag.')
									)
								);
							upload.etags.push(etag);
						}),
					complete: (upload) =>
						Effect.gen(function* () {
							const parts = upload.etags
								.map(
									(etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`
								)
								.join('');
							const answer = yield* (yield* call(
								'POST',
								upload.key,
								new TextEncoder().encode(
									`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`
								),
								'application/xml',
								{ uploadId: upload.id }
							)).text.pipe(Effect.mapError(Port.failure('files')));
							// S3 may answer 200 and put its failure in the body
							if (answer.includes('<Error>'))
								return yield* Effect.fail(
									Port.failure('files')(
										new Error(
											`The files store did not complete the upload: ${answer.slice(0, 300)}`
										)
									)
								);
							return upload.key;
						}),
					abort: (upload) =>
						call('DELETE', upload.key, undefined, undefined, { uploadId: upload.id }).pipe(
							Effect.ignore
						)
				},
				downloads
			)
	});
});
export type Endpoint = { endpoint: string; credential?: string | undefined };
export const openAi = Effect.fn('server.openAi')(function* (
	endpoints: { sys1: Endpoint & { provider?: string }; sys2: Endpoint; embed?: Endpoint },
	config: Config['ai'],
	declared: readonly string[],
	files: Files['Service']['get']
) {
	const context = yield* Effect.context<HttpClient.HttpClient | Crypto.Crypto>();
	const client = yield* HttpClient.HttpClient;
	const system1 =
		endpoints.sys1.provider === 'decisions'
			? decisionsSystem1(
					{
						url: endpoints.sys1.endpoint,
						model: config.sys1 ?? '',
						apiKey: endpoints.sys1.credential ?? ''
					},
					{ httpClient: client }
				)
			: structuredSystem1(
					openAiChat(
						{ ...endpoints.sys1, models: { sys_1: config.sys1 ?? '' } },
						{ httpClient: client }
					),
					'sys_1'
				);
	const embeddings =
		endpoints.embed === undefined
			? undefined
			: openAiEmbeddings({
					files,
					baseUrl: endpoints.embed.endpoint,
					...(endpoints.embed.credential === undefined
						? {}
						: { apiKey: endpoints.embed.credential }),
					model: (name) => {
						const model =
							config.embed[name] ??
							(name === 'default' ? Object.values(config.embed)[0] : undefined);
						return model === undefined
							? undefined
							: typeof model === 'string'
								? { id: model, batch: 1 }
								: { id: model.model, batch: model.inputs ?? 1 };
					}
				});
	return Ai.of({
		ask: system1.ask,
		maxChoices: system1.maxChoices,
		models: declared.filter((name) => config.sys2[name] !== undefined),
		catalog: Effect.succeed({
			models: declared
				.filter((name) => config.sys2[name] !== undefined)
				.map((name) => ({ id: name, label: name })),
			default: declared.find((name) => config.sys2[name] !== undefined) ?? ''
		}),
		infer: openRouterChat({ ...endpoints.sys2, models: config.sys2 }, { httpClient: client }),
		embed: (inputs, name, dimensions) =>
			embeddings === undefined
				? Port.unavailable('ai.embed')
				: embeddings(inputs, name, dimensions).pipe(
						Effect.provide(context),
						Effect.mapError(Port.failure('ai.embed'))
					)
	});
});
const Hit = Schema.Struct({
	lat: Schema.String,
	lon: Schema.String,
	name: Schema.optionalKey(Schema.String),
	display_name: Schema.String
});
export const nominatim = Effect.fn('server.nominatim')(function* (endpoint: string) {
	const client = yield* HttpClient.HttpClient;
	const base = endpoint.replace(/\/$/, '');
	const hit = (value: typeof Hit.Type) => ({
		point: { lat: Number(value.lat), lng: Number(value.lon) },
		label: value.name || value.display_name,
		address: value.display_name
	});
	const get = <A>(path: string, schema: Schema.Decoder<A>) =>
		client
			.execute(
				HttpClientRequest.get(`${base}${path}`, { headers: { 'user-agent': 'bolt-server' } })
			)
			.pipe(
				Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
				Effect.mapError(Port.failure('geo'))
			);
	return Geo.of({
		search: (query) =>
			get(`/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`, Schema.Array(Hit)).pipe(
				Effect.map((rows) => rows.map(hit))
			),
		reverse: (point) =>
			get(
				`/reverse?format=jsonv2&lat=${point.lat}&lon=${point.lng}`,
				Schema.Union([Hit, Schema.Struct({ error: Schema.String })])
			).pipe(Effect.map((value) => ('error' in value ? null : hit(value))))
	});
});
