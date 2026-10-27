import { Clock, Effect, Option, Schema } from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import { LIMITS } from '../engine/contracts.ts';
import { BoltError } from './errors.ts';
import { chargesFor } from '../engine/access/rate.ts';
import { upload } from '../engine/callables/upload.ts';
import { readableFile } from '../engine/decisions/index.ts';
import { TenantDb } from '../engine/db/tenant-db.ts';
import { Files } from '../engine/ports.ts';
import { Manifest, Reads } from '../engine/services.ts';
import {
	bindings,
	header,
	invalid,
	RateLimits,
	requestUrl,
	responseError,
	SessionAuthority
} from './http.ts';
import { HEADERS, PATHS, statusOf } from './wire.ts';
import { ImagePreviews } from './image-previews.ts';

const FileRow = Schema.Struct({
	key: Schema.String,
	mime: Schema.String,
	name: Schema.String,
	field: Schema.String
});
export const filesRoutes = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const url = requestUrl(request);
		if (!url.pathname.startsWith(PATHS.files))
			return Option.none<HttpServerResponse.HttpServerResponse>();
		const authority = yield* (yield* SessionAuthority).of(request);
		if (Option.isNone(authority))
			return Option.some(
				HttpServerResponse.jsonUnsafe(
					{ error: { code: 'unauthenticated', message: 'Sign in first.' } },
					{ status: 401 }
				)
			);
		const auth = authority.value,
			manifest = yield* Manifest,
			db = yield* TenantDb,
			files = yield* Files,
			b = yield* bindings;
		const rest = yield* Effect.try({
			try: () => decodeURIComponent(url.pathname.slice(PATHS.files.length)),
			catch: () => invalid('The file path does not decode.')
		});
		if (request.method === 'PUT') {
			const [model = '', field] = rest.split('.');
			if (field === undefined) return yield* Effect.fail(invalid('upload to <model>.<field>'));
			const charges = chargesFor(
					auth,
					['upload'],
					auth.actor.kind === 'member' ? { actor: auth.actor.id } : {}
				),
				now = yield* Clock.currentTimeMillis;
			const verdict = yield* (yield* RateLimits).charge(charges, now);
			if (!verdict.ok)
				return Option.some(
					HttpServerResponse.jsonUnsafe(
						{ error: { code: 'rateLimited', message: 'Too many uploads; try again later.' } },
						{ status: 429, headers: { 'retry-after': String(verdict.retryAfter) } }
					)
				);
			const disposition = /filename\*=UTF-8''([^;]+)/i.exec(
				header(request, 'content-disposition') ?? ''
			)?.[1];
			const name =
				disposition === undefined
					? 'file'
					: yield* Effect.try({
							try: () => decodeURIComponent(disposition),
							catch: () => invalid('The filename does not decode.')
						});
			const outcome = yield* upload({
				id: header(request, HEADERS.key) ?? '',
				model,
				field,
				name,
				mime: header(request, 'content-type') ?? 'application/octet-stream',
				bytes: new Uint8Array(yield* request.arrayBuffer),
				authority: auth,
				now: b.now,
				rate: charges.map((charge) => ({
					rule: charge.rule,
					bucket: charge.bucket,
					limit: charge.limit,
					windowStart: new Date(now - (now % charge.windowMs)).toISOString()
				}))
			});
			return Option.some(
				outcome.kind === 'committed'
					? HttpServerResponse.jsonUnsafe(outcome.output)
					: HttpServerResponse.jsonUnsafe(
							{
								error: {
									code: outcome.kind === 'refused' ? outcome.code : outcome.kind,
									message: outcome.kind === 'refused' ? outcome.message : outcome.kind
								}
							},
							{ status: statusOf(outcome) }
						)
			);
		}
		if (request.method !== 'GET' && request.method !== 'HEAD')
			return Option.some(
				HttpServerResponse.jsonUnsafe(
					{ error: { code: 'invalid', message: 'files take PUT, GET or HEAD' } },
					{ status: 405 }
				)
			);
		const row = yield* db.one(FileRow, {
			text: 'SELECT key, mime, name, field FROM sys_file WHERE id = $1',
			params: [rest]
		});
		if (Option.isNone(row))
			return yield* Effect.fail(BoltError.make('notFound', 'admission', 'Not found or no access.'));
		const reads = yield* Reads;
		if (
			!(yield* readableFile(
				{ manifest, db, read: reads.run, authority: auth, bindings: b },
				rest,
				row.value.field
			))
		)
			return yield* Effect.fail(BoltError.make('notFound', 'admission', 'Not found or no access.'));
		const preview = url.searchParams.get('preview');
		if (preview !== null && preview !== '64' && preview !== '512' && preview !== '1024')
			return yield* Effect.fail(invalid('An image preview takes 64, 512 or 1024.'));
		const image =
			preview === null
				? {
						bytes: yield* files.get(row.value.key, LIMITS.storedFileBytes),
						mime: row.value.mime,
						derived: false
					}
				: yield* (yield* ImagePreviews).get(
						row.value.key,
						row.value.mime,
						preview === '64' ? 64 : preview === '512' ? 512 : 1024
					);
		const name = image.derived
			? row.value.name.replace(/\.[^./]*$/, '') + (image.mime === 'image/png' ? '.png' : '.jpg')
			: row.value.name;
		const headers = {
			'content-type': image.mime,
			'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
			'cache-control': 'private, max-age=3600',
			'x-content-type-options': 'nosniff',
			'content-length': String(image.bytes.byteLength)
		};
		return Option.some(
			request.method === 'HEAD'
				? HttpServerResponse.empty({ status: 200, headers })
				: HttpServerResponse.uint8Array(image.bytes, { headers })
		);
	}).pipe(
		Effect.catch((error) => Effect.succeed(Option.some(responseError(error)))),
		Effect.catchCause((cause) =>
			Effect.logWarning(cause).pipe(Effect.as(Option.some(responseError(cause))))
		)
	);
