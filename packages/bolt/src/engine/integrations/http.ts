// The http driver's request (§2.1, §2.6): what a host's http provider runs for an instance's `ctx.request`. The path
// resolves under the definition's base URL (a literal, or a text configuration field) and never leaves it; auth comes
// from the instance's sealed `credential` fields (bearer, header, basic) or, for a definition declaring `oauth`, its
// OAuth `token` (refreshed before expiry with that client and written back through the instance's credentials; only a
// refused grant deletes it, and only while no concurrent refresh stored a newer one), and the call goes through
// the native public network guard (HTTPS, pinned DNS, private ranges refused) unless the host binds its own fetch.
// Credentials never reach the guest; a path that leaves the base is refused before any credential is read.
import { Clock, Effect, Option, Predicate, Result, Schema } from 'effect';
import { Port, type PortFailure } from '../port.ts';
import type { EngineError } from '../errors.ts';
import type { IntegrationSpec } from '../../decl/runtime/integration.ts';
import type { Json } from '../../decl/values.ts';
import { Fenced } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { publicRequest } from '../net.ts';

/**
 * `path` under `base`, never outside it: one leading `/` is the base itself; an absolute or `//host` path, `..`/`.`
 * segments (encoded too), a `\\`, a query or fragment, or an encoded `/`, `\\` or `%` in a segment is refused. The
 * query (a page cursor included) goes through `searchParams`, so pagination stays inside the prefix.
 */
export function target(base: string, path: string): URL {
	const root = new URL(base.endsWith('/') ? base : `${base}/`);
	const rel = path.startsWith('/') ? path.slice(1) : path;
	const refuse = () =>
		BoltError.make(
			'invalidInput',
			'facility',
			`the path '${path}' leaves the integration's base URL`
		);
	if (rel.startsWith('/') || /[\\?#\s\x00-\x1f]/.test(rel)) throw refuse();
	for (const part of rel === '' ? [] : rel.split('/')) {
		const decoded = Result.try({ try: () => decodeURIComponent(part), catch: refuse });
		if (Result.isFailure(decoded)) throw decoded.failure;
		const d = decoded.success;
		if (d === '.' || d === '..' || /[\\/%\x00-\x1f]/.test(d)) throw refuse();
	}
	const url = new URL(rel, root);
	if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw refuse();
	return url;
}

const Token = Schema.Struct({
	access: Schema.String,
	refresh: Schema.optionalKey(Schema.String),
	exp: Schema.Number
});
const TokenResponse = Schema.Struct({
	access_token: Schema.optionalKey(Schema.String),
	refresh_token: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Number),
	error: Schema.optionalKey(Schema.String)
});
const SKEW_MS = 60_000;
const REVOKED = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
const fenced = (error: EngineError | PortFailure) =>
	error._tag === 'Fenced' || (error._tag === 'BoltError' && error.code === 'fenced');
const decodeFence = Schema.decodeUnknownOption(Fenced);
const requestFailure = (error: unknown): PortFailure | Fenced => {
	const fence = decodeFence(error);
	return Option.isSome(fence) ? fence.value : Port.failure('request')(error);
};
const requestResponse = (
	fetcher: typeof fetch | undefined,
	input: Parameters<typeof fetch>[0],
	init: RequestInit
) =>
	fetcher === undefined
		? publicRequest(input, init).pipe(Effect.mapError(requestFailure))
		: Effect.tryPromise({
				try: (signal) => fetcher(input, { ...init, signal }),
				catch: requestFailure
			});
export type HttpInstance = {
	readonly configuration: Json;
	readonly credentials: ReadonlyMap<string, Json>;
	readonly write?:
		| ((
				changes: ReadonlyMap<string, Json | null>
		  ) => Effect.Effect<void, EngineError | PortFailure>)
		| undefined;
};
export type HttpOptions = {
	readonly fetch?: typeof fetch | undefined;
	readonly secrets?: Readonly<Record<string, string>> | undefined;
};
export const httpOAuth = (
	def: IntegrationSpec
):
	| { client: string; secret: string; authorize: string; token: string; scopes?: readonly string[] }
	| undefined => {
	const oauth = def.driver === 'http' ? def.oauth : undefined;
	return oauth?.authorize === undefined || oauth.token === undefined
		? undefined
		: { ...oauth, authorize: oauth.authorize, token: oauth.token };
};
const invalid = (message: string) => BoltError.make('invalidInput', 'facility', message);
const unavailable = (message: string) => BoltError.make('unavailable', 'facility', message);
export const httpRequest = (
	def: IntegrationSpec,
	instance: HttpInstance,
	op: Json,
	options: HttpOptions = {}
) =>
	Effect.gen(function* () {
		const spec = def.http;
		if (def.driver !== 'http' || spec === undefined)
			return yield* Effect.fail(
				BoltError.make('unsupported', 'facility', 'this definition makes no http request')
			);
		if (
			!Predicate.isObject(op) ||
			typeof op['method'] !== 'string' ||
			typeof op['path'] !== 'string'
		)
			return yield* Effect.fail(invalid('an http request is { method, path, … }'));
		const base = spec.baseUrl.startsWith('https://')
			? spec.baseUrl
			: Predicate.isObject(instance.configuration)
				? instance.configuration[spec.baseUrl]
				: undefined;
		if (typeof base !== 'string' || base === '')
			return yield* Effect.fail(unavailable('the instance has no base URL configured'));
		const path = op['path'],
			method = op['method'];
		const url = yield* Effect.try({
			try: () => target(base, path),
			catch: (error) => (error instanceof BoltError ? error : invalid('the request URL is invalid'))
		});
		for (const [key, value] of Object.entries(Predicate.isObject(op['query']) ? op['query'] : {}))
			url.searchParams.set(key, String(value));
		const headers: Record<string, string> = {
			accept: 'application/json',
			...(op['body'] === undefined ? {} : { 'content-type': 'application/json' }),
			...Object.fromEntries(
				Object.entries(Predicate.isObject(op['headers']) ? op['headers'] : {}).map(
					([key, value]) => [key.toLowerCase(), String(value)]
				)
			)
		};
		const credential = instance.credentials.get('credential');
		const field = (name: string) =>
			Effect.suspend(() => {
				const value = Predicate.isObject(credential) ? credential[name] : undefined;
				return typeof value !== 'string' || value === ''
					? Effect.fail(unavailable('the instance is not paired: its credential is missing'))
					: Effect.succeed(value);
			});
		const auth = spec.auth,
			oauth = httpOAuth(def);
		if (oauth !== undefined)
			headers['authorization'] = `Bearer ${yield* token(oauth, instance, options)}`;
		else if (auth !== undefined && 'bearer' in auth)
			headers['authorization'] = `Bearer ${yield* field(auth.bearer)}`;
		else if (auth !== undefined && 'basic' in auth)
			headers['authorization'] =
				`Basic ${Buffer.from(`${yield* field(auth.basic.user)}:${yield* field(auth.basic.password)}`).toString('base64')}`;
		else if (auth !== undefined && 'header' in auth)
			headers[auth.header.name.toLowerCase()] = yield* field(auth.header.value);
		const response = yield* requestResponse(options.fetch, url, {
			method,
			headers,
			...(op['body'] === undefined ? {} : { body: JSON.stringify(op['body']) })
		});
		const text = yield* Port.attempt('request', () => response.text());
		const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text);
		return { status: response.status, body: Option.isSome(json) ? json.value : text };
	});
