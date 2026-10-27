import { Clock, Effect, FileSystem, Schema } from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http';
import { createSign } from 'node:crypto';
import { AppShellFailure } from './process.ts';

const ServiceAccount = Schema.Struct({
	client_email: Schema.String,
	private_key: Schema.String,
	token_uri: Schema.String
});
const Token = Schema.Struct({ access_token: Schema.String });
const Edit = Schema.Struct({ id: Schema.String });
const Bundle = Schema.Struct({ versionCode: Schema.Number });

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** An RS256 service-account assertion (RFC 7523), signed with node:crypto. */
const serviceAccountAssertion = (
	account: typeof ServiceAccount.Type,
	nowSeconds: number
): string => {
	const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
		JSON.stringify({
			iss: account.client_email,
			scope: SCOPE,
			aud: account.token_uri,
			iat: nowSeconds,
			exp: nowSeconds + 3600
		})
	)}`;
	return `${unsigned}.${base64url(createSign('RSA-SHA256').update(unsigned).sign(account.private_key))}`;
};

const failed = (step: string) => (cause: { readonly message: string }) =>
	new AppShellFailure({ message: `Google Play ${step} failed: ${cause.message}` });

/** Execute one request; a non-2xx answer fails with its status and the start of its body. */
const send = <A>(
	step: string,
	request: HttpClientRequest.HttpClientRequest,
	schema: Schema.ConstraintDecoder<A>,
	timeout: `${number} seconds` | `${number} minutes`
) =>
	HttpClient.execute(request).pipe(
		Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
			Effect.gen(function* () {
				if (response.status >= 200 && response.status < 300)
					return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
				const body = yield* response.text;
				return yield* new AppShellFailure({
					message: `Google Play ${step} answered ${response.status}: ${body.slice(0, 500)}`
				});
			})
		),
		Effect.timeoutOrElse({
			duration: timeout,
			orElse: () => Effect.fail(new AppShellFailure({ message: `Google Play ${step} timed out` }))
		}),
		Effect.mapError((error) => (error instanceof AppShellFailure ? error : failed(step)(error)))
	);

/**
 * Upload an `.aab` to the internal track: edits.insert → bundles.upload → tracks.update → edits.commit, authenticated
 * as the service account in `accountFile`.
 */
export const uploadToInternalTrack = Effect.fn('AppShell.uploadToInternalTrack')(
	function* (options: {
		readonly packageName: string;
		readonly bundleFile: string;
		readonly accountFile: string;
	}) {
		const fs = yield* FileSystem.FileSystem;
		const account = yield* fs
			.readFileString(options.accountFile)
			.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceAccount))),
				Effect.mapError(failed('service account'))
			);
		const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
		const assertion = yield* Effect.try({
			try: () => serviceAccountAssertion(account, now),
			catch: () => new AppShellFailure({ message: 'The service account private key cannot sign.' })
		});
		const token = yield* send(
			'sign-in',
			HttpClientRequest.post(account.token_uri).pipe(
				HttpClientRequest.bodyUrlParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
					assertion
				})
			),
			Token,
			'30 seconds'
		);
		const authorized = HttpClientRequest.bearerToken(token.access_token);
		const app = encodeURIComponent(options.packageName);
		const edit = yield* send(
			'edits.insert',
			HttpClientRequest.post(`${API}/${app}/edits`).pipe(
				authorized,
				HttpClientRequest.bodyJsonUnsafe({})
			),
			Edit,
			'30 seconds'
		);
		const bytes = yield* fs
			.readFile(options.bundleFile)
			.pipe(Effect.mapError(failed('bundle read')));
		yield* Effect.logInfo(`Uploading ${options.bundleFile} (${bytes.byteLength} bytes)`);
		const bundle = yield* send(
			'bundles.upload',
			HttpClientRequest.post(`${UPLOAD}/${app}/edits/${edit.id}/bundles`).pipe(
				authorized,
				HttpClientRequest.setUrlParam('uploadType', 'media'),
				HttpClientRequest.bodyUint8Array(bytes, 'application/octet-stream')
			),
			Bundle,
			'15 minutes'
		);
		yield* send(
			'tracks.update',
			HttpClientRequest.put(`${API}/${app}/edits/${edit.id}/tracks/internal`).pipe(
				authorized,
				HttpClientRequest.bodyJsonUnsafe({
					track: 'internal',
					releases: [{ versionCodes: [String(bundle.versionCode)], status: 'completed' }]
				})
			),
			Schema.Unknown,
			'30 seconds'
		);
		yield* send(
			'edits.commit',
			HttpClientRequest.post(`${API}/${app}/edits/${edit.id}:commit`).pipe(authorized),
			Schema.Unknown,
			'60 seconds'
		);
		return bundle.versionCode;
	}
);