const token = (
	client: { client: string; secret: string; token: string },
	instance: HttpInstance,
	options: HttpOptions
) =>
	Effect.gen(function* () {
		const stored = yield* Schema.decodeUnknownEffect(Token)(instance.credentials.get('token')).pipe(
			Effect.mapError(() => unavailable('the instance is not paired: it holds no token'))
		);
		const now = yield* Clock.currentTimeMillis;
		if (stored.exp - SKEW_MS > now) return stored.access;
		if (stored.refresh === undefined)
			return yield* Effect.fail(unavailable('the token expired; pair the instance again'));
		const refresh = stored.refresh;
		const secret = (name: string) =>
			Effect.suspend(() => {
				const value = options.secrets?.[name];
				return value === undefined || value === ''
					? Effect.fail(unavailable(`${name} is not set`))
					: Effect.succeed(value);
			});
		const clientId = yield* secret(client.client),
			clientSecret = yield* secret(client.secret);
		const response = yield* requestResponse(options.fetch, client.token, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refresh,
				client_id: clientId,
				client_secret: clientSecret
			})
		});
		const text = yield* Port.attempt('request', () => response.text());
		const raw = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))(text);
		const answer = Option.isSome(raw) ? raw.value : {};
		if (!response.ok || answer.access_token === undefined) {
			if (
				(response.status !== 400 && response.status !== 401) ||
				answer.error === undefined ||
				!REVOKED.has(answer.error)
			)
				return yield* Effect.fail(
					BoltError.make(
						response.status === 429 ? 'rateLimited' : 'upstream',
						'facility',
						`the token endpoint answered ${response.status}`
					)
				);
			if (instance.write !== undefined)
				yield* instance
					.write(new Map([['token', null]]))
					.pipe(
						Effect.catch((error) =>
							fenced(error)
								? Effect.fail(
										BoltError.make(
											'upstream',
											'facility',
											'the token was refreshed by another request meanwhile; try again'
										)
									)
								: Effect.fail(error)
						)
					);
			return yield* Effect.fail(
				unavailable(
					`the token endpoint refused the grant (${answer.error}); pair the instance again`
				)
			);
		}
		const next = {
			access: answer.access_token,
			refresh: answer.refresh_token ?? stored.refresh,
			exp: now + (answer.expires_in ?? 3600) * 1000
		};
		if (instance.write !== undefined)
			yield* instance
				.write(new Map([['token', next]]))
				.pipe(Effect.catch((error) => (fenced(error) ? Effect.void : Effect.fail(error))));
		return next.access;
	});
